/**
 * Cloudflare API 客户端（零依赖，仅用 Node 内置 fetch）
 *
 * 设计要点：
 *  - 自动重试 429 / 5xx，尊重 Retry-After
 *  - 自动分页（Cloudflare 的 result_info）
 *  - 明确的错误对象，带上 CF 的 error code，便于判断
 *  - 支持两种凭据：API Token（推荐）与 Global API Key（兼容旧环境）
 */

const API_BASE = 'https://api.cloudflare.com/client/v4';

/** Cloudflare 常见错误码，用于给出人话解释 */
export const CF_ERRORS = {
  6003: '请求头格式无效（检查 Token 是否正确、有无多余空格）',
  6007: '权限不足：该 Token 未包含此操作所需权限',
  6103: '无效的 API Token',
  7003: '找不到指定的资源（zone/账号 ID 是否正确？）',
  9109: 'Token 缺少该 zone 的访问授权',
  10000: '认证失败：Token 无效或已过期',
  1001: '账号未验证邮箱 / 未开通该产品',
  2001: '资源已被锁定',
  81044: 'DNS 记录已存在，无需重复创建',
  81057: 'DNS 记录已存在（同名同类型）',
};

export class CFError extends Error {
  /**
   * @param {string} message
   * @param {{code?:number, status?:number, errors?:any[], endpoint?:string}} info
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'CFError';
    this.code = info.code ?? 0;
    this.status = info.status ?? 0;
    this.errors = info.errors ?? [];
    this.endpoint = info.endpoint ?? '';
    this.hint = CF_ERRORS[this.code] ?? '';
  }

  toString() {
    const bits = [`[${this.status}/${this.code}] ${this.message}`];
    if (this.hint) bits.push(`  ↳ 可能原因：${this.hint}`);
    if (this.endpoint) bits.push(`  ↳ 端点：${this.endpoint}`);
    return bits.join('\n');
  }
}

/**
 * 读取凭据。优先级：环境变量 > 配置文件。
 * @param {Record<string,string>} [extra]
 * @returns {{token:string, email?:string, key?:string, accountId?:string}}
 */
export function loadCredentials(extra = {}) {
  const env = {
    token: process.env.CF_API_TOKEN || extra.token || '',
    email: process.env.CF_API_EMAIL || extra.email || '',
    key: process.env.CF_API_KEY || extra.key || '',
    accountId: process.env.CF_ACCOUNT_ID || extra.accountId || '',
  };
  if (!env.token && !(env.email && env.key)) {
    throw new CFError(
      '未找到 Cloudflare 凭据。请设置环境变量 CF_API_TOKEN（推荐），' +
        '或同时设置 CF_API_EMAIL + CF_API_KEY。详见 README 的「准备凭据」一节。',
    );
  }
  return env;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CFClient {
  /**
   * @param {{token?:string, email?:string, key?:string, accountId?:string, retries?:number, verbose?:boolean}} [opts]
   */
  constructor(opts = {}) {
    this.creds = loadCredentials(opts);
    this.retries = opts.retries ?? 3;
    this.verbose = opts.verbose ?? false;
  }

  get accountId() {
    return this.creds.accountId;
  }

  /**
   * 发一次请求（含重试）。
   * @param {string} method
   * @param {string} path 形如 '/zones' 或完整 URL
   * @param {{body?:any, query?:Record<string,any>}} [opts]
   * @returns {Promise<any>} Cloudflare 响应的 result 字段
   */
  async request(method, path, opts = {}) {
    const url = new URL(path.startsWith('http') ? path : API_BASE + path);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
    }

    const headers = { 'Content-Type': 'application/json' };
    if (this.creds.token) {
      headers.Authorization = `Bearer ${this.creds.token}`;
    } else {
      headers['X-Auth-Email'] = this.creds.email;
      headers['X-Auth-Key'] = this.creds.key;
    }

    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) {
        // 指数退避：1s, 2s, 4s
        const wait = 1000 * 2 ** (attempt - 1);
        if (this.verbose) console.error(`  ↻ 第 ${attempt} 次重试，等待 ${wait}ms…`);
        await sleep(wait);
      }

      let res;
      try {
        res = await fetch(url.toString(), {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        });
      } catch (netErr) {
        lastErr = new CFError(`网络请求失败：${netErr.message}`, { endpoint: url.pathname });
        continue;
      }

      // 429 / 5xx 可重试
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get('retry-after'));
        const bodyText = await res.text().catch(() => '');
        let code = 0;
        try {
          code = JSON.parse(bodyText)?.errors?.[0]?.code ?? 0;
        } catch { /* 忽略非 JSON */ }
        lastErr = new CFError(
          res.status === 429 ? '触发速率限制（429）' : `服务端错误（${res.status}）`,
          { code, status: res.status, endpoint: url.pathname },
        );
        if (Number.isFinite(ra) && ra > 0) await sleep(Math.min(ra * 1000, 10_000));
        if (attempt < this.retries) continue;
        throw lastErr;
      }

      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        throw new CFError(`响应不是合法 JSON（HTTP ${res.status}）`, {
          status: res.status,
          endpoint: url.pathname,
        });
      }

      if (!res.ok || json.success === false) {
        const first = json.errors?.[0] ?? {};
        throw new CFError(first.message || `HTTP ${res.status}`, {
          code: first.code,
          status: res.status,
          errors: json.errors,
          endpoint: url.pathname,
        });
      }

      return json.result;
    }

    throw lastErr ?? new CFError('请求失败且无具体错误信息', { endpoint: url.pathname });
  }

  /**
   * 自动翻页拉取列表接口。
   * @param {string} path
   * @param {{query?:Record<string,any>, perPage?:number, maxPages?:number}} [opts]
   * @returns {Promise<any[]>}
   */
  async paginate(path, opts = {}) {
    const perPage = opts.perPage ?? 50;
    const maxPages = opts.maxPages ?? 200;
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const url = new URL(path.startsWith('http') ? path : API_BASE + path);
      for (const [k, v] of Object.entries(opts.query ?? {})) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
      url.searchParams.set('page', String(page));
      url.searchParams.set('per_page', String(perPage));

      const res = await fetch(url.toString(), { headers: this.#authHeaders() });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.success === false) {
        const first = json.errors?.[0] ?? {};
        throw new CFError(first.message || `HTTP ${res.status}`, {
          code: first.code,
          status: res.status,
          errors: json.errors,
          endpoint: url.pathname,
        });
      }
      const batch = Array.isArray(json.result) ? json.result : [];
      out.push(...batch);

      const info = json.result_info;
      if (!info || batch.length < perPage || page >= (info.total_pages ?? 1)) break;
    }
    return out;
  }

  /** @private */
  #authHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (this.creds.token) h.Authorization = `Bearer ${this.creds.token}`;
    else {
      h['X-Auth-Email'] = this.creds.email;
      h['X-Auth-Key'] = this.creds.key;
    }
    return h;
  }

  // ---------- 便捷方法 ----------

  /** 验证 Token 是否有效，并返回其权限范围 */
  async verifyToken() {
    return this.request('GET', '/user/tokens/verify');
  }

  /** 列出账号 */
  async listAccounts() {
    return this.paginate('/accounts');
  }

  /** 列出全部 zone */
  async listZones() {
    return this.paginate('/zones');
  }

  /**
   * 按域名找 zone。
   * @param {string} name
   */
  async findZone(name) {
    const zones = await this.paginate('/zones', { query: { name } });
    const exact = zones.find((z) => z.name === name);
    if (!exact) {
      throw new CFError(`找不到 zone：${name}。请确认该域名已添加到账号下，且 Token 有该 zone 权限。`);
    }
    return exact;
  }

  /**
   * 解析 zone 参数：接受 zone 名称或 zone id。
   * @param {string} ref
   */
  async resolveZone(ref) {
    if (/^[0-9a-f]{32}$/i.test(ref)) {
      return this.request('GET', `/zones/${ref}`);
    }
    return this.findZone(ref);
  }
}

export { API_BASE };
