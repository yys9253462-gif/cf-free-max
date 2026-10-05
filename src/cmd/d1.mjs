/**
 * d1 — D1 数据库管理
 *
 * 🔴 免费层最容易被忽视的杀手：D1 按**扫描行数**计费（500 万行/天）。
 *    缺索引的查询会全表扫描 —— 表 10 万行时，50 次查询就打满当天额度。
 *    本命令组的 `explain` 与 `index` 子命令就是为了防住这件事。
 *
 * 子命令：
 *   cfm d1 list
 *   cfm d1 create <name>
 *   cfm d1 delete <name>
 *   cfm d1 info <name>
 *   cfm d1 query <name> --sql "SELECT ..." [--file query.sql] [--params a,b]
 *   cfm d1 export <name> --file dump.sql
 *   cfm d1 explain <name> --sql "SELECT ..."     分析是否会全表扫描
 *   cfm d1 index <name> --list | --suggest       索引建议
 */

import fs from 'node:fs';
import { log, table, color, confirm, require_, humanNum, humanBytes } from '../lib/util.mjs';
import { FREE_TIER } from '../lib/quota.mjs';

export async function run({ client, flags }) {
  const sub = flags._[1];
  const cf = client();
  const accountId = cf.accountId;
  if (!accountId) {
    log.err('D1 需要账号 ID。请设置 CF_ACCOUNT_ID。');
    return 1;
  }

  switch (sub) {
    case 'list':
      return listDb(cf, accountId, flags);
    case 'create':
      return createDb(cf, accountId, flags);
    case 'delete':
      return deleteDb(cf, accountId, flags);
    case 'info':
      return infoDb(cf, accountId, flags);
    case 'query':
      return queryDb(cf, accountId, flags);
    case 'export':
      return exportDb(cf, accountId, flags);
    case 'explain':
      return explain(cf, accountId, flags);
    case 'index':
      return indexCmd(cf, accountId, flags);
    default:
      log.err(`未知子命令：d1 ${sub ?? '(空)'}`);
      console.log('可用：list / create / delete / info / query / export / explain / index');
      return 2;
  }
}

async function listDb(cf, accountId, flags) {
  const dbs = await cf.paginate(`/accounts/${accountId}/d1/database`);
  if (flags.json) {
    console.log(JSON.stringify(dbs, null, 2));
    return 0;
  }
  if (!dbs.length) {
    log.info('还没有 D1 数据库。');
    log.dim('创建：cfm d1 create my-db');
    return 0;
  }
  table(
    ['名称', 'UUID', '版本', '创建时间'],
    dbs.map((d) => [d.name, d.uuid, d.version ?? '-', (d.created_at ?? '').slice(0, 10)]),
  );
  console.log('');
  const limit = FREE_TIER.workers_d1.databases.limit;
  log.dim(`共 ${dbs.length}/${limit} 个（免费层上限）`);
  log.dim(`每日额度：读 ${humanNum(FREE_TIER.workers_d1.rows_read.limit)} 行 / 写 ${humanNum(FREE_TIER.workers_d1.rows_written.limit)} 行`);
  return 0;
}

async function createDb(cf, accountId, flags) {
  const name = flags._[2];
  if (!name) {
    log.err('用法：cfm d1 create <name> [--location weur]');
    return 2;
  }
  if (flags['dry-run']) {
    log.info(`--dry-run：将创建数据库 ${name}`);
    return 0;
  }
  const res = await cf.request('POST', `/accounts/${accountId}/d1/database`, {
    body: { name, ...(flags.location ? { primary_location_hint: String(flags.location) } : {}) },
  });
  log.ok(`已创建：${res.name}`);
  console.log(`\nwrangler.toml：\n`);
  console.log(`${color.cyan}[[d1_databases]]`);
  console.log(`binding = "${name.toUpperCase().replace(/\W+/g, '_')}"`);
  console.log(`database_name = "${res.name}"`);
  console.log(`database_id = "${res.uuid}"${color.reset}\n`);
  return 0;
}

