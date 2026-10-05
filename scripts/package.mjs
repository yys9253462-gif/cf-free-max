#!/usr/bin/env node
/**
 * 打包分发脚本
 *
 * 生成一个别人下载解压就能用的 zip：
 *   - 双击「启动.bat」→ 需要 Node（没有会自动下载便携版）
 *   - 双击「快查.bat」→ 零依赖，Windows 自带工具即可
 *   - 完整源码与文档
 *   - **不含凭据**（打前会审计）
 *
 * 用法：
 *   node scripts/package.mjs
 *   node scripts/package.mjs --skip-audit    跳过分享前审计（不推荐）
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const SKIP_AUDIT = process.argv.includes('--skip-audit');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const NAME = `${pkg.name}-v${VERSION}-win`;

// ═══════════════════════════════════════════════════════════
// 要打包的内容
// ═══════════════════════════════════════════════════════════
const INCLUDE = [
  'bin',
  'src',
  'docs',
  'scripts',
  'test',
  'README.md',
  'LICENSE',
  'package.json',
  '.env.example',
  '启动.bat',
  '快查.bat',
  '检测授权.bat',
  '使用说明.txt',
];

/**
 * 打包时替换的文件 —— 源文件不进包，只放「脱敏后的模板」。
 *
 * 为什么 config/sites.json 要这样处理：
 *   它包含用户的真实仓库名、Pages 项目名、自定义域名、D1 database_id。
 *   这些是**部署配置**而非代码 —— 打包分享等于公开自己的站点架构。
 *
 *   所以包里放 sites.example.json 的内容，文件名仍叫 sites.json，
 *   用户拿到后按提示改成自己的值。既不泄漏，又不影响开箱可用性。
 */
const REPLACE_FILES = [
  // 分享包里放的是「分享版配置」：
  //   · 保留了项目结构（仓库名、构建方式、需要的绑定）
  //   · 清掉了作者专属信息（GitHub 用户名、域名、资源 ID）
  //   · protected 标记也去掉 —— 别人要能部署自己的一套
  // 用户首次运行时，init 向导会自动补齐空的字段。
  { src: path.join('config', 'sites.share.json'), dest: path.join('config', 'sites.json') },
];

/** 绝不打包的东西（即使误加进 INCLUDE 也会被拦下） */
const FORBIDDEN = [
  '.env',
  '.git',
  'node_modules',
  'dist',
  'dns-export',
  '.env.local',
  'credentials',
  'sites.json', // 真实部署配置（含域名/D1 id），包里只放 sites.example.json
  '.sites', // clone 下来的仓库
  '.wrangler', // wrangler 本地状态
];

// ═══════════════════════════════════════════════════════════
// 分享前审计
// ═══════════════════════════════════════════════════════════

/**
 * 扫描凭据与个人信息。
 *
 * 这一步是**必须的**：源码里可能残留测试时的真实 Token、
 * 日志里可能带真实 IP、注释里可能写了自己的域名。
 * 分享出去就收不回来了。
 */
