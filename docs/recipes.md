# 常见组合场景

## 1. 新域名接入后的标准加固流程

```bash
ZONE=example.com

# 1) 先看现状
cfm doctor $ZONE

# 2) 打开免费加速项（先 dry-run 看清单）
cfm zone harden $ZONE --dry-run
cfm zone harden $ZONE --yes

# 3) 检查 DNS 是否有记录忘了开橙云
cfm dns list $ZONE --not-proxied
cfm dns proxy $ZONE --enable --dry-run
cfm dns proxy $ZONE --enable --yes

# 4) 上 Cache Rules（免费层不限条数，比 5 条页面规则划算得多）
cfm cache rules $ZONE --apply static --dry-run
cfm cache rules $ZONE --apply static --yes

# 5) 复核
cfm doctor $ZONE
```

**为什么顺序是这样**：先改 SSL/HTTPS 再上缓存。如果先开缓存而 SSL 还是 Flexible，你可能把明文回源的内容缓存到边缘，清理起来很麻烦。

---

## 2. 静态站点：用 R2 而不是 S3

R2 的核心优势是**出站流量免费**。同样 100GB/月出站，S3 要 9 美元，R2 是 0。

```bash
# 1) 建桶（选靠近用户的区域）
cfm r2 create my-site --location apac

# 2) 挂自定义域
cfm r2 domain my-site --add static.example.com

# 3) 设置缓存规则（静态资源长缓存）
cfm cache rules example.com --apply static

# 4) 防止垃圾数据堆积（重要）
cfm r2 lifecycle my-site --expire-days 90 --prefix tmp/

# 5) 查看占用
cfm r2 usage
```

上传用 wrangler 或 rclone：

```bash
# rclone 配置（R2 兼容 S3 API）
# [r2]
# type = s3
# provider = Cloudflare
# access_key_id = <R2 Access Key>
# secret_access_key = <R2 Secret>
# endpoint = https://<account-id>.r2.cloudflarestorage.com

rclone sync ./dist r2:my-site --progress
```

**❌ 不要用 `r2.dev` 公共域做生产**：它是共享域名、无缓存、有速率限制。只用 `cfm r2 public my-site on` 做测试。

---

## 3. 内网服务暴露（Tunnel）

不用在路由器上开任何端口。

```bash
# 1) 建隧道
cfm tunnel create homelab

# 2) 配置路由（自动建 DNS + 写 ingress）
cfm tunnel route homelab \
  --hostname app.example.com \
  --service http://localhost:8080

# 3) 看 token
cfm tunnel token homelab

# 4) 在目标机器上装（会打印各平台命令）
cfm tunnel setup homelab
```

在目标机器（Debian/Ubuntu）上：

```bash
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install -y cloudflared
sudo cloudflared service install <TOKEN>
sudo systemctl enable --now cloudflared
```

**检查冗余**：单副本挂了服务就断。`cfm tunnel connections homelab` 应显示 ≥2 个连接。多副本直接在另一台机器上跑同样的命令即可，免费层不限数量。

---

## 4. D1 上生产前的额度体检

D1 是最容易「莫名超限」的产品，因为它按**扫描行数**计费。

```bash
DB=mydb

# 1) 看现有索引
cfm d1 index $DB

# 2) 对关键查询做计划分析
cfm d1 explain $DB --sql "SELECT * FROM orders WHERE user_email = ?"
# 若输出 SCAN orders → 需要建索引

cfm d1 query $DB --sql "CREATE INDEX idx_orders_user_email ON orders(user_email)"

# 3) 再验证一次
cfm d1 explain $DB --sql "SELECT * FROM orders WHERE user_email = ?"
# 应输出 SEARCH orders USING INDEX idx_orders_user_email

# 4) 定期看实际消耗
cfm usage
```

**额度换算**：表 10 万行，无索引的查询每次扣 10 万行。500 万行/天的额度 → **50 次查询就打满**。加了索引后每次只扫 1~几行。

---

## 5. KV 用量评估（决定要不要换存储）

```bash
NS=<namespace-id>

# 场景估算
cfm kv budget $NS --per-request-writes 2 --daily-requests 3000
```

输出会告诉你：按这个用法能撑住多少请求/天，以及该不该换 D1。

经验值：

| 场景 | 建议 |
| :--- | :--- |
| 配置缓存、特性开关（写 < 1000/天） | KV ✅ |
| 读多写少的静态配置分发 | KV ✅（读有 10 万/天） |
| 计数器、访问日志 | D1 ✅（10 万行/天写） |
| 用户会话、状态机 | D1 或 Durable Objects |
| 需要立即一致（KV 是最终一致） | Durable Objects |

---

## 6. 多域名批量运维

```bash
# 导出所有 zone 的 DNS（做备份）
for z in $(cfm whoami --json | jq -r '.zones[].name'); do
  cfm dns export "$z" --file "backup/$z.json"
done

# 全账号审计，找出所有问题
cfm audit

# 只修某一类问题：批量开 Always Use HTTPS
cfm audit --json | jq -r '.issues[] | select(.msg | contains("Always Use HTTPS")) | .zone' | \
  while read -r z; do
    cfm zone set "$z" always_use_https on --yes
  done
```

---

## 7. DDNS（家用宽带 IP 变化）

在路由器或 NAS 上装个 cron：

```bash
# 每 5 分钟检查一次（IP 未变时不会发请求）
*/5 * * * * CF_API_TOKEN=xxx /usr/bin/node /opt/cf-free-max/bin/cfm.mjs \
  dns ddns example.com --name home >> /var/log/cf-ddns.log 2>&1
```

建议：
- 记录类型用 A，**关闭橙云**（DDNS 场景直连更可靠）
- TTL 设 60 秒，让切换更快生效
- 用 `--ip` 显式指定也可以（跳过自动探测）

---

## 8. 用量告警接入自己的通知渠道

```bash
#!/bin/bash
# /opt/cf-free-max/alert.sh —— 每天跑一次

OUT=$(node /opt/cf-free-max/bin/cfm.mjs usage --json)

KV_WRITE=$(echo "$OUT" | jq '.kv.byAction.write // .kv.byAction.writeKey // 0')

if [ "$KV_WRITE" -gt 800 ]; then
  curl -X POST "$WEBHOOK_URL" \
    -H 'Content-Type: application/json' \
    -d "{\"text\":\"⚠️ KV 写入额度已用 $KV_WRITE/1000\"}"
fi
```

配合 cron：

```cron
0 22 * * * /opt/cf-free-max/alert.sh
```

（UTC 22:00 = 北京时间 6:00，在 UTC 额度重置前 2 小时，还有调整余地。）
