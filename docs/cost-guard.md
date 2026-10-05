# 如何不让免费额度变成账单

Cloudflare 免费层本身**不会**产生费用 —— 但有几个地方会，而且不显眼。

## 会收钱的三个地方

### 1. R2 存储超过 10 GB

R2 免费 10 GB-month。超出部分 **$0.015/GB/月**。

也就是说，如果放着 50GB 冷数据不管，一个月多花 $0.6 —— 不多，但如果你把它当备份盘用了半年，就是 $3.6，而且**不会有人提醒你**。

**防住它：**

```bash
# 看占用
cfm r2 usage

# 设置自动清理（最有效的手段）
cfm r2 lifecycle my-bucket --expire-days 90            # 全桶
cfm r2 lifecycle my-bucket --expire-days 30 --prefix tmp/  # 只清 tmp/
```

> 注意：出站流量免费是 R2 的核心卖点，**不会**因为下载多而收费。
> 收费的只有「存了多少」。

### 2. R2 Class A 操作超过 100 万次/月

Class A = 写 / 列举 / 复制。超出 $4.50 / 百万次。

**典型踩法**：代码里用 `list` 判断对象是否存在。

```js
// ❌ 每次调用消耗一个 Class A 操作
const list = await bucket.list({ prefix: key });
if (list.objects.length === 0) { /* 不存在 */ }

// ✅ head 是 Class B（额度 10 倍），且更快
const head = await bucket.head(key);
if (head === null) { /* 不存在 */ }
```

### 3. Workers 超出请求数

免费 10 万/天。超出后按 $0.30 / 百万次计费 —— 但前提是你已经**开通了付费计划**。

**没开通付费计划的话，超限是直接返回错误，不产生费用。** 这是好消息也是坏消息：不会突然收到账单，但服务会挂。

**防住它：**

```bash
# 每天看趋势
cfm usage
```

如果确实需要更多，再考虑 $5/月的 Workers Paid（1000 万请求/月）—— 但那是有意识的选择，不是"不知不觉超了"。

---

## 三层防线

### 第一层：不开通付费（最强的保险）

控制台 → **Billing** → 不添加支付方式，或明确不上 Workers Paid / R2 付费。

后果是超限直接报错。如果你的服务不能接受这个（生产站点），那这层不适合你，往下看。

### 第二层：设置支出上限

控制台 → **Billing** → **Notifications / Spend limits**

- **Notification**：达到某个金额发邮件（治标）
- **Spend limit**：达到上限后停止服务（治本）

⚠️ Cloudflare 的 spend limit 不是所有产品都支持，且是按账号级别。设完之后**实际测一下**是否真的会拦住，不要假设。

### 第三层：主动巡检（本工具的用法）

```bash
# 每天跑，超过阈值就告警
cfm usage --json | jq -e '
  (.workers.total // 0) < 80000 and
  ((.kv.byAction.write // .kv.byAction.writeKey // 0) < 800) and
  ((.d1.rowsRead // 0) < 4000000)
' || echo "有指标接近上限"
```

或者直接用仓库里的定时任务：`.github/workflows/quota-report.yml` 每天检查并开 Issue。

---

## 一份可抄的巡检脚本

```bash
#!/usr/bin/env bash
# /opt/cf-free-max/daily-check.sh
set -euo pipefail

THRESHOLD=80
WEBHOOK="${WEBHOOK_URL:-}"

OUT=$(node /opt/cf-free-max/bin/cfm.mjs usage --json)

check() {
  local label="$1" used="$2" limit="$3"
  [ "$used" = "null" ] && return 0
  local pct=$(( used * 100 / limit ))
  if [ "$pct" -ge "$THRESHOLD" ]; then
    echo "⚠️  $label: ${pct}% (${used}/${limit})"
    if [ -n "$WEBHOOK" ]; then
      curl -sS -X POST "$WEBHOOK" -H 'Content-Type: application/json' \
        -d "{\"text\":\"Cloudflare $label 已用 ${pct}%\"}" >/dev/null
    fi
  fi
}

check "Workers 请求" "$(echo "$OUT" | jq '.workers.total // 0')" 100000
check "KV 写"        "$(echo "$OUT" | jq '(.kv.byAction.write // .kv.byAction.writeKey) // 0')" 1000
check "D1 扫描行"     "$(echo "$OUT" | jq '.d1.rowsRead // 0')" 5000000

echo "巡检完成：$(date -u +%FT%TZ)"
```

```cron
# 每天 UTC 22:00（北京时间 6:00）—— 距 UTC 额度重置还有 2 小时，来得及调整
0 22 * * * /opt/cf-free-max/daily-check.sh >> /var/log/cf-check.log 2>&1
```

---

## 关于「免费额度最大化利用」的正确理解

免费额度用满 ≠ 想办法搞更多额度。真正的做法是：

1. **别浪费**：开了缓存就不用回源；DNS 走橙云就省源站带宽；Brotli 开了就省传输量
2. **用对产品**：计数器用 D1 不用 KV；静态资源放 R2 不用 Workers（R2 出站免费）
3. **知道边界**：`cfm quota` 写得清清楚楚，别等 429 才反应过来
4. **有预警**：定时巡检 + 阈值告警

这四条做到，免费层能撑住的服务规模比你想象的大不少：

| 服务类型 | 免费层能撑住 |
| :--- | :--- |
| 静态博客 | 完全够用，基本没上限（Pages 静态带宽不限量） |
| 带 API 的小应用 | 10 万请求/天，日活几千完全够 |
| 图床 / 文件站 | R2 10GB 存储 + 出站免费，比大多数付费方案都划算 |
| 内网穿透 | Tunnel 无限量免费，没有理由用别的 |
| 小数据库应用 | D1 5 万次查询/天（前提是加了索引） |

**真正会撞墙的**通常不是"额度太小"，而是用法不对。`cfm doctor` 和 `cfm usage` 就是用来发现这件事的。
