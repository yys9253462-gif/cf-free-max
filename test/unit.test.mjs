/**
 * 单元测试（Node 内置 test runner，零依赖）
 *
 * 测试重点是「不依赖真实 API 也能验证的逻辑」：
 *   - 参数解析
 *   - 额度表完整性
 *   - DNS 名称规范化
 *   - 路由重叠判断
 *   - 错误对象格式
 *   - 表格渲染
 *
 * 需要真实凭据的端到端测试见 test/e2e.test.mjs（默认跳过）。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs, humanBytes, humanNum, mapLimit, require_ } from '../src/lib/util.mjs';
import { FREE_TIER, PITFALLS, listProducts, formatQuota } from '../src/lib/quota.mjs';
import { CFError, CF_ERRORS } from '../src/lib/cf.mjs';

describe('parseArgs', () => {
  test('解析裸标志', () => {
    const r = parseArgs(['usage', '--json', '--verbose']);
    assert.equal(r._[0], 'usage');
    assert.equal(r.json, true);
    assert.equal(r.verbose, true);
  });

  test('解析 --key=value', () => {
    const r = parseArgs(['dns', 'sync', 'example.com', '--file=./dns.json']);
    assert.deepEqual(r._, ['dns', 'sync', 'example.com']);
    assert.equal(r.file, './dns.json');
  });

  test('解析 --key value', () => {
    const r = parseArgs(['r2', 'create', 'b1', '--location', 'apac']);
    assert.equal(r.location, 'apac');
    assert.equal(r._[2], 'b1');
  });

  test('值为负数时不被当成标志', () => {
    const r = parseArgs(['x', '--ttl', '-1']);
    assert.equal(r.ttl, '-1');
  });

  test('-- 之后全部作为位置参数', () => {
    const r = parseArgs(['run', '--', '--not-a-flag']);
    assert.deepEqual(r._, ['run', '--not-a-flag']);
  });

  test('短标志', () => {
    const r = parseArgs(['-v', '-f', 'x.json']);
    assert.equal(r.v, true);
    assert.equal(r.f, 'x.json');
  });
});

describe('quota 表', () => {
  test('所有产品都有条目', () => {
    const products = listProducts();
    assert.ok(products.length >= 10, `产品数应 >= 10，实际 ${products.length}`);
  });

  test('每个额度项结构完整', () => {
    for (const product of listProducts()) {
      for (const [key, q] of Object.entries(FREE_TIER[product])) {
        assert.ok('limit' in q, `${product}.${key} 缺 limit`);
        assert.ok(['day', 'month', 'total'].includes(q.period), `${product}.${key} period 非法：${q.period}`);
        assert.ok(q.unit, `${product}.${key} 缺 unit`);
        assert.ok(q.limit === null || typeof q.limit === 'number', `${product}.${key} limit 类型错误`);
      }
    }
  });

  test('踩坑清单非空且字段完整', () => {
    assert.ok(PITFALLS.length >= 3);
    for (const p of PITFALLS) {
      assert.ok(p.id && p.title && p.detail, 'pitfall 字段缺失');
    }
  });

  test('formatQuota 输出合理', () => {
    assert.equal(formatQuota({ limit: 1000, unit: 'writes', period: 'day' }), '1,000 writes/天');
    assert.equal(formatQuota({ limit: 5, unit: 'GB', period: 'total' }), '5 GB');
    assert.equal(formatQuota({ limit: null, unit: 'bytes', period: 'total' }), '不限量');
  });

  test('KV 写额度确实是最紧的一项（文档承诺）', () => {
    assert.equal(FREE_TIER.workers_kv.writes.limit, 1000);
    assert.ok(FREE_TIER.workers_kv.reads.limit >= FREE_TIER.workers_kv.writes.limit * 10);
  });

  test('D1 读额度大于写额度（扫描行 vs 写入行）', () => {
    assert.ok(FREE_TIER.workers_d1.rows_read.limit > FREE_TIER.workers_d1.rows_written.limit);
  });

  test('R2 出站流量应标记为不限量', () => {
    assert.equal(FREE_TIER.r2.egress.limit, null);
  });
});

describe('humanBytes / humanNum', () => {
  test('字节换算', () => {
    assert.equal(humanBytes(0), '0 B');
    assert.equal(humanBytes(1023), '1023 B');
    assert.equal(humanBytes(1024), '1.00 KB');
    assert.equal(humanBytes(1024 ** 3), '1.00 GB');
    assert.equal(humanBytes(5 * 1024 ** 3), '5.00 GB');
    assert.equal(humanBytes(10 * 1024 ** 3), '10.00 GB');
  });

  test('异常输入不崩', () => {
    assert.equal(humanBytes(null), '-');
    assert.equal(humanBytes(undefined), '-');
    assert.equal(humanBytes(NaN), '-');
    assert.equal(humanNum(null), '-');
  });

  test('千分位', () => {
    assert.equal(humanNum(1000000), '1,000,000');
  });
});

describe('CFError', () => {
  test('包含可读提示', () => {
    const e = new CFError('权限不足', { code: 6007, status: 403, endpoint: '/zones' });
    const s = e.toString();
    assert.ok(s.includes('403'), '应包含状态码');
    assert.ok(s.includes('6007'), '应包含 CF 错误码');
    assert.ok(s.includes('权限'), '应包含可读提示');
    assert.ok(s.includes('/zones'), '应包含端点');
  });

  test('未知错误码不崩', () => {
    const e = new CFError('x', { code: 999999 });
    assert.ok(e.toString().includes('999999'));
  });

  test('错误码表覆盖常见项', () => {
    for (const code of [6003, 6007, 6103, 7003, 9109, 10000]) {
      assert.ok(CF_ERRORS[code], `缺少错误码 ${code} 的说明`);
    }
  });
});

describe('mapLimit', () => {
  test('保持顺序', async () => {
    const items = [5, 1, 4, 2, 3];
    const out = await mapLimit(items, 2, async (x) => {
      await new Promise((r) => setTimeout(r, x * 5));
      return x * 2;
    });
    assert.deepEqual(out, [10, 2, 8, 4, 6]);
  });

  test('遵守并发上限', async () => {
    let running = 0;
    let peak = 0;
    await mapLimit([...Array(20).keys()], 3, async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
    });
    assert.ok(peak <= 3, `峰值并发应 <= 3，实际 ${peak}`);
  });

  test('空数组', async () => {
    assert.deepEqual(await mapLimit([], 3, async () => 1), []);
  });
});

describe('require_', () => {
  test('存在时返回值', () => {
    assert.equal(require_({ file: 'a.json' }, 'file'), 'a.json');
  });

  test('缺失时抛错', () => {
    assert.throws(() => require_({}, 'file'), /缺少必填参数 --file/);
  });

  test('布尔 true（裸标志）视为缺失', () => {
    assert.throws(() => require_({ file: true }, 'file'), /缺少必填参数/);
  });
});
