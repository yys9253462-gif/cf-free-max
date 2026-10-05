#!/usr/bin/env node
/**
 * 清理 fuwari 仓库中的个人信息，为公开做准备
 *
 * 处理四类内容：
 *   1. 邮箱           → 占位符
 *   2. 私有域名       → 占位符
 *   3. Cloudflare 资源 ID（Zone ID / Account ID）→ 删除
 *   4. git 历史的作者邮箱 → 改写成 GitHub noreply
 *
 * ⚠️ git 历史改写会**重写所有 commit hash**，必须强制推送。
 *    这是不可逆操作 —— 改写前会先做完整备份。
 *
 * 用法：
 *   node scripts/scrub-repo.mjs <仓库目录> [--dry-run] [--rewrite-history]
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoDir = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
const rewriteHistory = process.argv.includes('--rewrite-history');

if (!repoDir || !fs.existsSync(repoDir)) {
  console.error('用法：node scripts/scrub-repo.mjs <仓库目录> [--dry-run] [--rewrite-history]');
  process.exit(2);
}

// ─── 替换规则 ───
const RULES = [
  // 邮箱
  { from: /yys9253462@gmail\.com/g, to: 'you@example.com', desc: '邮箱' },

  // 私有域名
  { from: /blog\.u88b\.com/g, to: 'blog.example.com', desc: '博客域名' },
  { from: /\bu88b\.com\b/g, to: 'example.com', desc: '根域名' },

  // Cloudflare 资源 ID（这些能定位到具体资源，比域名更敏感）
  { from: /`e728495591f765736721706f220a749a`/g, to: '`<ZONE_ID>`', desc: 'Zone ID' },
  { from: /`c21081d20d9d782cf3ce39dddc17645b`/g, to: '`<ACCOUNT_ID>`', desc: 'Account ID' },
  { from: /\be728495591f765736721706f220a749a\b/g, to: '<ZONE_ID>', desc: 'Zone ID（裸值）' },
  { from: /\bc21081d20d9d782cf3ce39dddc17645b\b/g, to: '<ACCOUNT_ID>', desc: 'Account ID（裸值）' },
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.astro', 'coverage']);
const TEXT_EXT = /\.(mjs|js|cjs|ts|tsx|jsx|json|jsonc|md|markdown|txt|yml|yaml|toml|ini|cfg|conf|env|sh|bash|ps1|bat|cmd|sql|html|css|scss|svelte|vue|astro|xml|hbs|njk|ejs)$/i;

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// ═══════════════════════════════════════════════
console.log(`\n清理仓库：${path.resolve(repoDir)}`);
if (dryRun) console.log('\x1b[33m预演模式（不写入）\x1b[0m');
console.log('');

// ─── 1. 文件内容清理 ───
const files = walk(repoDir);
let changedFiles = 0;
const allChanges = [];

for (const f of files) {
  const rel = path.relative(repoDir, f).replace(/\\/g, '/');
  if (!TEXT_EXT.test(rel)) continue;

  let content;
  try {
    const buf = fs.readFileSync(f);
    if (buf.includes(0)) continue;
    content = buf.toString('utf8');
  } catch {
    continue;
  }

  let modified = content;
  const fileChanges = [];

  for (const rule of RULES) {
    const matches = modified.match(rule.from);
    if (matches) {
      fileChanges.push({ desc: rule.desc, count: matches.length });
      modified = modified.replace(rule.from, rule.to);
    }
  }

  if (modified !== content) {
    changedFiles++;
    allChanges.push({ rel, changes: fileChanges });
    if (!dryRun) {
      fs.writeFileSync(f, modified, 'utf8');
    }
  }
}

console.log(`\x1b[1m文件内容\x1b[0m`);
if (allChanges.length === 0) {
  console.log('  无需修改');
} else {
  for (const { rel, changes } of allChanges) {
    console.log(`  ${rel}`);
    for (const c of changes) {
      console.log(`    · ${c.desc} × ${c.count}`);
    }
  }
  console.log('');
  console.log(`  共 ${changedFiles} 个文件${dryRun ? '（未写入）' : '已清理'}`);
}

// ─── 2. git 历史作者邮箱 ───
console.log('');
console.log(`\x1b[1mgit 历史\x1b[0m`);

let emails = [];
try {
  const out = execFileSync('git', ['log', '--all', '--format=%ae|%ce'], {
    cwd: repoDir,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  emails = [...new Set(out.split('\n').filter(Boolean).flatMap((l) => l.split('|')))];
} catch (e) {
  console.log(`  读取失败：${e.message.slice(0, 80)}`);
}

console.log(`  当前作者邮箱：${emails.join(', ') || '(无)'}`);

const badEmails = emails.filter((e) => !e.endsWith('@users.noreply.github.com'));

if (badEmails.length === 0) {
  console.log('  \x1b[32m✔ 无需处理\x1b[0m');
} else if (!rewriteHistory) {
  console.log('');
  console.log(`  \x1b[33m${badEmails.length} 个邮箱需要在历史中改写\x1b[0m`);
  console.log('  加 --rewrite-history 参数执行（会重写所有 commit hash）');
} else if (dryRun) {
  console.log('');
  console.log(`  将改写 ${badEmails.length} 个邮箱为 noreply 地址（预演，未执行）`);
} else {
  console.log('');
  console.log(`  正在改写 ${badEmails.length} 个邮箱 ...`);

  // 用 git filter-branch 改写（不需要额外依赖）
  const noreply = 'yys9253462-gif@users.noreply.github.com';
  const envFilter = badEmails
    .map((e) => `if [ "$GIT_AUTHOR_EMAIL" = "${e}" ]; then export GIT_AUTHOR_EMAIL="${noreply}"; fi; if [ "$GIT_COMMITTER_EMAIL" = "${e}" ]; then export GIT_COMMITTER_EMAIL="${noreply}"; fi;`)
    .join(' ');

  try {
    execFileSync(
      'git',
      [
        'filter-branch',
        '-f',
        '--env-filter',
        envFilter,
        '--tag-name-filter',
        'cat',
        '--',
        '--all',
      ],
      { cwd: repoDir, stdio: 'pipe', timeout: 300000 },
    );

    // 清理 filter-branch 的备份引用
    execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/original/'], {
      cwd: repoDir,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .forEach((ref) => {
        try {
          execFileSync('git', ['update-ref', '-d', ref], { cwd: repoDir });
        } catch {
          /* 忽略 */
        }
      });

    execFileSync('git', ['reflog', 'expire', '--expire=now', '--all'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['gc', '--prune=now', '--aggressive'], { cwd: repoDir, stdio: 'pipe', timeout: 300000 });

    console.log('  \x1b[32m✔ 历史已改写\x1b[0m');
  } catch (e) {
    console.log(`  \x1b[31m✘ 改写失败：${String(e.stderr ?? e.message).slice(0, 300)}\x1b[0m`);
  }
}

// ─── 3. 复核 ───
console.log('');
console.log(`\x1b[1m复核\x1b[0m`);

const recheck = walk(repoDir);
let remaining = 0;
for (const f of recheck) {
  const rel = path.relative(repoDir, f).replace(/\\/g, '/');
  if (!TEXT_EXT.test(rel)) continue;
  try {
    const buf = fs.readFileSync(f);
    if (buf.includes(0)) continue;
    const content = buf.toString('utf8');
    if (/u88b\.com|yys9253462@gmail\.com|e728495591f765736721706f220a749a|c21081d20d9d782cf3ce39dddc17645b/.test(content)) {
      console.log(`  \x1b[31m✘ ${rel} 仍有残留\x1b[0m`);
      remaining++;
    }
  } catch {
    /* 忽略 */
  }
}

if (remaining === 0) {
  console.log('  \x1b[32m✔ 文件内容已清理干净\x1b[0m');
} else {
  console.log(`  \x1b[31m✘ ${remaining} 个文件仍有残留\x1b[0m`);
}

console.log('');
if (dryRun) {
  console.log('\x1b[33m这是预演，未做任何修改。去掉 --dry-run 才真正执行。\x1b[0m');
  console.log('');
}
