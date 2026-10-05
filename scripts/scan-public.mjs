#!/usr/bin/env node
/**
 * 仓库公开前扫描
 *
 * 私有仓库变成公开是**不可逆**的：
 *   · 所有历史提交都可被搜索（哪怕后来删了，历史里还在）
 *   · 搜索引擎与爬虫会抓取
 *   · 密钥一旦泄漏就必须**轮换**，删文件没用
 *
 * 所以公开前必须扫一遍。这个脚本按三类检查：
 *   1. 凭据 —— 密钥、令牌、密码、私钥
 *   2. 个人信息 —— 真实邮箱、手机号、服务器 IP、私有域名
 *   3. 意外内容 —— 大文件、日志、备份、数据库导出
 *
 * 用法：
 *   node scripts/scan-public.mjs <仓库目录> [--domains a.com,b.com]
 *   node scripts/scan-public.mjs . --git-history     含历史提交
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = process.argv[2] || '.';
const withHistory = process.argv.includes('--git-history');
const domainArg = process.argv.indexOf('--domains');
const privateDomains = domainArg > 0 ? (process.argv[domainArg + 1] || '').split(',').filter(Boolean) : [];

const findings = [];
function add(level, cat, file, line, msg, sample) {
  findings.push({ level, cat, file, line, msg, sample });
}

// ═══════════════════════════════════════════════
// 规则
// ═══════════════════════════════════════════════

/** 凭据类 —— 命中即阻断 */
const CREDENTIALS = [
  { name: '私钥文件', re: /-----BEGIN (RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----/ },
  { name: 'Cloudflare Token', re: /\b[A-Za-z0-9_-]{40}\b(?=[^\n]*[Tt]oken)/, skip: /example|xxx|placeholder|your[-_]|test|dummy/i },
  { name: 'Cloudflare Global Key', re: /\b[a-f0-9]{37}\b/, skip: /example|xxx/i },
  { name: 'OpenAI Key', re: /\bsk-[A-Za-z0-9_-]{20,}/, skip: /example|xxx|your/i },
  { name: 'AWS Access Key', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'AWS Secret', re: /aws.{0,20}secret.{0,20}['"][A-Za-z0-9/+=]{40}['"]/i },
  { name: 'GitHub Token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: 'Google API Key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Stripe Key', re: /\b(sk|pk)_(live|test)_[0-9a-zA-Z]{24,}/ },
  { name: 'Resend Key', re: /\bre_[A-Za-z0-9_]{20,}/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'Slack Token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/ },
  { name: 'npm Token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: '数据库连接串', re: /(postgres|mysql|mongodb|redis):\/\/[^\s'"]*:[^\s'"]*@/i },
  { name: '硬编码密码', re: /(password|passwd|pwd|secret|api[_-]?key|access[_-]?key)\s*[:=]\s*['"][^'"\s]{8,}['"]/i, skip: /example|placeholder|your[-_]|xxx|change[_-]?me|test|dummy|\$\{|process\.env/i },
];

/** 个人信息 —— 需人工确认 */
const PERSONAL = [
  { name: '真实邮箱', re: /\b[A-Za-z0-9._%+-]+@(?!example\.|test\.|invalid\.|localhost)[A-Za-z0-9.-]+\.(?:com|net|org|cn|io|dev|me|xyz)\b/, skip: /noreply|@github\.com|git@|users\.noreply|example|your-|placeholder|author|maintainer@/i },
  { name: '中国手机号', re: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  { name: '公网 IP', re: /\b(?!127\.|0\.|255\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|1\.1\.1\.1|8\.8\.8\.8)(?:\d{1,3}\.){3}\d{1,3}\b/, skip: /0\.0\.0\.0|示例|example/i },
];

/** 意外内容 */
const UNWANTED_FILES = [
  { re: /\.env(\.|$)/, name: '.env 文件' },
  { re: /\.(pem|key|p12|pfx|jks|keystore)$/i, name: '证书/密钥文件' },
  { re: /\.(sql|dump|bak|backup)$/i, name: '数据库导出/备份' },
  { re: /\.(log)$/i, name: '日志文件' },
  { re: /(^|\/)(id_rsa|id_ed25519|authorized_keys|known_hosts)$/, name: 'SSH 密钥' },
  { re: /(^|\/)\.(npmrc|pypirc|netrc|git-credentials)$/, name: '凭据配置' },
  { re: /credential|secret|token/i, name: '疑似凭据文件' },
];

// ═══════════════════════════════════════════════
// 扫描
// ═══════════════════════════════════════════════

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.astro', 'coverage']);

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

console.log(`\n扫描目录：${path.resolve(dir)}`);
console.log(withHistory ? '模式：含 git 历史\n' : '模式：仅当前文件\n');

const files = walk(dir);
console.log(`文件数：${files.length}\n`);

// ── 文件名检查 ──
for (const f of files) {
  const rel = path.relative(dir, f).replace(/\\/g, '/');
  for (const rule of UNWANTED_FILES) {
    if (rule.re.test(rel)) {
      // 排除模板文件
      if (/\.(example|sample|template)$/i.test(rel)) continue;
      add('error', '意外文件', rel, 0, rule.name, '');
    }
  }

  // 大文件（>5MB）
  try {
    const size = fs.statSync(f).size;
    if (size > 5 * 1024 * 1024) {
      add('warn', '大文件', rel, 0, `${(size / 1024 / 1024).toFixed(1)} MB`, 'GitHub 单文件上限 100MB');
    }
  } catch {
    /* 忽略 */
  }
}

// ── 内容检查 ──
const TEXT_EXT = /\.(mjs|js|cjs|ts|tsx|jsx|json|jsonc|md|markdown|txt|yml|yaml|toml|ini|cfg|conf|env|sh|bash|ps1|bat|cmd|sql|html|css|scss|svelte|vue|astro|py|go|rs|java|rb|php|xml|hbs|hbs|njk|ejs|example|sample|template)$/i;

for (const f of files) {
  const rel = path.relative(dir, f).replace(/\\/g, '/');

  // 跳过二进制
  if (!TEXT_EXT.test(rel) && !/^\.(gitattributes|gitignore|npmrc|env\.example)$/.test(path.basename(rel))) {
    continue;
  }

  let content;
  try {
    const buf = fs.readFileSync(f);
    if (buf.includes(0)) continue; // 含 NUL，是二进制
    if (buf.length > 3 * 1024 * 1024) continue; // 太大
    content = buf.toString('utf8');
  } catch {
    continue;
  }

  const lines = content.split(/\r?\n/);

  for (const rule of CREDENTIALS) {
    lines.forEach((line, i) => {
      if (rule.skip?.test(line)) return;
      if (rule.re.test(line)) {
        const m = line.match(rule.re);
        const s = m ? m[0] : line.trim();
        add('error', '凭据', rel, i + 1, rule.name, s.slice(0, 60) + (s.length > 60 ? '…' : ''));
      }
    });
  }

  for (const rule of PERSONAL) {
    lines.forEach((line, i) => {
      if (rule.skip?.test(line)) return;
      if (rule.re.test(line)) {
        const m = line.match(rule.re);
        const s = m ? m[0] : line.trim();
        add('warn', '个人信息', rel, i + 1, rule.name, s.slice(0, 60));
      }
    });
  }

  // 用户指定的私有域名
  for (const d of privateDomains) {
    const re = new RegExp(`\\b[a-z0-9-]*\\.?${d.replace(/\./g, '\\.')}\\b`, 'i');
    lines.forEach((line, i) => {
      if (re.test(line)) {
        // 排除说明性文字
        if (/example|placeholder|your[-_]/i.test(line)) return;
        add('warn', '私有域名', rel, i + 1, `包含 ${d}`, line.trim().slice(0, 70));
      }
    });
  }
}

// ── git 历史检查 ──
if (withHistory) {
  console.log('检查 git 历史中的敏感文件名 ...\n');
  try {
    const allFiles = execFileSync('git', ['log', '--all', '--pretty=format:', '--name-only'], {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    });
    const unique = [...new Set(allFiles.split('\n').filter(Boolean))];
    const historyHits = unique.filter((f) => UNWANTED_FILES.some((r) => r.re.test(f)));

    if (historyHits.length) {
      for (const f of historyHits.slice(0, 30)) {
        add('error', '历史遗留', f, 0, '该文件曾在历史提交中出现（删除文件≠从历史移除）', '');
      }
      if (historyHits.length > 30) {
        add('error', '历史遗留', '...', 0, `另有 ${historyHits.length - 30} 个`, '');
      }
    }

    // 提交者邮箱
    const emails = execFileSync('git', ['log', '--all', '--format=%ae%n%ce'], {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    const uniqueEmails = [...new Set(emails.split('\n').filter(Boolean))];
    for (const e of uniqueEmails) {
      add('warn', '提交元数据', '(git log)', 0, '作者邮箱（GitHub 上永远公开）', e);
    }
  } catch (e) {
    console.log(`  git 历史检查跳过：${e.message.slice(0, 80)}\n`);
  }
}

// ═══════════════════════════════════════════════
// 报告
// ═══════════════════════════════════════════════

console.log('═'.repeat(70));
console.log('扫描结果');
console.log('═'.repeat(70));

const errors = findings.filter((f) => f.level === 'error');
const warns = findings.filter((f) => f.level === 'warn');

if (errors.length) {
  console.log(`\n\x1b[31m\x1b[1m必须处理（${errors.length}）\x1b[0m\n`);
  const byCat = {};
  for (const e of errors) (byCat[e.cat] = byCat[e.cat] || []).push(e);

  for (const [cat, items] of Object.entries(byCat)) {
    console.log(`\x1b[31m▸ ${cat}\x1b[0m`);
    for (const i of items) {
      console.log(`  ${i.file}${i.line ? ':' + i.line : ''}`);
      console.log(`    ${i.msg}${i.sample ? '  →  ' + i.sample : ''}`);
    }
    console.log('');
  }
}

if (warns.length) {
  console.log(`\n\x1b[33m\x1b[1m需要确认（${warns.length}）\x1b[0m\n`);
  const byCat = {};
  for (const w of warns) (byCat[w.cat] = byCat[w.cat] || []).push(w);

  for (const [cat, items] of Object.entries(byCat)) {
    console.log(`\x1b[33m▸ ${cat}\x1b[0m`);
    // 同类去重，只显示前 15 条
    const seen = new Set();
    let shown = 0;
    for (const i of items) {
      const key = `${i.file}:${i.msg}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (shown++ >= 15) break;
      console.log(`  ${i.file}${i.line ? ':' + i.line : ''}`);
      console.log(`    ${i.msg}${i.sample ? '  →  ' + i.sample : ''}`);
    }
    if (items.length > 15) console.log(`  … 共 ${items.length} 条`);
    console.log('');
  }
}

if (!errors.length && !warns.length) {
  console.log('\n\x1b[32m✔ 未发现敏感信息\x1b[0m');
}

console.log('─'.repeat(70));
console.log(`必须处理 ${errors.length} / 需要确认 ${warns.length}`);
console.log('');

process.exit(errors.length ? 1 : 0);
