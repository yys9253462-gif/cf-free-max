# cf-free-max

> 把 Cloudflare 免费额度**用满、用对、用明白**的一键工具箱。

这不是「薅羊毛」——Cloudflare 免费层本身给得很多（Workers 每天 10 万请求、R2 10GB 存储**且出站流量完全免费**、D1 500 万行/天、免费 Tunnel 无限量……），大多数人不是拿不到，而是**不知道自己拿到了多少，也不知道额度被什么吃掉了**。

`cfm` 解决的就是这个问题：把散落在十来个产品里的额度和消耗，变成一条命令看清楚的表格。

```console
$ cfm usage
指标                  已用          免费上限（占用）              备注
──────────────────────┼─────────────┼─────────────────────────────┼──────────────────
Workers 请求（24h）     42,183        100,000 ████░░░░░░ 42.2%
KV 读（24h）            8,921         100,000 █░░░░░░░░░ 8.9%
KV 写（24h）            847           1,000   ████████░░ 84.7%      ← 要撞墙了
D1 扫描行（24h）        120,442       5,000,000 ░░░░░░░░░░ 2.4%
R2 存储                 3.21 GB       10 GB (32.1%)               4 个桶 / 12,847 对象

⚠ 接近上限，请注意：
  • KV 写（24h）已用 84.7%
```

---

## 目录

