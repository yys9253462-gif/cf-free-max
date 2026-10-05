/**
 * Cloudflare 免费额度常量表
 *
 * 数据来源：Cloudflare 官方定价页与开发者文档，收录时间 2026-10-05。
 * 免费额度会调整，请以 `node bin/cfm.mjs quota --check` 的在线校验结果为准。
 *
 * ⚠️ 重要提醒：本表是「免费层能用到多少」的**上限参考**，
 *    不是「可以想办法刷更多」。超出即按付费计费或被限流，这是设计如此。
 */

export const PLAN_FREE = 'free';

/** @typedef {{limit:number, unit:string, period:'day'|'month'|'total', note?:string}} Quota */

/**
 * 各产品的免费额度。
 * limit 为 null 表示该产品在免费层「不计费但需开通」或「无限但有其他约束」。
 * @type {Record<string, Record<string, Quota>>}
 */
export const FREE_TIER = {
  workers: {
    requests: { limit: 100_000, unit: 'requests', period: 'day', note: '每日 UTC 00:00 重置' },
    cpu_ms: { limit: 10, unit: 'ms/req', period: 'total', note: '单次调用 CPU 时间上限，免费层固定 10ms' },
    script_size: { limit: 3, unit: 'MiB', period: 'total', note: '压缩后单 Worker 体积（付费 10 MiB）' },
    scripts: { limit: 100, unit: 'scripts', period: 'total' },
    subrequests: { limit: 50, unit: 'subrequests/req', period: 'total', note: '单次调用可发起的 fetch 数' },
    env_vars: { limit: 64, unit: 'vars', period: 'total', note: '每个 Worker 的环境变量数上限（文本类）' },
    cron_triggers: { limit: 5, unit: 'triggers', period: 'total', note: '每个 Worker 的 Cron 数量' },
  },
  workers_kv: {
    reads: { limit: 100_000, unit: 'reads', period: 'day' },
    writes: { limit: 1_000, unit: 'writes', period: 'day', note: '最容易超的一项——写操作按 key 计' },
    deletes: { limit: 1_000, unit: 'deletes', period: 'day' },
    lists: { limit: 1_000, unit: 'lists', period: 'day' },
    keys_read: { limit: 1_000, unit: 'keys read', period: 'day' },
    storage: { limit: 1, unit: 'GiB', period: 'total' },
    namespaces: { limit: 1_000, unit: 'namespaces', period: 'total' },
    key_size: { limit: 512, unit: 'bytes', period: 'total', note: '单 key 名长度上限' },
    value_size: { limit: 25, unit: 'MiB', period: 'total' },
  },
  workers_d1: {
    rows_read: { limit: 5_000_000, unit: 'rows', period: 'day', note: '按扫描行数计，不是返回行数' },
    rows_written: { limit: 100_000, unit: 'rows', period: 'day' },
    storage: { limit: 5, unit: 'GB', period: 'total' },
    databases: { limit: 10, unit: 'databases', period: 'total' },
    db_size: { limit: 500, unit: 'MB', period: 'total', note: '单个数据库上限' },
    queries_per_invocation: { limit: 1_000, unit: 'queries', period: 'total' },
  },
  r2: {
    storage: { limit: 10, unit: 'GB-month', period: 'month' },
    class_a: { limit: 1_000_000, unit: 'ops', period: 'month', note: 'Class A = 写/列举/复制' },
    class_b: { limit: 10_000_000, unit: 'ops', period: 'month', note: 'Class B = 读' },
    egress: { limit: null, unit: 'bytes', period: 'total', note: '出站流量免费且不限量——R2 最大卖点' },
    buckets: { limit: 1_000, unit: 'buckets', period: 'total' },
  },
  pages: {
    builds: { limit: 500, unit: 'builds', period: 'month' },
    files: { limit: 20_000, unit: 'files', period: 'total', note: '单个站点文件数上限' },
    file_size: { limit: 25, unit: 'MiB', period: 'total' },
    site_size: { limit: 20_000, unit: 'files', period: 'total' },
    custom_domains: { limit: 100, unit: 'domains', period: 'total', note: '每个 Pages 项目' },
    bandwidth: { limit: null, unit: 'bytes', period: 'total', note: '静态请求不限量' },
  },
  workers_ai: {
    neurons: { limit: 10_000, unit: 'neurons', period: 'day', note: '免费额度按神经元计，文本/图像生成换算比不同' },
  },
  dns: {
    records: { limit: 200, unit: 'records', period: 'total', note: '每个 zone 的 DNS 记录数' },
    zones: { limit: null, unit: 'zones', period: 'total', note: '免费 zone 数量无硬上限' },
  },
  cache: {
    purge_requests: { limit: 1_000, unit: 'purges', period: 'day' },
  },
  tunnel: {
    tunnels: { limit: null, unit: 'tunnels', period: 'total', note: '免费，无数量限制' },
    connections: { limit: 4, unit: 'connectors', period: 'total', note: '每个 tunnel 建议的 connector 副本数' },
  },
  queues: {
    operations: { limit: 1_000_000, unit: 'operations', period: 'month', note: '仅 Workers 付费计划可用，免费层不可用' },
  },
  durable_objects: {
    requests: { limit: 100_000, unit: 'requests', period: 'day', note: '免费层可用，含 SQLite 后端' },
  },
};

