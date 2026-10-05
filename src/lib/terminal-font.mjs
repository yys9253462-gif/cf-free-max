/**
 * 终端字体检测
 *
 * 解决的问题（用户实测反馈）：
 *   在旧版 Windows PowerShell 窗口（conhost）里打开工具，
 *   满屏都是空心方块 ▯▯▯▯。
 *
 *   一开始以为是编码问题，但方块 ≠ 乱码：
 *     · 乱码（鈥 鍏嶈垂）  → 编码不匹配，字节解错了
 *     · 方块（▯▯▯）        → 编码正确，但**字体没有那个字的字形**
 *
 *   实测根因：旧版 conhost 默认字体是 `Lucida Console`（拉丁字体），
 *   完全没有中文字形。而 Windows Terminal 默认字体带 CJK 回退，
 *   所以在新终端里一切正常 —— 这就是为什么开发时没发现。
 *
 * 处理策略：
 *   检测到「可能画不出中文」时，不强行输出中文，而是：
 *     1. 提示用户改字体（给出具体路径）
 *     2. 或者自动降级为 ASCII 界面
 *
 * 检测手段：
 *   · 读注册表 HKCU:\Console\<程序路径> 的 FaceName
 *   · 已知不含中文字形的字体列表
 */

import { execFileSync } from 'node:child_process';

/**
 * 已知「没有中文字形」的字体。
 *
 * 这些是拉丁字体，用于旧版 conhost 的默认值。
 * 命中任何一个，中文都会显示成方块。
 */
const NO_CJK_FONTS = [
  'lucida console',
  'consolas', // 严格说 Consolas 也没有中文，靠系统回退；conhost 里不会回退
  'courier new',
  'terminal',
  'raster fonts',
  'small fonts',
  'fixedsys',
  'lucida sans typewriter',
  'proggyclean',
];

/**
 * 已知「有中文字形」的字体。
 */
const HAS_CJK_FONTS = [
  '新宋体',
  'nsimsun',
  'simsun',
  '宋体',
  'simhei',
  '黑体',
  'microsoft yahei',
  '微软雅黑',
  '等线',
  'dengxian',
  'cascadia mono', // 当前版本带 CJK 回退
  'cascadia code',
  'ms gothic',
  'msgothic',
  'malgun gothic',
];

/**
 * 读取旧版控制台为指定程序保存的字体设置。
 *
 * 注册表路径：HKCU:\Console\<程序路径转义后的名字>
 * 例如：%SystemRoot%_System32_WindowsPowerShell_v1.0_powershell.exe
 *
 * @param {string} [exePath]
 * @returns {{found:boolean, face?:string, source?:string}}
 */
export function getConsoleFont(exePath) {
  if (process.platform !== 'win32') return { found: false };

  const targets = [];

  if (exePath) {
    // 转义规则：\ → _，: → 无（其实冒号也变下划线，但保留盘符形式）
    const escaped = exePath.replace(/\\/g, '_').replace(/:/g, '');
    targets.push(escaped);
  }

  // 常见的两个
  targets.push('%SystemRoot%_System32_WindowsPowerShell_v1.0_powershell.exe');
  targets.push('%SystemRoot%_System32_cmd.exe');

  for (const name of targets) {
    try {
      const r = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `(Get-ItemProperty -Path 'HKCU:\\Console\\${name}' -Name FaceName -ErrorAction SilentlyContinue).FaceName`,
        ],
        { encoding: 'utf8', timeout: 8000, windowsHide: true },
      );
      const face = (r ?? '').trim();
      if (face) return { found: true, face, source: name };
    } catch {
      /* 继续试下一个 */
    }
  }

  // 没有子键就取默认值
  try {
    const r = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-ItemProperty -Path 'HKCU:\\Console' -Name FaceName -ErrorAction SilentlyContinue).FaceName`],
      { encoding: 'utf8', timeout: 8000, windowsHide: true },
    );
    const face = (r ?? '').trim();
    if (face) return { found: true, face, source: 'HKCU:\\Console (默认)' };
  } catch {
    /* 忽略 */
  }

  return { found: false };
}

/**
 * 判断终端能否显示中文。
 *
 * @param {{exePath?:string, wtSession?:boolean}} [opts]
 * @returns {{canShowChinese:boolean, reason:string, font:string|null, fix:string}}
 */
export function checkFontSupport(opts = {}) {
  // Windows Terminal 自带字体回退，基本不用担心
  if (process.env.WT_SESSION) {
    return {
      canShowChinese: true,
      reason: 'Windows Terminal（自带 CJK 字体回退）',
      font: null,
      fix: '',
    };
  }

  if (process.platform !== 'win32') {
    return { canShowChinese: true, reason: '非 Windows 平台', font: null, fix: '' };
  }

  const info = getConsoleFont(opts.exePath);

  if (!info.found) {
    // 查不到字体设置 —— 可能是新版系统或没自定义过
    // 保守起见当作「可能有问题」，但给的是软提示
    return {
      canShowChinese: true,
      reason: '未检测到自定义字体设置（通常没问题）',
      font: null,
      fix: '',
    };
  }

  const face = info.face.toLowerCase();

  // 已知有中文字形
  if (HAS_CJK_FONTS.some((f) => face.includes(f))) {
    return {
      canShowChinese: true,
      reason: `字体「${info.face}」支持中文`,
      font: info.face,
      fix: '',
    };
  }

  // 已知没有中文字形
  if (NO_CJK_FONTS.some((f) => face.includes(f))) {
    return {
      canShowChinese: false,
      reason: `字体「${info.face}」没有中文字形，中文会显示成方块 ▯▯▯`,
      font: info.face,
      fix: [
        '改字体（10 秒）：',
        '  1. 在本窗口标题栏上点右键 → 属性',
        '  2. 切到「字体」标签',
        '  3. 把字体改成「新宋体」或「Consolas」',
        '  4. 确定',
        '',
        '或者改用 Windows Terminal（Win11 自带，右键开始菜单→终端）',
        '  它是新式终端，默认字体就支持中文。',
      ].join('\n'),
    };
  }

  // 未知字体 —— 提醒但不阻断
  return {
    canShowChinese: true,
    reason: `字体「${info.face}」不在已知列表里，如显示方块请改字体`,
    font: info.face,
    fix: '如显示成方块 ▯▯▯，请把控制台字体改成「新宋体」。',
  };
}

/**
 * 生成 ASCII 降级版的主菜单（字体不支持中文时用）。
 *
 * 为什么要有降级版：
 *   提示用户改字体是一回事，但如果他不想改（或者环境受限），
 *   至少要能用。ASCII 界面丑但能用。
 *
 * @returns {string}
 */
export function asciiFallbackNotice() {
  return [
    '',
    '  ============================================================',
    '   Your console font cannot display Chinese characters.',
    '   你的控制台字体无法显示中文（显示成方块）。',
    '  ============================================================',
    '',
    '   Fix (10 seconds / 10 秒修好):',
    '     1. Right-click the title bar -> Properties',
    '     2. Go to the "Font" tab',
    '     3. Change font to "NSimSun" (新宋体) or "Consolas"',
    '     4. Click OK',
    '',
    '   Or use Windows Terminal instead (supports CJK out of the box).',
    '',
    '   ============================================================',
    '',
  ].join('\n');
}