function audit() {
  console.log('\n\x1b[1m分享前审计\x1b[0m\n');

  let problems = 0;
  let warnings = 0;

  /** 危险模式：命中即阻断 */
  const BLOCKING = [
    { name: 'Cloudflare API Token', re: /\b[A-Za-z0-9_-]{40}\b(?=[^\n]*[Tt]oken)/, skip: /placeholder|xxx|你的|示例|example|test_|invalid/i },
    { name: 'Cloudflare Global Key', re: /\b[a-f0-9]{37}\b/, skip: /placeholder|xxx|示例/i },
    { name: 'OpenAI 风格密钥', re: /\bsk-[A-Za-z0-9]{20,}/, skip: /placeholder|xxx|示例/i },
    { name: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{16}\b/, skip: /placeholder|xxx/i },
    { name: 'GitHub Token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/, skip: /placeholder|xxx/i },
    { name: '私钥文件', re: /-----BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/, skip: /never|不要|示例/i },
    {
      name: '真实邮箱',
      // 排除项说明（都是实测踩过的误报）：
      //   · example/test/invalid/localhost —— 文档示例
      //   · git@github.com —— 标准 SSH 写法，不是个人信息
      //   · noreply/api/smtp —— 技术性地址
      re: /\b[A-Za-z0-9._%+-]+@(?!example\.|test\.|invalid\.|localhost)[A-Za-z0-9.-]+\.(?:com|net|org|cn|io|dev)\b/,
      skip: /noreply|example|@test\.|git@|@github\.com|users\.noreply|your-|placeholder|@host\b|api\.|smtp\./i,
    },
    { name: '中国手机号', re: /\b1[3-9]\d{9}\b/, skip: /placeholder|示例/ },
    // 真实域名：分享出去等于公开自己的站点架构。
    // 域名清单从环境变量读，**不硬编码在源码里** ——
    // 否则「防泄漏的规则本身」就成了泄漏源（实测踩过）。
    ...(process.env.CFM_PRIVATE_DOMAINS
      ? [
          {
            name: '真实站点域名',
            re: new RegExp(
              String.raw`\b(?:[a-z0-9-]+\.)?(?:${process.env.CFM_PRIVATE_DOMAINS.split(',').map((d) => d.trim().replace(/\./g, '\\.')).join('|')})\b`,
              'i',
            ),
            skip: /example|your-|placeholder/i,
          },
        ]
      : []),
    // D1 database_id 是 uuid，泄漏了别人能直接定位到你的库
    { name: 'D1 database_id', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, skip: /00000000-0000|example/i },
  ];

  /** 可疑但不阻断（需人工确认） */
  const SUSPICIOUS = [
    { name: '硬编码公网 IP', re: /\b(?!(?:127\.0\.0\.1|0\.0\.0\.0|255\.255\.255\.255|1\.1\.1\.1|8\.8\.8\.8|192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.))(?:\d{1,3}\.){3}\d{1,3}\b/ },
    { name: '疑似私人域名', re: /\b[a-z0-9-]+\.(?:com|net|cn|io|dev|xyz|top)\b/ },
    { name: 'Windows 用户路径', re: /C:\\Users\\[A-Za-z0-9_-]+/ },
  ];

  /**
   * 已知安全的白名单 —— 这些出现在代码里是正常的，不该报。
   *
   * 不加白名单的话，「疑似私人域名」这条会命中所有 Cloudflare 官方域名，
   * 淹没真正需要注意的内容（实测：51 条警告里 50 条是 api.cloudflare.com）。
   */
  const ALLOWLIST = [
    /api\.cloudflare\.com/,
    /dash\.cloudflare\.com/,
    /cloudflare\.com/,
    /cloudflarestorage\.com/,
    /cloudflare\.org/,
    /workers\.dev/,
    /pages\.dev/,
    /r2\.dev/,
    /cfargotunnel\.com/,
    /nodejs\.org/,
    /npmmirror\.com/,
    // 项目自身地址 —— 用户**明确确认**可以公开（方便别人找更新）。
    // 这不是漏检，是已确认的例外。
    /github\.com\/yys9253462-gif\/cf-free-max/,
    /\byys9253462-gif\b/, // GitHub 用户名，同上
    /github\.com\/cloudflare/,
    /resend\.com/,
    /1\.2\.3\.4/, // 文档里的示例 IP
    /192\.0\.2\./, // RFC5737 文档专用段
    /example\.com/,
    /your-domain/,
    /Program Files/, // 标准安装路径，不含个人信息
    /C:\\Windows/,
  ];

  const isAllowlisted = (line) => ALLOWLIST.some((re) => re.test(line));

  const files = [];
  const collect = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'dist'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) collect(p);
      else if (/\.(mjs|js|json|md|txt|bat|ps1|sh|yml|yaml|example)$/i.test(e.name) || e.name.startsWith('.')) {
        files.push(p);
      }
    }
  };
  for (const item of INCLUDE) {
    const p = path.join(ROOT, item);
    if (!fs.existsSync(p)) continue;
    if (fs.statSync(p).isDirectory()) collect(p);
    else files.push(p);
  }

  const report = [];

  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');

    for (const rule of BLOCKING) {
      lines.forEach((line, i) => {
        if (rule.skip?.test(line)) return;
        if (rule.re.test(line)) {
          // 排除「规则定义自身」和明确的文档说明
          if (/BLOCKING|SUSPICIOUS|name:.*'(?:.*)'/.test(line) && /re:/.test(line)) return;
          report.push({ level: 'block', file: rel, line: i + 1, rule: rule.name, sample: line.trim().slice(0, 70) });
        }
      });
    }

    for (const rule of SUSPICIOUS) {
      lines.forEach((line, i) => {
        if (rule.re.test(line)) {
          // 文档/规则里的示例不算
          if (/SUSPICIOUS|re:|ALLOWLIST/.test(line)) return;
          if (isAllowlisted(line)) return;
          report.push({ level: 'warn', file: rel, line: i + 1, rule: rule.name, sample: line.trim().slice(0, 70) });
        }
      });
    }
  }

  // 检查禁止打包的文件是否存在
  // 注意：.git 不报 —— 它是正常的版本控制目录，打包时会排除，
  // 且它下面确实含作者邮箱（那是 GitHub 公开信息，不是泄漏）。
  // 只检查「不该存在」的文件。
  // sites.json / .sites / .wrangler 是**正常存在**的（源目录里本来就有），
  // 它们只是不进包 —— 由 copyRecursive 的 FORBIDDEN 过滤负责，
  // 不在这里报警，否则每次打包都会误报。
  const MUST_NOT_EXIST = ['.env', '.env.local', 'credentials'];
  for (const f of MUST_NOT_EXIST) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) {
      report.push({
        level: 'block',
        file: f,
        line: 0,
        rule: `源目录存在 ${f}（含真实凭据）`,
        sample: '它不会被 .gitignore 之外的机制保护，确认打包时已排除',
      });
    }
  }

  // 输出
  const blocks = report.filter((r) => r.level === 'block');
  const warns = report.filter((r) => r.level === 'warn');

  if (blocks.length) {
    console.log('\x1b[31m阻断项（必须处理）\x1b[0m');
    for (const r of blocks) {
      console.log(`  ✘ ${r.file}:${r.line}  ${r.rule}`);
      if (r.sample) console.log(`      ${r.sample}`);
    }
    console.log('');
    problems = blocks.length;
  }

  if (warns.length) {
    console.log('\x1b[33m需人工确认\x1b[0m');
    // 疑似域名/IP 会很多，去重后只显示前 20 条
    const seen = new Set();
    let shown = 0;
    for (const r of warns) {
      const key = `${r.file}:${r.rule}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (shown++ >= 20) break;
      console.log(`  ⚠ ${r.file}:${r.line}  ${r.rule}`);
      if (r.sample) console.log(`      ${r.sample}`);
    }
    if (warns.length > 20) console.log(`  … 共 ${warns.length} 条（已折叠重复）`);
    console.log('');
    warnings = warns.length;
  }

  if (!problems && !warnings) {
    console.log('\x1b[32m✔ 未发现凭据或个人信息的泄漏\x1b[0m\n');
  }

  return { blocks: problems, warns: warnings };
}

// ═══════════════════════════════════════════════════════════
// 使用说明（面向拿到 zip 的人）
// ═══════════════════════════════════════════════════════════
const README_TXT = `Cloudflare 免费额度工具箱 v${VERSION}
================================================================

这是什么
--------
Cloudflare 免费层给得很多（Workers 每天 10 万请求、R2 10GB 且出站流量
免费、D1 500 万行/天、Tunnel 不限量……），但额度分散在十来个产品页面，
很难知道自己剩多少、被什么吃掉了。

这个工具就是把这些变成一条命令 / 一个菜单。


怎么用（两种方式）
------------------

方式一：双击 quickcheck.bat
    零依赖，立刻能用。用 Windows 自带的 curl 和 PowerShell。
    能看：额度对照表、实时用量、凭证检查、KV 写入估算。

方式二：双击 launcher.bat
    功能完整（体检、审计、批量操作、彩色交互菜单）。
    需要 Node.js —— 如果没装，会自动下载一个便携版（约 30MB）
    解压到 %LOCALAPPDATA%\\cf-free-max\\node，不会影响系统。

    注意：命令行模式下也可以带参数调用，例如
        launcher.bat whoami
        launcher.bat usage --json


第一次使用
----------
1. 先去 https://dash.cloudflare.com/profile/api-tokens 创建 API Token
   （不要用 Global API Key，权限太大）

2. 需要的权限：
     Account Analytics:Read   查用量
     Zone:Read                列出域名
     DNS:Edit                 改 DNS（可选）
     Zone Settings:Edit       改域名设置（可选）
     Cache Purge:Purge        清缓存（可选）
     Workers R2 Storage:Edit  R2 操作（可选）

   只想看用量的话，前两项就够了。

3. 双击 quickcheck.bat → 选 [7] 配置凭据，粘贴进去即可。
   凭据保存在同目录的 .env 文件里，不会上传到任何地方。


目录结构
--------
  launcher.bat      完整版启动器（自动获取 Node）
  quickcheck.bat    零依赖快速版
  README-FIRST.txt  本文件
  bin\\             程序入口
  src\\             源码
  docs\\            文档（含交互模式说明、省钱指南、常见场景）
  scripts\\         lint、测试、打包脚本
  test\\            测试
  .env.example      凭据模板


常见问题
--------

Q: 会不会产生费用？
A: 不会。工具只调用 Cloudflare 的 API，不做任何付费操作。
   唯一的例外是 R2 存储超过 10GB 会按 $0.015/GB 计费 ——
   但那是你在控制台的行为，工具只会在接近时提醒你。

Q: 需要管理员权限吗？
A: 不需要。便携版 Node 装在 %LOCALAPPDATA%，不需要管理员。

Q: 下载 Node 失败怎么办？
A: 手动下载 https://nodejs.org/dist/v22.11.0/node-v22.11.0-win-x64.zip
   解压后确保 node.exe 在 %LOCALAPPDATA%\\cf-free-max\\node\\node.exe
   然后重新运行「启动.bat」。

Q: 「快查.bat」报错说找不到 curl？
A: 极老的系统才没有。可以直接用「启动.bat」，它走 Node。

Q: 中文显示乱码？
A: 本工具按 GBK 编码写的，中文 Windows 直接双击运行不会乱码。
   如果乱码，检查系统区域设置是否改成了非中文。

Q: 能查别人的账号吗？
A: 不能，也不该。工具用的是你的 Token，只能访问 Token 授权范围内的资源。


卸载
----
删除整个文件夹即可。
如果用过「启动.bat」下载了便携版 Node，
再删掉 %LOCALAPPDATA%\\cf-free-max 目录就彻底干净了。


项目主页
--------
https://github.com/yys9253462-gif/cf-free-max

License: MIT
`;

// ═══════════════════════════════════════════════════════════
// 打包
// ═══════════════════════════════════════════════════════════

function copyRecursive(src, dest, stats) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const e of fs.readdirSync(src)) {
      if (FORBIDDEN.includes(e)) continue;
      copyRecursive(path.join(src, e), path.join(dest, e), stats);
    }
  } else {
    // 二进制安全复制，不做任何文本转换（避免改坏行尾）
    const buf = fs.readFileSync(src);
    fs.writeFileSync(dest, buf);
    stats.files++;
    stats.bytes += buf.length;
    if (/\.(bat|cmd)$/i.test(src)) stats.batFiles.push(path.relative(ROOT, src).replace(/\\/g, '/'));
  }
}

function build() {
  console.log('\x1b[1m打包\x1b[0m\n');

  const outDir = path.join(DIST, NAME);
  if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  // 写入面向用户的说明
  fs.writeFileSync(path.join(ROOT, '使用说明.txt'), README_TXT.replace(/\n/g, '\r\n'), 'utf8');

  const stats = { files: 0, bytes: 0, batFiles: [] };

  for (const item of INCLUDE) {
    const src = path.join(ROOT, item);
    if (!fs.existsSync(src)) {
      console.log(`  \x1b[33m⚠ 跳过（不存在）：${item}\x1b[0m`);
      continue;
    }
    copyRecursive(src, path.join(outDir, item), stats);
    console.log(`  + ${item}`);
  }

  // 处理需要脱敏的文件：源文件不进包，只放模板
  for (const { src: srcRel, dest: destRel } of REPLACE_FILES) {
    const srcPath = path.join(ROOT, srcRel);
    const destPath = path.join(outDir, destRel);

    if (!fs.existsSync(srcPath)) {
      console.log(`  \x1b[33m⚠ 模板不存在：${srcRel}\x1b[0m`);
      continue;
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(srcPath, destPath);
    console.log(`  + ${destRel}  \x1b[2m（来自模板 ${srcRel}）\x1b[0m`);
    stats.files++;
    stats.bytes += fs.statSync(destPath).size;
  }

  // 明确排除真实配置（防止误打包）
  const realConfig = path.join(outDir, 'config', 'sites.json');
  const hasTemplate = fs.existsSync(path.join(ROOT, 'config', 'sites.example.json'));
  if (hasTemplate && fs.existsSync(realConfig)) {
    // 已被模板覆盖，没问题；但要确认内容确实是模板而非真实配置
    const content = fs.readFileSync(realConfig, 'utf8');
    if (!content.includes('这是分享给大家的初始配置')) {
      console.log(`  \x1b[31m✘ config/sites.json 不是模板内容，可能包含真实配置！\x1b[0m`);
      process.exit(1);
    }
  }

  // 校验 .bat 编码与行尾
  console.log('');
  for (const rel of stats.batFiles) {
    const p = path.join(outDir, rel);
    const buf = fs.readFileSync(p);
    const crlf = countCrlf(buf);
    const lfOnly = buf.filter((b) => b === 0x0a).length - crlf;
    const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;

    const issues = [];
    if (crlf === 0) issues.push('没有 CRLF 行尾（批处理需要 CRLF）');
    if (lfOnly > 0) issues.push(`有 ${lfOnly} 个纯 LF 行尾（混用会导致 bat 解析出错）`);
    if (hasBom) issues.push('含 UTF-8 BOM（会在首行开头显示乱码字符）');

    if (issues.length) {
      console.log(`  \x1b[31m✘ ${rel}：${issues.join('；')}\x1b[0m`);
    } else {
      console.log(`  \x1b[32m✔ ${rel}\x1b[0m  CRLF ${crlf} 行，无 BOM，ANSI/GBK 编码`);
    }
  }

  console.log('');
  console.log(`  文件数：${stats.files}`);
  console.log(`  解压后大小：${(stats.bytes / 1024).toFixed(0)} KB`);

  return { outDir, stats };
}

function countCrlf(buf) {
  let n = 0;
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) n++;
  }
  return n;
}

/**
 * 生成 zip。
 *
 * 试过四种方式，最后选了「用 tar.exe + ASCII 文件名」：
 *
 *   ✗ `git archive`            —— Windows 上丢可执行位
 *   ✗ `Compress-Archive`       —— 用系统代码页存文件名，中文名跨机器乱码
 *   ✗ `ZipFile.CreateFromDirectory` 同上
 *   ✗ `ZipFile.Open` + UTF8Encoding  —— 实测仍乱码：PowerShell 5.1 下
 *      即使传了 UTF8Encoding，条目名还是按 ANSI 写入。
 *      实测：`快查.bat` 解压出来变成 `蹇煡.bat`（UTF-8 字节被按 GBK 读）。
 *   ✓ `tar -a -c -f`           —— 用 ASCII 文件名，绕开整个编码问题
 *
 * 关键决策：**压缩包里的文件名用纯 ASCII**。
 *   launcher.bat    完整版启动器
 *   quickcheck.bat  零依赖快查
 *   README-FIRST.txt 使用说明
 *
 * 中文文件名看着亲切，但它是跨平台分发的**头号坑**：
 *   Windows 与 macOS/Linux 的 zip 默认编码不同，用户在资源管理器里
 *   双击前根本不知道哪个文件是哪个。ASCII 名 + 文件内的中文说明
 *   是唯一稳妥的组合。
 */
function zipDir(outDir, zipPath) {
  console.log('\n\x1b[1m压缩\x1b[0m\n');

  // 重命名关键文件为 ASCII（在临时副本上操作，不动源文件）
  const ASCII_NAMES = {
    '启动.bat': 'launcher.bat',
    '快查.bat': 'quickcheck.bat',
    '检测授权.bat': 'setup.bat',
    '使用说明.txt': 'README-FIRST.txt',
  };

  const renamed = [];
  for (const [zh, en] of Object.entries(ASCII_NAMES)) {
    const src = path.join(outDir, zh);
    if (fs.existsSync(src)) {
      const dst = path.join(outDir, en);
      fs.renameSync(src, dst);
      renamed.push({ zh, en });
    }
  }
  for (const { zh, en } of renamed) {
    console.log(`  ${zh}  →  ${en}`);
  }
  console.log('');

  // 更新 README-FIRST.txt 里对文件名的引用
  const readmePath = path.join(outDir, 'README-FIRST.txt');
  if (fs.existsSync(readmePath)) {
    let txt = fs.readFileSync(readmePath, 'utf8');
    txt = txt
      .replace(/启动\.bat/g, 'launcher.bat').replace(/检测授权\.bat/g, 'setup.bat')
      .replace(/快查\.bat/g, 'quickcheck.bat')
      .replace(/使用说明\.txt/g, 'README-FIRST.txt');
    fs.writeFileSync(readmePath, txt, 'utf8');
  }

  // 用 tar 打包（Windows 10 1803+ 自带，或 Linux 的 tar）
  const parent = path.dirname(outDir);
  const base = path.basename(outDir);

  let ok = false;
  const attempts = [
    { cmd: 'tar', args: ['-a', '-c', '-f', zipPath, '-C', parent, base] },
    { cmd: 'tar', args: ['-c', '-f', zipPath, '-C', parent, base] },
  ];

  for (const { cmd, args } of attempts) {
    try {
      execFileSync(cmd, args, { stdio: 'pipe', timeout: 120000 });
      if (fs.existsSync(zipPath) && fs.statSync(zipPath).size > 1000) {
        ok = true;
        break;
      }
    } catch (e) {
      console.log(`  \x1b[33m${cmd} 失败：${String(e.stderr ?? e.message).split('\n')[0].slice(0, 100)}\x1b[0m`);
    }
  }

  // 恢复中文文件名（源目录保持不变，便于本地直接双击）
  for (const { zh, en } of renamed) {
    const src = path.join(outDir, en);
    if (fs.existsSync(src)) fs.renameSync(src, path.join(outDir, zh));
  }

  if (!ok) {
    console.log(`\n  \x1b[31m压缩失败。请手动压缩 dist${path.sep}${NAME} 目录。\x1b[0m`);
    return null;
  }

  const size = fs.statSync(zipPath).size;
  console.log(`  ✔ ${path.relative(ROOT, zipPath)}`);
  console.log(`  压缩包大小：${(size / 1024).toFixed(0)} KB`);
  return zipPath;
}

function sha256(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

// ═══════════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════════

function main() {
  console.log(`\n\x1b[1mcf-free-max v${VERSION} 打包\x1b[0m\n`);

  if (!SKIP_AUDIT) {
    const { blocks } = audit();
    if (blocks > 0) {
      console.log('\x1b[31m发现阻断项，已中止打包。\x1b[0m');
      console.log('处理后再跑一次，或用 --skip-audit 强制打包（不推荐）。\n');
      process.exit(1);
    }
  } else {
    console.log('\x1b[33m⚠ 已跳过审计（--skip-audit）\x1b[0m\n');
  }

  const { outDir, stats } = build();
  const zipPath = path.join(DIST, `${NAME}.zip`);
  const created = zipDir(outDir, zipPath);

  if (created) {
    const hash = sha256(created);
    const hashFile = `${created}.sha256`;
    fs.writeFileSync(hashFile, `${hash}  ${path.basename(created)}\n`, 'utf8');

    console.log('');
    console.log('\x1b[1m完成\x1b[0m');
    console.log(`  压缩包：${path.relative(ROOT, created)}`);
    console.log(`  SHA256：${hash}`);
    console.log('');
    console.log('  分享给别人时，可以一并给出 SHA256 供校验。');
    console.log('');
  }
}

main();