/**
 * Cloudflare 免费层最容易踩的三个坑（写进代码防止自己忘）。
 */
export const PITFALLS = [
  {
    id: 'kv-write-burst',
    title: 'KV 每日 1000 次写',
    detail:
      'KV 写入额度极低且按 key 计。用 KV 做「每次请求都写」的计数器/日志，几千次访问就把日额度打满，' +
      '之后所有写入返回 429。需要高频写请改用 D1（10 万行/天）或 Durable Objects。',
  },
  {
    id: 'd1-rows-read',
    title: 'D1 按「扫描行数」计费',
    detail:
      'D1 的 500 万行/天指的是**扫描**行数。缺索引的 `SELECT * FROM t WHERE name = ?` 会全表扫描，' +
      '表有 10 万行时每次查询扣 10 万行 —— 50 次查询就打满当天额度。务必建索引。',
  },
  {
    id: 'workers-subrequest',
    title: 'Workers 单次 50 个子请求',
    detail:
      '单次调用最多 50 个 fetch。循环里批量调第三方 API 会直接抛异常。' +
      '需要批量时用 Promise.all 分批 + 限流，或拆成多个 Worker/队列任务。',
  },
  {
    id: 'r2-class-a',
    title: 'R2 的 Class A 操作',
    detail:
      'Class A（写/列表）只有 100 万次/月，Class B（读）有 1000 万次。' +
      '频繁 list 对象来「检查是否存在」会快速消耗 Class A —— 改用 head 请求（Class B）。',
  },
  {
    id: 'pages-builds',
    title: 'Pages 每月 500 次构建',
    detail:
      '每次 git push 触发一次构建。高频提交的仓库一个月能烧掉全部额度。' +
      '建议用 `[skip ci]` 或开启构建缓存，或改用 Workers Static Assets。',
  },
];

/**
 * 取某产品的额度定义。
 * @param {string} product
 * @returns {Record<string, Quota>|null}
 */
export function getQuota(product) {
  return FREE_TIER[product] ?? null;
}

/**
 * 列出全部产品名。
 * @returns {string[]}
 */
export function listProducts() {
  return Object.keys(FREE_TIER);
}

/**
 * 把人可读的额度渲染成一行。
 * @param {Quota} q
 * @returns {string}
 */
export function formatQuota(q) {
  const lim = q.limit === null ? '不限量' : `${q.limit.toLocaleString('en-US')} ${q.unit}`;
  const per = { day: '/天', month: '/月', total: '' }[q.period];
  return `${lim}${per}`;
}
