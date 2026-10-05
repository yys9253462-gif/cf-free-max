import { log, color, table } from '../lib/util.mjs';

const HELP = `
${color.bold}cfm${color.reset} — Cloudflare 免费额度用满工具箱  ${color.dim}v1.0.0${color.reset}

${color.bold}用法${color.reset}
  cfm <命令> [选项]

${color.bold}诊断类${color.reset}
  ${color.cyan}whoami${color.reset}                    校验凭据、列出账号与 zone
  ${color.cyan}doctor${color.reset}                    体检：逐项检查免费额度配置是否留在坑里
  ${color.cyan}quota${color.reset} [产品]              打印免费额度对照表
  ${color.cyan}usage${color.reset} [--json]             拉取实际用量，显示距上限还剩多少
  ${color.cyan}audit${color.reset}                     全量审计：DNS/缓存/SSL/R2/KV 配置合理性

${color.bold}操作类${color.reset}
  ${color.cyan}dns${color.reset} <子命令>                DNS 记录批量管理（list/add/sync/export）
  ${color.cyan}cache${color.reset} <子命令>              缓存管理（purge/devmode/rules）
  ${color.cyan}zone${color.reset} <子命令>               zone 设置（ssl/always-use-https/hsts/brotli）
  ${color.cyan}r2${color.reset} <子命令>                R2 桶管理（list/create/cors/lifecycle/usage）
  ${color.cyan}pages${color.reset} <子命令>              Pages 项目（list/create/deploy/domain）
  ${color.cyan}workers${color.reset} <子命令>            Workers（list/deploy/secret/route/tail）
  ${color.cyan}kv${color.reset} <子命令>                 KV 命名空间（list/create/put/get/keys）
  ${color.cyan}d1${color.reset} <子命令>                 D1 数据库（list/create/query/backup/index）
  ${color.cyan}tunnel${color.reset} <子命令>             Cloudflare Tunnel（list/create/route）

${color.bold}全局选项${color.reset}
  --verbose, -v            打印重试与请求细节
  --json                   以 JSON 输出（便于脚本消费）
  --account <id>           指定账号 ID
  --yes, -y                跳过交互确认（CI 用）
  --dry-run                只打印将要执行的操作，不实际调用写接口

${color.bold}环境变量${color.reset}
  CF_API_TOKEN             API Token（推荐）
  CF_ACCOUNT_ID            账号 ID（多账号时必须指定）
  CF_API_EMAIL + CF_API_KEY   Global API Key（旧方式，兼容用）
  NO_COLOR=1               关闭彩色输出

${color.bold}示例${color.reset}
  ${color.dim}# 先看凭据是否正常${color.reset}
  cfm whoami

  ${color.dim}# 体检，找出哪些配置把你的免费额度浪费了${color.reset}
  cfm doctor

  ${color.dim}# 看各类资源还剩多少额度${color.reset}
  cfm usage

  ${color.dim}# 把一个域名的 DNS 记录从 JSON 文件同步过去${color.reset}
  cfm dns sync example.com --file ./dns.json --prune

  ${color.dim}# 一键把 zone 的免费加速全打开（SSL/HTTPS/HSTS/Brotli/0-RTT）${color.reset}
  cfm zone harden example.com

${color.bold}文档${color.reset}
  docs/quota-cheatsheet.md    免费额度速查与踩坑
  docs/cost-guard.md          如何避免意外账单
  docs/recipes.md             常见组合场景
`;

export async function run() {
  console.log(HELP);
  return 0;
}