async function deleteDb(cf, accountId, flags) {
  const name = flags._[2];
  if (!name) {
    log.err('用法：cfm d1 delete <name|uuid>');
    return 2;
  }
  log.warn(`将删除数据库 ${name} 及其全部数据。不可撤销。`);
  if (flags['dry-run']) return 0;
  if (!(await confirm('确认删除？', { force: flags.yes }))) return 0;
  await cf.request('DELETE', `/accounts/${accountId}/d1/database/${name}`);
  log.ok('已删除。');
  return 0;
}

async function infoDb(cf, accountId, flags) {
  const name = flags._[2];
  if (!name) {
    log.err('用法：cfm d1 info <name|uuid>');
    return 2;
  }
  const db = await cf.request('GET', `/accounts/${accountId}/d1/database/${name}`);
  console.log(`\n${color.bold}${db.name}${color.reset}`);
  console.log(`  UUID      ${db.uuid}`);
  console.log(`  版本      ${db.version ?? '-'}`);
  console.log(`  创建      ${db.created_at ?? '-'}`);
  console.log(`  文件大小  ${humanBytes(db.file_size ?? 0)} / ${FREE_TIER.workers_d1.db_size.limit} MB`);
  console.log(`  表数量    ${db.num_tables ?? '-'}`);
  console.log('');

  // 顺带列出表
  try {
    const res = await cf.request('POST', `/accounts/${accountId}/d1/database/${name}/query`, {
      body: { sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name" },
    });
    const tables = res?.[0]?.results ?? [];
    if (tables.length) {
      log.step('表');
      table(['表名'], tables.map((t) => [t.name]));
    }
  } catch (e) {
    log.warn(`无法列出表：${e.message}`);
  }
  return 0;
}

async function queryDb(cf, accountId, flags) {
  const name = flags._[2];
  if (!name) {
    log.err('用法：cfm d1 query <name> --sql "SELECT ..." | --file query.sql [--params a,b]');
    return 2;
  }

  let sql = flags.sql ? String(flags.sql) : null;
  if (!sql && flags.file) sql = fs.readFileSync(String(flags.file), 'utf8');
  if (!sql) {
    log.err('需要 --sql 或 --file。');
    return 2;
  }

  const params = flags.params ? String(flags.params).split(',').map((s) => s.trim()) : [];

  // 检查是否写操作
  const isWrite = /^\s*(insert|update|delete|create|drop|alter|replace)\b/i.test(sql);

  if (isWrite) {
    log.warn('这是写操作，会消耗每日写额度。');
    if (flags['dry-run']) {
      log.info('--dry-run：未执行。');
      return 0;
    }
    if (!(await confirm('确认执行写操作？', { force: flags.yes }))) return 0;
  }

  const started = Date.now();
  const res = await cf.request('POST', `/accounts/${accountId}/d1/database/${name}/query`, {
    body: { sql, params },
  });
  const elapsed = Date.now() - started;

  if (flags.json) {
    console.log(JSON.stringify(res, null, 2));
    return 0;
  }

  const first = Array.isArray(res) ? res[0] : res;
  const rows = first?.results ?? [];
  const meta = first?.meta ?? {};

  if (flags.verbose) {
    log.dim(`耗时 ${elapsed}ms；扫描 ${humanNum(meta.rows_read ?? 0)} 行，写入 ${humanNum(meta.rows_written ?? 0)} 行`);
  }

  if (!rows.length) {
    log.ok('查询成功，无返回行。');
    if (meta.changed_db) log.info(`影响行数：${meta.changes ?? 0}`);
    return 0;
  }

  const cols = Object.keys(rows[0]);
  table(
    cols,
    rows.slice(0, 200).map((r) => cols.map((c) => formatCell(r[c]))),
  );
  if (rows.length > 200) console.log(`\n… 共 ${rows.length} 行，只显示前 200 行。`);

  // 扫描行数预警 —— 这是 D1 的额度杀手
  const scanned = meta.rows_read ?? 0;
  const dailyLimit = FREE_TIER.workers_d1.rows_read.limit;
  const pct = (scanned / dailyLimit) * 100;
  console.log('');
  if (pct > 1) {
    log.warn(`本次扫描 ${humanNum(scanned)} 行，占每日额度 ${pct.toFixed(2)}% —— 若反复执行会很快打满。运行 cfm d1 explain 看是否需要加索引。`);
  } else {
    log.dim(`本次扫描 ${humanNum(scanned)} 行（每日额度 ${humanNum(dailyLimit)} 行）`);
  }
  return 0;
}

function formatCell(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  return s.length > 50 ? s.slice(0, 47) + '…' : s;
}

/**
 * export — 导出为 SQL
 *
 * 注意：导出大表会消耗大量读行额度。
 * D1 的 REST API 没有原生 dump，这里用分页 SELECT 拼接。
 */
async function exportDb(cf, accountId, flags) {
  const name = flags._[2];
  if (!name) {
    log.err('用法：cfm d1 export <name> --file dump.sql [--tables t1,t2]');
    return 2;
  }

  log.step(`导出 ${name}`);
  log.warn('导出会消耗读行额度，大表请谨慎。');

  const tablesRes = await cf.request('POST', `/accounts/${accountId}/d1/database/${name}/query`, {
    body: { sql: "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'" },
  });
  let tables = tablesRes?.[0]?.results ?? [];
  if (flags.tables) {
    const want = new Set(String(flags.tables).split(',').map((s) => s.trim()));
    tables = tables.filter((t) => want.has(t.name));
  }

  if (!tables.length) {
    log.warn('没有可导出的表。');
    return 0;
  }

  const chunks = ['PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n'];
  let totalRows = 0;

  for (const t of tables) {
    chunks.push(`\n-- 表 ${t.name}\n${t.sql};\n`);
    let offset = 0;
    const pageSize = 500;
    while (true) {
      const res = await cf.request('POST', `/accounts/${accountId}/d1/database/${name}/query`, {
        body: { sql: `SELECT * FROM "${t.name}" LIMIT ${pageSize} OFFSET ${offset}` },
      });
      const rows = res?.[0]?.results ?? [];
      if (!rows.length) break;
      for (const row of rows) {
        const cols = Object.keys(row);
        const vals = cols.map((c) => sqlLiteral(row[c])).join(', ');
        chunks.push(`INSERT INTO "${t.name}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${vals});\n`);
      }
      totalRows += rows.length;
      offset += rows.length;
      if (rows.length < pageSize) break;
      if (offset > 50000) {
        log.warn(`表 ${t.name} 超过 50000 行，已停止（避免打满读行额度）。`);
        break;
      }
    }
  }
  chunks.push('\nCOMMIT;\n');

  const out = chunks.join('');
  if (flags.file) {
    fs.writeFileSync(String(flags.file), out, 'utf8');
    log.ok(`已导出 ${tables.length} 张表 / ${humanNum(totalRows)} 行到 ${flags.file}`);
  } else {
    console.log(out);
  }
  return 0;
}

function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * explain — 查询计划分析（防 D1 额度杀手）
 */
async function explain(cf, accountId, flags) {
  const name = flags._[2];
  const sql = flags.sql ? String(flags.sql) : flags.file ? fs.readFileSync(String(flags.file), 'utf8') : null;
  if (!name || !sql) {
    log.err('用法：cfm d1 explain <name> --sql "SELECT ..."');
    return 2;
  }

  log.step('查询计划分析');

  const res = await cf.request('POST', `/accounts/${accountId}/d1/database/${name}/query`, {
    body: { sql: `EXPLAIN QUERY PLAN ${sql}` },
  });
  const plan = res?.[0]?.results ?? [];

  if (flags.json) {
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }

  table(
    ['id', 'parent', 'notused', 'detail'],
    plan.map((r) => [r.id, r.parent, r.notused ?? 0, r.detail ?? '']),
  );

  console.log('');
  const details = plan.map((r) => String(r.detail ?? '')).join('\n');
  const findings = [];

  if (/SCAN\s+(?!.*USING)/i.test(details) || /SCAN [a-z_]+$/im.test(details)) {
    findings.push({
      level: 'bad',
      msg: '检测到全表扫描（SCAN 后无 USING INDEX）。这会按表的总行数消耗读额度。',
    });
  }
  if (/USE TEMP B-TREE FOR ORDER BY/i.test(details)) {
    findings.push({ level: 'warn', msg: '排序使用临时 B 树，说明排序列无索引。' });
  }
  if (/SCAN .* USING INDEX/i.test(details)) {
    findings.push({ level: 'ok', msg: '使用了索引扫描，额度消耗可控。' });
  }

  for (const f of findings) {
    const icon = { ok: color.green + '✔' + color.reset, warn: color.yellow + '⚠' + color.reset, bad: color.red + '✘' + color.reset }[f.level];
    console.log(`${icon} ${f.msg}`);
  }

  if (findings.some((f) => f.level === 'bad')) {
    console.log('');
    log.step('建议');
    console.log('  为 WHERE / JOIN 条件涉及的列建索引，例如：');
    // 尝试从 SQL 里提取 WHERE 列，给出示例
    const whereMatch = sql.match(/where\s+(.+?)(?:order by|group by|limit|$)/is);
    if (whereMatch) {
      const cols = [...whereMatch[1].matchAll(/([a-z_][a-z0-9_]*)\s*(?:=|>|<|>=|<=|like|in\b)/gi)].map((m) => m[1]);
      const tableMatch = sql.match(/from\s+([a-z_"][a-z0-9_"]*)/i);
      const tbl = tableMatch ? tableMatch[1].replace(/"/g, '') : 'your_table';
      if (cols.length) {
        console.log(`\n  ${color.cyan}CREATE INDEX idx_${tbl}_${cols.join('_')} ON ${tbl}(${cols.join(', ')});${color.reset}`);
        console.log(`\n  执行：cfm d1 query ${name} --sql "CREATE INDEX ..."`);
      }
    }
  }
  return 0;
}

/**
 * index — 索引审计
 */
async function indexCmd(cf, accountId, flags) {
  const name = flags._[2];
  if (!name) {
    log.err('用法：cfm d1 index <name> --list | --suggest');
    return 2;
  }

  const res = await cf.request('POST', `/accounts/${accountId}/d1/database/${name}/query`, {
    body: {
      sql: `SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, name`,
    },
  });
  const indexes = res?.[0]?.results ?? [];

  const tablesRes = await cf.request('POST', `/accounts/${accountId}/d1/database/${name}/query`, {
    body: {
      sql: `SELECT m.name AS tbl,
                   (SELECT COUNT(*) FROM "${'{'}x{'}'}") AS dummy
            FROM sqlite_master m WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%'`,
    },
  }).catch(() => null);

  if (flags.json) {
    console.log(JSON.stringify(indexes, null, 2));
    return 0;
  }

  log.step(`${name} 的索引`);
  if (!indexes.length) {
    log.warn('没有任何索引。所有查询都会全表扫描，D1 读额度会被快速消耗。');
  } else {
    table(
      ['索引名', '表', '定义'],
      indexes.map((i) => [i.name, i.tbl_name, (i.sql ?? '(自动)').slice(0, 60)]),
    );
  }

  // 索引建议：检查外键列是否有索引
  console.log('');
  log.step('索引健康度检查');

  try {
    const fkRes = await cf.request('POST', `/accounts/${accountId}/d1/database/${name}/query`, {
      body: {
        sql: `SELECT m.name AS tbl, p.name AS col
              FROM sqlite_master m
              JOIN pragma_foreign_key_list(m.name) p
              WHERE m.type='table'`,
      },
    });
    const fks = fkRes?.[0]?.results ?? [];
    const indexed = new Set(indexes.map((i) => `${i.tbl_name}.${i.name}`));
    const unindexed = fks.filter((fk) => {
      const hit = indexes.some(
        (i) => i.tbl_name === fk.tbl && String(i.sql ?? '').includes(`(${fk.col}`),
      );
      return !hit;
    });

    if (unindexed.length) {
      log.warn(`发现 ${unindexed.length} 个未加索引的外键列：`);
      for (const u of unindexed.slice(0, 10)) {
        console.log(`  ${u.tbl}.${u.col}  → 建议：${color.cyan}CREATE INDEX idx_${u.tbl}_${u.col} ON ${u.tbl}(${u.col});${color.reset}`);
      }
    } else if (fks.length) {
      log.ok(`全部 ${fks.length} 个外键列都有索引。`);
    } else {
      log.dim('没有检测到外键约束。');
    }
  } catch {
    log.dim('外键检查跳过（该库可能未启用外键或版本较旧）。');
  }

  console.log('');
  log.dim('提示：索引本身会占存储空间，且让写入变慢。只在 WHERE/JOIN/ORDER BY 用到的列上建索引。');
  return 0;
}
