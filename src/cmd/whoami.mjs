import { log, table, color } from '../lib/util.mjs';

/** 校验凭据、列出账号与 zone */
export async function run({ client, flags }) {
  const cf = client();

  log.step('校验 API 凭据');
  const verify = await cf.verifyToken();
  log.ok(`Token 状态：${verify.status}`);

  if (flags.json) {
    const accounts = await cf.listAccounts();
    const zones = await cf.listZones();
    console.log(JSON.stringify({ token: verify, accounts, zones }, null, 2));
    return 0;
  }

  log.step('账号');
  const accounts = await cf.listAccounts();
  if (!accounts.length) {
    log.warn('该凭据下没有可见账号。若是 zone-scoped Token，这是正常的。');
  } else {
    table(
      ['账号名', '账号 ID', '类型'],
      accounts.map((a) => [a.name, a.id, a.type ?? '-']),
    );
  }

  log.step('Zone（域名）');
  const zones = await cf.listZones();
  if (!zones.length) {
    log.warn('没有可见的 zone。检查 Token 是否包含 Zone:Read 权限。');
  } else {
    table(
      ['域名', 'Zone ID', '套餐', '状态', 'NS'],
      zones.map((z) => [
        z.name,
        z.id,
        z.plan?.name ?? '-',
        z.status,
        (z.name_servers ?? []).slice(0, 2).join(', '),
      ]),
    );
    const paid = zones.filter((z) => z.plan?.name && z.plan.name.toLowerCase() !== 'free');
    if (paid.length) {
      log.warn(`其中 ${paid.length} 个 zone 不是免费套餐：${paid.map((z) => z.name).join(', ')}`);
    }
  }

  const acct = cf.accountId;
  if (acct) {
    log.step(`默认账号 ID：${color.cyan}${acct}${color.reset}`);
  } else if (accounts.length === 1) {
    log.info(`建议设置环境变量：CF_ACCOUNT_ID=${accounts[0].id}`);
  } else if (accounts.length > 1) {
    log.warn('有多个账号，请设置 CF_ACCOUNT_ID 明确指定，否则涉账号的资源操作（R2/KV/D1/Pages）会失败。');
  }

  return 0;
}
