/**
 * 部署配置的加载与校验
 *
 * 设计：配置与代码分离。用户只改 config/sites.json，不用碰源码。
 * JSON 不支持注释，所以说明写在这里和 docs/deploy.md。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 项目根目录（src/lib/ 往上两级） */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const CONFIG_PATH = path.join(ROOT, 'config', 'sites.json');

/** 支持的绑定类型 */
const BINDING_TYPES = new Set(['d1', 'r2', 'kv', 'durable_object']);

export class ConfigError extends Error {
  constructor(msg, field) {
    super(msg);
    this.name = 'ConfigError';
    this.field = field;
  }
}

/**
 * 读取并校验配置。
 * @param {string} [configPath]
 * @returns {{repoOwner:string, workspace:string, sites:any[], options:any, root:string}}
 */
export function loadConfig(configPath = CONFIG_PATH) {
  if (!fs.existsSync(configPath)) {
    throw new ConfigError(`找不到配置文件：${configPath}`);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new ConfigError(`配置文件不是合法 JSON：${e.message}\n  路径：${configPath}`);
  }

  const errors = [];

  // repoOwner 允许为空 —— 表示「还没初始化」，由 setup 向导补齐。
  // 实测踩过：分享包里 repoOwner 是空的，如果这里报错，
  // 别人第一次运行就被挡住，连初始化向导都进不去。
  if (raw.repoOwner !== undefined && raw.repoOwner !== null && typeof raw.repoOwner !== 'string') {
    errors.push('repoOwner：必须是字符串（GitHub 用户名或组织名）');
  }

  if (!Array.isArray(raw.sites) || raw.sites.length === 0) {
    errors.push('sites：必须是非空数组');
  } else {
    const ids = new Set();
    raw.sites.forEach((s, i) => {
      const where = `sites[${i}]`;

      if (!s.id) errors.push(`${where}.id：必填，用于命令行参数（如 --only blog）`);
      else if (ids.has(s.id)) errors.push(`${where}.id：重复的 id「${s.id}」`);
      else ids.add(s.id);

      if (!s.repo) errors.push(`${where}.repo：必填，GitHub 仓库名`);
      if (!s.project) errors.push(`${where}.project：必填，Cloudflare Pages 项目名`);
      if (!s.outputDir) errors.push(`${where}.outputDir：必填，构建产物目录（相对仓库根）`);

      if (s.type && !['build', 'static'].includes(s.type)) {
        errors.push(`${where}.type：只能是 build 或 static，当前是「${s.type}」`);
      }

      if (s.type === 'build' && !s.buildCommand) {
        errors.push(`${where}.buildCommand：type=build 时必填`);
      }

      if (s.bindings) {
        if (!Array.isArray(s.bindings)) {
          errors.push(`${where}.bindings：必须是数组`);
        } else {
          s.bindings.forEach((b, j) => {
            const bw = `${where}.bindings[${j}]`;
            if (!BINDING_TYPES.has(b.type)) {
              errors.push(`${bw}.type：不支持的类型「${b.type}」，支持：${[...BINDING_TYPES].join(', ')}`);
            }
            if (!b.binding) errors.push(`${bw}.binding：必填，代码里引用绑定的变量名`);
            if (!b.name) errors.push(`${bw}.name：必填，Cloudflare 上的资源名`);
            // D1 的 id 允许为空 —— 表示「还没创建」，由 setup 向导自动建。
            // 只在显式开启了严格校验时才报错。
            if (b.type === 'd1' && !b.id && raw.strictValidation) {
              errors.push(`${bw}.id：D1 需要 database_id`);
            }
          });
        }
      }

      // patches 是可选的构建补丁列表（见 src/lib/deploy-patches.mjs）
      if (s.patches !== undefined && !Array.isArray(s.patches)) {
        errors.push(`${where}.patches：必须是数组，如 ["disable-rss-route"]`);
      }

      // protected 站点是只读的 —— 必须说明原因，避免以后自己忘了为什么
      if (s.protected === true && !s.protectedReason) {
        errors.push(`${where}.protectedReason：标记 protected 时必须写明原因（以后才记得为什么不能动）`);
      }
    });
  }

  if (errors.length) {
    throw new ConfigError('配置有问题：\n' + errors.map((e) => `  · ${e}`).join('\n'), errors.join('; '));
  }

  // workspace 归一化
  const workspace = raw.workspace
    ? path.resolve(raw.workspace)
    : path.join(ROOT, '.sites');

  return {
    repoOwner: raw.repoOwner,
    workspace,
    sites: raw.sites,
    options: {
      autoInstallDeps: true,
      cleanInstall: false,
      verifyAfterDeploy: true,
      deployTimeoutSec: 600,
      buildTimeoutSec: 900,
      ...(raw.options ?? {}),
    },
    root: ROOT,
  };
}

/**
 * 检查工作区里的仓库状态。
 * @param {any} site
 * @param {string} workspace
 * @returns {{exists:boolean, dir:string, cloned:boolean, branch?:string, dirty?:boolean, commit?:string}}
 */
export function inspectRepo(site, workspace) {
  const dir = path.join(workspace, site.repo);
  const result = { exists: false, dir, cloned: false };

  if (!fs.existsSync(dir)) return result;
  result.exists = true;

  const gitDir = path.join(dir, '.git');
  if (!fs.existsSync(gitDir)) return result;
  result.cloned = true;

  // 读取当前分支与提交
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: refs/heads/')) {
      result.branch = head.slice('ref: refs/heads/'.length);
    } else {
      result.branch = `(detached ${head.slice(0, 7)})`;
    }
  } catch {
    /* 忽略 */
  }

  try {
    const ref = result.branch?.startsWith('(') ? null : path.join(gitDir, 'refs', 'heads', result.branch);
    if (ref && fs.existsSync(ref)) {
      result.commit = fs.readFileSync(ref, 'utf8').trim().slice(0, 7);
    }
  } catch {
    /* 忽略 */
  }

  return result;
}

export { ROOT, BINDING_TYPES };
