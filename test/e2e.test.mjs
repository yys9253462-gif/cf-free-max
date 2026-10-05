/**
 * 端到端测试 —— 需要真实 Cloudflare 凭据
 *
 * 默认**跳过**。设置以下环境变量后才会运行：
 *   CF_API_TOKEN         必需
 *   CF_ACCOUNT_ID        涉及账号级资源时必需
 *   CFM_E2E=1            显式开启（防止在 CI 里误跑真实调用）
 *
 * ⚠️ 设计原则：**只做只读操作**。
 *    这个文件里不会出现任何 POST/PUT/PATCH/DELETE 到生产资源。
 *    写操作的验证见 docs/recipes.md 的手动流程 —— 那种事必须在
 *    有回滚预案的前提下由人来做，不该跑在自动化测试里。
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { CFClient } from '../src/lib/cf.mjs';
import { FREE_TIER } from '../src/lib/quota.mjs';

const ENABLED = process.env.CFM_E2E === '1' && !!process.env.CF_API_TOKEN;

if (!ENABLED) {
  describe('e2e（需要真实凭据）', () => {
    test('已跳过', (t) => {
      t.skip(
        '未开启端到端测试。设置 CFM_E2E=1 与 CF_API_TOKEN 后重跑：\n' +
          '  CFM_E2E=1 CF_API_TOKEN=xxx node --test test/e2e.test.mjs\n' +
          '注意：只读操作，但仍会真实访问 Cloudflare API。',
      );
    });
  });
} else {
  describe('e2e: 凭据与连通性', () => {
    /** @type {CFClient} */
    let cf;

    before(() => {
      cf = new CFClient({ retries: 1, verbose: !!process.env.CFM_DEBUG });
    });

    test('Token 校验通过', async () => {
      const res = await cf.verifyToken();
      assert.ok(res, 'verifyToken 应返回结果');
      assert.equal(res.status, 'active', `Token 状态应为 active，实际 ${res.status}`);
    });

    test('能列出账号', async () => {
      const accounts = await cf.listAccounts();
      assert.ok(Array.isArray(accounts), 'listAccounts 应返回数组');
      // zone-scoped token 可能看不到账号，这不算失败
      if (accounts.length === 0) {
        console.log('  ℹ 该 Token 看不到账号（可能是 zone-scoped）');
      }
    });

    test('能列出 zone', async () => {
      const zones = await cf.listZones();
      assert.ok(Array.isArray(zones));
      console.log(`  ℹ 可见 ${zones.length} 个 zone`);
      for (const z of zones.slice(0, 5)) {
        console.log(`    - ${z.name} (${z.plan?.name ?? '?'})`);
      }
    });

    test('分页结果是完整的（不是只有第一页）', async () => {
      const zones = await cf.listZones();
      // 用 per_page=5 拉一次，再和全量比
      const paged = await cf.paginate('/zones', { perPage: 5 });
      assert.equal(
        paged.length,
        zones.length,
        `分页应拉全：perPage=5 得到 ${paged.length}，默认得到 ${zones.length}`,
      );
    });
  });

  describe('e2e: 额度采集', () => {
    let cf;
    let accountId;

    before(async () => {
      cf = new CFClient({ retries: 1 });
      accountId = cf.accountId;
      if (!accountId) {
        const accounts = await cf.listAccounts();
        if (accounts.length === 1) accountId = accounts[0].id;
      }
    });

    test('Workers 用量可采集', async (t) => {
      if (!accountId) return t.skip('未指定 CF_ACCOUNT_ID 且无法自动确定账号');

      const until = new Date();
      const since = new Date(until.getTime() - 24 * 3600 * 1000);
      const data = await cf.request('POST', 'https://api.cloudflare.com/client/v4/graphql', {
        body: {
          query: `query($a:String!,$s:Time!,$u:Time!){viewer{accounts(filter:{accountTag:$a}){
            workersInvocationsAdaptive(limit:10,filter:{datetime_geq:$s,datetime_leq:$u}){
              sum{requests} dimensions{scriptName}}}}}`,
          variables: { a: accountId, s: since.toISOString(), u: until.toISOString() },
        },
      });

      const rows = data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
      assert.ok(Array.isArray(rows), 'GraphQL 应返回数组');

      const total = rows.reduce((sum, r) => sum + (r.sum?.requests ?? 0), 0);
      console.log(`  ℹ 过去 24 小时 Workers 请求：${total.toLocaleString()} / ${FREE_TIER.workers.requests.limit.toLocaleString()}`);
    });

    test('R2 桶可列出', async (t) => {
      if (!accountId) return t.skip('需要 CF_ACCOUNT_ID');
      const buckets = await cf.paginate(`/accounts/${accountId}/r2/buckets`);
      assert.ok(Array.isArray(buckets));
      console.log(`  ℹ ${buckets.length} 个 R2 桶`);
    });

    test('Tunnel 可列出', async (t) => {
      if (!accountId) return t.skip('需要 CF_ACCOUNT_ID');
      const tunnels = await cf.paginate(`/accounts/${accountId}/cfd_tunnel`, {
        query: { is_deleted: false },
      });
      assert.ok(Array.isArray(tunnels));
      console.log(`  ℹ ${tunnels.length} 个 Tunnel`);
    });
  });

  describe('e2e: 错误处理', () => {
    test('无效 Token 得到规范化错误（不是崩栈）', async () => {
      const bad = new CFClient({ token: 'definitely_not_valid_token_12345', retries: 0 });
      await assert.rejects(
        () => bad.verifyToken(),
        (err) => {
          assert.ok(err.name === 'CFError', `应是 CFError，实际 ${err.name}`);
          assert.ok(err.status >= 400, '应带 HTTP 状态码');
          assert.ok(typeof err.message === 'string' && err.message.length > 0, '应有错误消息');
          console.log(`  ℹ 得到 [${err.status}/${err.code}] ${err.message}`);
          return true;
        },
      );
    });

    test('不存在的 zone 给出可读错误', async () => {
      const cf = new CFClient({ retries: 0 });
      await assert.rejects(
        () => cf.findZone('this-zone-should-not-exist-9f8e7d6c.invalid'),
        (err) => {
          assert.ok(err.message.includes('找不到 zone'), `错误消息应说明原因，实际：${err.message}`);
          return true;
        },
      );
    });
  });
}