- [为什么需要这个工具](#为什么需要这个工具)
- [快速开始](#快速开始)
- [命令一览](#命令一览)
- [三个最有价值的用法](#三个最有价值的用法)
- [免费额度速查](#免费额度速查)
- [最容易踩的五个坑](#最容易踩的五个坑)
- [设计原则](#设计原则)
- [常见问题](#常见问题)

---

## 为什么需要这个工具

Cloudflare 免费层的问题不是「给得少」，而是**信息不透明**：

| 痛点 | 现况 | cfm 怎么做 |
| :--- | :--- | :--- |
| **额度和消耗分散** | 每个产品一个控制台页面，没有统一的「还剩多少」 | `cfm usage` 一次拉全 |
| **超限才知道超了** | 429 报错才反应过来 | 阈值告警 + 趋势估算（如「按当前速度 3 小时后超限」） |
| **配置浪费额度** | 不知道 SSL=Flexible、缓存被关、页面规则用满会怎样 | `cfm doctor` 逐项体检并给出修复命令 |
| **批量操作要手点** | 几十个 zone 的 DNS/缓存设置只能一个个改 | `cfm dns sync` / `cfm zone harden` 批量 |
| **额度计算反直觉** | D1 按**扫描行数**算、KV 写只有 1000/天 | `cfm quota --pitfalls` + 场景估算器 |

### 一个真实例子

某站点访问量不大，却频繁遇到 KV 写入 429。用 `cfm kv budget` 一算：

```console
$ cfm kv budget NS_ID --per-request-writes 3 --daily-requests 2000

命名空间 NS_ID
  免费层每日写额度  1,000
若每次请求写 3 次 KV → 最多 333 次请求/天
  换算：约 0.00 QPS 持续写入

你的场景（2,000 请求/天）
  需要写入 6,000 次 → 占每日额度 600.0%
✘ 超出每日写额度！KV 不适合这个用量。

判断建议
  • 写入频繁（计数器、日志、会话、用户状态）→ 改用 D1（10 万行/天）
  • 需要强一致 / 事务 / 实时协作 → 改用 Durable Objects（免费层可用）
```

问题不在额度小，在于**用错了存储**。

---

## 快速开始

### 1. 直接跑（不用记命令）

```bash
git clone https://github.com/yys9253462-gif/cf-free-max.git
cd cf-free-max
node bin/cfm.mjs          # 不带参数就进交互菜单
```

```
╭──────────────────────────────────────────────────────────╮
│  Cloudflare 免费额度工具箱                                │
│  cfm interactive                                          │
╰──────────────────────────────────────────────────────────╯
● 凭据不可用 （仍可浏览额度表与使用估算器）
  ↳ 尚未配置凭据：设置环境变量 CF_API_TOKEN，或建 .env 文件

你想做什么？
  ❯  01. 📊  看用量           需要凭据
     02. 🩺  做体检           需要凭据
     03. 🔍  全账号审计       需要凭据
     04. 📖  额度速查         离线可用 · 免费额度对照表与踩坑
     05. 🧮  场景估算         部分离线可用 · 这个用法能撑多少流量？
     06. ⚙️   配置与操作      需要凭据
     07. 🚀  初始化向导       需要凭据
     08. ❓  帮助
     09. 退出

↑↓ 选择 · 回车确认 · 直接按数字 · q 返回
```

**没配凭据也能用** —— 额度速查和场景估算里的 KV / Workers 部分是纯计算的，
可以在买服务之前先算清楚撑不撑得住。需要凭据的项会明确标出来。

交互模式的完整说明见 [docs/interactive.md](docs/interactive.md)。

### 2. 准备凭据

**方式一：API Token（推荐，最小权限）**

去 <https://dash.cloudflare.com/profile/api-tokens> → Create Token → Custom token，按需勾选：

| 你要用的功能 | 需要的权限 |
| :--- | :--- |
| `whoami` / `quota` | 无需权限（Token 校验本身即可） |
| `dns` / `zone` / `cache` / `doctor` / `audit` | Account: `Zone:Read`；Zone: `DNS:Edit`、`Zone Settings:Edit`、`Cache Purge:Purge` |
| `workers` / `kv` / `d1` / `r2` / `pages` / `tunnel` | Account: `Workers Scripts:Edit`、`Workers KV Storage:Edit`、`D1:Edit`、`Workers R2 Storage:Edit`、`Cloudflare Pages:Edit`、`Cloudflare Tunnel:Edit` |

只想看用量的话，`Account: Account Analytics:Read` + `Zone: Zone:Read` 就够了。

**方式二：Global API Key**（权限过大，仅在 Token 覆盖不到时用）

```bash
export CF_API_EMAIL=you@example.com
export CF_API_KEY=xxxxxxxx
```

### 2. 配置

```bash
cd cf-free-max
cp .env.example .env
# 编辑 .env，填入 CF_API_TOKEN 和 CF_ACCOUNT_ID
```

> **不需要 `npm install`** —— 本项目零运行时依赖，Node 18+ 直接跑。
> 这不是偷懒，是刻意选择：供应链攻击面为零，任何机器 clone 下来即可用。

### 3. 验证

```bash
node bin/cfm.mjs           # 交互模式，直接看菜单
# 或者直接跑命令
node bin/cfm.mjs whoami     # 校验凭据、列出账号与 zone
node bin/cfm.mjs doctor     # 体检：哪些配置在浪费你的免费额度
node bin/cfm.mjs usage      # 各类资源剩多少
```

想全局使用：

```bash
npm link          # 之后可以直接 cfm whoami
# 或者
alias cfm='node /path/to/cf-free-max/bin/cfm.mjs'
```

### 4. 没有 Node？用 shell 版

路由器、NAS、刚装好的 VPS、只有 busybox 的容器——不想为看一眼额度装运行时的话：

```bash
CF_API_TOKEN=xxx CF_ACCOUNT_ID=yyy ./scripts/cf-quick-check.sh
```

只用 `bash` + `curl`（`jq` 可选，没有会降级用 grep 解析）。覆盖最要紧的四项：Workers 请求、KV 读、**KV 写**、D1 扫描行。退出码 `0` = 正常，`1` = 有指标超阈值，适合直接挂 cron：

```cron
0 22 * * * CF_API_TOKEN=xxx CF_ACCOUNT_ID=yyy /opt/cf-free-max/scripts/cf-quick-check.sh || notify-send "CF 额度告警"
```

完整功能（体检、审计、批量操作、场景估算）仍需要 Node 版。

---

## 命令一览

### 交互模式

| 命令 | 作用 |
| :--- | :--- |
| `cfm` | 不带参数进交互菜单（管道/CI 里自动回落到帮助） |
| `cfm ui` | 显式进交互 |

### 诊断类（只读，安全）

| 命令 | 作用 |
| :--- | :--- |
| `cfm whoami` | 校验凭据、列出账号与所有 zone |
| `cfm doctor [zone]` | **逐项体检**：找出 SSL=Flexible、缓存被关、页面规则用满等 13 类问题，每条给修复命令 |
| `cfm doctor --zone example.com` | 只体检指定域名 |
| `cfm quota [产品]` | 免费额度对照表 |
| `cfm quota --pitfalls` | 只看踩坑清单 |
| `cfm usage [--json]` | **拉真实用量**，显示进度条与占用百分比 |
| `cfm audit` | 全账号审计：zone 配置 + 资源占用 + 风险清单 |

### 操作类

| 命令 | 说明 |
| :--- | :--- |
| `cfm zone list\|show\|set\|harden` | zone 设置。`harden` 一键打开全部免费加速项 |
| `cfm dns list\|export\|add\|sync\|proxy\|ddns\|delete` | DNS 批量管理，含幂等同步与橙云批量切换 |
| `cfm cache purge\|devmode\|rules\|warm` | 缓存清理、开发模式、Cache Rules、预热 |
| `cfm r2 list\|create\|usage\|cors\|lifecycle\|domain\|public` | R2 桶、用量、生命周期、自定义域 |
| `cfm pages list\|create\|deployments\|domains\|budget\|rollback` | Pages 项目与**构建额度分析** |
| `cfm workers list\|get\|delete\|secret\|route\|limits` | 批量运维 Workers（日常开发仍推荐 wrangler） |
| `cfm kv list\|create\|keys\|get\|put\|del\|budget` | KV 管理 + **写额度压力分析** |
| `cfm d1 list\|create\|query\|export\|explain\|index` | D1 管理 + **查询计划分析**（防全表扫描烧额度） |
| `cfm tunnel list\|create\|token\|connections\|route\|setup` | Tunnel 管理，含各平台安装命令 |

### 全局选项

```
--json              以 JSON 输出（便于脚本消费）
--dry-run           只打印将执行的操作，不做写调用
--yes, -y           跳过交互确认（CI 用）
--account <id>      指定账号 ID
--verbose, -v       打印重试与请求细节
```

---

## 三个最有价值的用法

### 用法一：体检 —— 找出吃掉额度的配置

```console
$ cfm doctor example.com
▸ example.com
  ✔ SSL 模式=full_strict
      端到端加密，正常。
  ✘ SSL 模式为 Flexible
      Flexible 意味着 Cloudflare→源站是明文。会导致重定向死循环...
      修复：cfm zone set example.com ssl full_strict
  ⚠ Always Use HTTPS 未开
      同一份内容会以 http/https 两个 key 分别缓存，浪费缓存空间与回源。
      修复：cfm zone set example.com always_use_https on
  ⚠ 3 条记录未走橙云代理
      这些记录直连源站，Cloudflare 的缓存/WAF/DDoS 防护全部失效：api(www)...
      修复：cfm dns proxy example.com --enable
  ✔ Brotli 已开
```

### 用法二：场景估算 —— 上生产前先算清楚

```console
$ cfm d1 explain mydb --sql "SELECT * FROM orders WHERE user_email = ?"
id │ parent │ notused │ detail
───┼────────┼─────────┼──────────────────────────────
2  │ 0      │ 0       │ SCAN orders

✘ 检测到全表扫描（SCAN 后无 USING INDEX）。这会按表的总行数消耗读额度。

建议
  为 WHERE / JOIN 条件涉及的列建索引：
  CREATE INDEX idx_orders_user_email ON orders(user_email);
  执行：cfm d1 query mydb --sql "CREATE INDEX ..."
```

### 用法三：批量加固 —— 一次改好几十个 zone

```bash
# 先看会改什么
cfm zone harden example.com --dry-run

# 确认后执行
cfm zone harden example.com --yes

# 需要 HSTS 时（不可逆，先用小 max_age 试水）
cfm zone harden example.com --with-hsts
```

---

## 免费额度速查

<details>
<summary><b>展开完整额度表</b>（或运行 <code>cfm quota</code>）</summary>

### Workers
| 项目 | 免费额度 |
| :--- | :--- |
| 请求数 | 100,000 / 天 |
| CPU 时间 | 10 ms / 请求 |
| 脚本大小 | 3 MiB（压缩后） |
| 脚本数量 | 100 |
| 子请求 | 50 / 次调用 |
| 环境变量 | 64 / Worker |
| Cron 触发器 | 5 / Worker |

### Workers KV
| 项目 | 免费额度 |
| :--- | :--- |
| 读 | 100,000 / 天 |
| **写** | **1,000 / 天** ← 最紧的一项 |
| 删除 | 1,000 / 天 |
| 列表 | 1,000 / 天 |
| 存储 | 1 GiB |
| 命名空间 | 1,000 |

### D1
| 项目 | 免费额度 |
| :--- | :--- |
| **扫描行数** | **5,000,000 / 天** ← 按扫描量，不是返回量 |
| 写入行数 | 100,000 / 天 |
| 存储 | 5 GB |
| 数据库数 | 10 |
| 单库大小 | 500 MB |

### R2
| 项目 | 免费额度 |
| :--- | :--- |
| 存储 | 10 GB-month |
| Class A（写/列表） | 1,000,000 / 月 |
| Class B（读） | 10,000,000 / 月 |
| **出站流量** | **免费，不限量** ← R2 最大卖点 |
| 桶数量 | 1,000 |

### Pages
| 项目 | 免费额度 |
| :--- | :--- |
| **构建次数** | **500 / 月** ← 高频提交会烧光 |
| 文件数 | 20,000 / 站 |
| 单文件大小 | 25 MiB |
| 自定义域 | 100 / 项目 |
| 静态带宽 | 不限量 |

### 其它
| 产品 | 免费额度 |
| :--- | :--- |
| Workers AI | 10,000 neurons / 天 |
| Durable Objects | 100,000 请求 / 天 |
| DNS 记录 | 200 / zone |
| 缓存清理 | 1,000 次调用 / 天 |
| 页面规则 | 5 条 / zone |
| Tunnel | 不限数量 |
| 免费 zone | 无硬上限 |

</details>

---

## 最容易踩的五个坑

### 1. KV 每天只有 1,000 次写

用 KV 做「每次请求都写」的计数器，1,000 个访客就把日额度打满，之后所有写返回 429。

**判断**：写入频率 < 1,000 次/天（配置缓存、特性开关）→ KV 合适。
计数器、日志、会话、用户状态 → **改用 D1**（10 万行/天）或 Durable Objects。

```bash
cfm kv budget <namespace-id> --per-request-writes 3 --daily-requests 5000
```

### 2. D1 按「扫描行数」计费，不是返回行数

免费额度 500 万行/天指的是**扫描**量。缺索引的 `SELECT * FROM t WHERE name = ?` 会全表扫描 —— 表有 10 万行时每次查询扣 10 万行，**50 次查询就打满当天额度**。

```bash
cfm d1 explain mydb --sql "SELECT ..."   # 检测全表扫描
cfm d1 index mydb                        # 索引健康度检查
```

### 3. Workers 单次调用最多 50 个子请求

循环里批量调第三方 API 会直接抛异常。需要批量时用 `Promise.all` 分批 + 限流，或拆成多个任务。

### 4. R2 的 Class A 只有 100 万次/月

频繁 `list` 对象来「检查是否存在」会快速消耗 Class A —— 改用 `head` 请求（算 Class B，额度 10 倍）。

### 5. Pages 每月 500 次构建

每次 git push 触发一次。高频提交的仓库一个月能烧光全部额度，之后构建全部失败。

```bash
cfm pages budget    # 按最近 30 天实际构建数算占用
```

省额度的办法：
- 提交信息加 `[skip ci]`，或配置 Build watch paths
- **纯静态站点改用 Workers Static Assets**（`wrangler deploy` 直接上传，不消耗构建额度）
- 本地构建后 Direct Upload

---

## 设计原则

### 1. 零依赖

不引入任何 npm 包（连 `dotenv`、`commander` 都自己写）。原因：CLI 工具碰的是你的**生产凭据**，供应链攻击面越小越好。

### 2. 只读优先，写操作必须显式确认

- `doctor` / `audit` / `usage` / `quota` **绝不修改任何东西**
- 所有写操作支持 `--dry-run` 先看计划
- 破坏性操作（删除、`--prune`、`--all` 清缓存）需要二次确认
- 非交互环境（CI）必须显式传 `--yes`，否则拒绝执行

### 3. 额度上限写进代码，而不是文档里

`src/lib/quota.mjs` 是唯一的额度来源。所以你能看到：

```console
$ cfm dns add example.com --type A --name x --content 1.2.3.4
✘ DNS 记录已达免费层上限 200 条，无法新增。请先清理无用记录。
```

而不是等到 API 返回 403 才知道。

### 4. 说清「为什么」，不只是「怎么做」

每条体检结论都附原因。比如为什么 SSL=Flexible 是问题：

> Flexible 意味着 Cloudflare→源站是明文。会导致重定向死循环，且源站流量未加密。这是最常见的「站点偶尔打不开」根因。

### 5. `--json` 可用于自动化

```bash
# 写进 cron，用量超 80% 就告警
cfm usage --json | jq -e '.workers.total < 80000' || notify-send "Workers 额度告警"
```

---

## 常见问题

<details>
<summary><b>会不会产生费用？</b></summary>

不会。本工具只调用 Cloudflare 的 API，**不做任何付费操作**，也不开通任何付费产品。

唯一的例外是 R2 超额：如果你存了超过 10GB，Cloudflare 会按 $0.015/GB 计费 —— 但这是你在控制台里发生的行为，不是本工具造成的。`cfm usage` 会显示占用百分比提醒你。

想彻底避免意外账单：控制台 → Billing → 设置支出上限，或干脆不开通付费。
</details>

<details>
<summary><b>和 wrangler 什么关系？</b></summary>

互补。**日常开发用 wrangler**（本地 dev、构建打包、tail 日志这些它更强）。

`cfm` 补的是 wrangler 不做的部分：**跨产品的额度监控**、**配置体检**、**批量运维**、**场景估算**。wrangler 是「部署工具」，cfm 是「运营视角」。
</details>

<details>
<summary><b>为什么 usage 某些项显示「采集失败」？</b></summary>

GraphQL Analytics API 需要额外权限，且**部分产品的用量指标有 1~5 分钟延迟**，新账号或零用量时也可能没有数据点。

如果某项一直失败：检查 Token 是否包含 `Account Analytics:Read`。不影响其它功能。
</details>

<details>
<summary><b>支持多个账号吗？</b></summary>

支持。设置 `CF_ACCOUNT_ID` 指定默认账号，或用 `--account <id>` 单次指定。

`cfm whoami` 会列出所有账号。如果不指定且有多个，涉及账号级的操作（R2/KV/D1/Pages）会明确报错而不是猜一个。
</details>

<details>
<summary><b>能读别人的账号吗？</b></summary>

不能，也不该。这个工具用的是你的 API Token，只能访问 Token 授权范围内的资源。

`doctor` 和 `audit` 这类只读命令同样需要你自己有权限 —— 提供的价值是「帮你看清楚自己的配置」，不是绕过权限。
</details>

---

## 开发

```bash
node --test test/unit.test.mjs test/ui.test.mjs   # 单元 + 交互模块
node scripts/lint.mjs                              # 静态检查
node scripts/ui-logic-test.mjs                     # 交互逻辑（纯函数层）
node scripts/ui-smoke.mjs                          # 真实终端冒烟（需 winpty/script）
npm run check                                      # lint + 单测 + 交互逻辑
```

项目结构：

```
bin/cfm.mjs              入口与命令路由（无参数 → 交互模式）
src/lib/cf.mjs           Cloudflare API 客户端（重试/分页/错误解释）
src/lib/quota.mjs        免费额度常量表（唯一来源）
src/lib/util.mjs         参数解析、表格、确认、dotenv
src/lib/prompt.mjs       交互引擎（纯函数层 + 终端层）
src/cmd/ui.mjs           交互式菜单树
src/cmd/*.mjs            各命令实现
scripts/lint.mjs         自研轻量 lint（import 符号核对、JSON/YAML、行尾）
scripts/ui-logic-test.mjs  交互逻辑测试（43 项）
scripts/ui-smoke.mjs     真实终端冒烟（27 项）
scripts/cf-quick-check.sh  零依赖 shell 版快查
test/unit.test.mjs       单元测试（25 个）
test/ui.test.mjs         交互模块测试（14 个）
test/e2e.test.mjs        端到端测试（需真实凭据，默认跳过）
```

### 交互功能为什么这样测

真实按键驱动需要 pty（Linux 用 `script`，Windows 用 winpty），CI 里难搭。
所以交互逻辑被抽成**纯函数**（`handleSelectKey` / `handleMultiSelectKey` /
`computeRedraw` / `renderSelect`），而 `select()` 内部调用的就是它们 ——
**测的就是实际运行的代码**，不是另写一份影子实现。

两层分工：

| 脚本 | 覆盖 | 何时跑 |
| :--- | :--- | :--- |
| `ui-logic-test.mjs` | 状态转移：方向键回绕、跳过禁用项、数字键索引换算、全选逻辑、重绘行数、菜单结构完整性 | CI（无需终端） |
| `ui-smoke.mjs` | ANSI 序列、光标控制、真实观感、无凭据守卫、Ctrl+C | 本地（需 pty） |

`ui-logic-test.mjs` 里有一条特别有用：**检查主菜单每一项都有对应的 switch 分支、
每个二级菜单都有返回项** —— 「加了菜单忘了写分支」这种 bug 只有用户点到才暴露，
测试能提前抓住。


### 跑真实 API 的端到端测试

默认跳过（防止误打生产）。要跑的话：

```bash
CFM_E2E=1 CF_API_TOKEN=xxx CF_ACCOUNT_ID=yyy node --test test/e2e.test.mjs
```

`test/e2e.test.mjs` 里**只有只读操作** —— 写操作的验证必须在有回滚预案的前提下由人手动做。

### lint 做了什么

除了常规的语法与行尾，还检查两类 `node --check` 抓不到的问题：

1. **import 的符号是否真的被导出**
   实测踩过：`usage.mjs` 导入了 `req_`（实际叫 `require_`），语法检查全绿，一跑就崩。
2. **JSON/YAML 合法性**
   实测踩过：`package.json` 开头写了 `#` 注释（JSON 不支持注释），整个文件解析不了，但 lint 只扫 `.mjs` 所以没发现。

---

## License

MIT
