# 一键部署站点到 Cloudflare Pages

`cfm deploy` 把「clone → 构建 → 部署」三步合成一条命令，支持多个站点。

---

## 快速开始

```bash
cfm deploy --list           # 1. 看配置和当前状态（只读，建议先跑）
cfm deploy --check          # 2. 环境体检（Node / git / wrangler / 认证）
cfm deploy --dry-run        # 3. 预演，看会执行什么
cfm deploy                  # 4. 真正执行
```

只处理某一个：

```bash
cfm deploy --only blog
cfm deploy --only blog,nav  # 逗号分隔
```

---

## 🔒 受保护的站点

**这是最重要的一节。**

正在对外服务的站点（比如网盘）必须防止被误覆盖。配置里加 `protected: true` 即可：

```json
{
  "id": "pan",
  "label": "网盘",
  "repo": "your-netdisk-repo",
  "project": "your-netdisk-pages",
  "domain": "pan.example.com",
  "protected": true,
  "protectedReason": "该网盘正在正常服务，切勿重新部署覆盖。"
}
```

标记之后有三道拦截：

| 场景 | 行为 |
| :--- | :--- |
| `cfm deploy`（全部） | 该站点**自动排除**，连待处理列表都不进 |
| `cfm deploy --only pan` | **拒绝执行**，退出码 3，并提示原因 |
| `cfm deploy --include-protected` | 仍然要求**逐站二次确认** |

要真的重新部署受保护站点，必须同时给出两个显式参数：

```bash
cfm deploy --only pan --include-protected --yes
```

**但正常情况下你不需要这么做。** 想看它的状态，用只读命令：

```bash
cfm deploy --check-online
```

这会用 GET 请求访问线上域名，确认服务正常，**不碰任何代码、不发任何写请求**：

```
id    │ 名称     │ 域名          │ 访问状态          │
───────┼──────────┼───────────────┼───────────────────┤
blog  │ 静态博客 │ blog.example.com  │ HTTP 200 52.78 KB │
nav   │ 静态导航 │ nav.example.com   │ HTTP 200 4.47 KB  │
🔒 pan │ 网盘     │ pan.example.com   │ HTTP 200 2.67 KB  │

其中 1 个是受保护站点（pan）：只做线上巡检，不参与部署。
```

---

## 配置文件

`config/sites.json`：

```json
{
  "repoOwner": "your-github-username",
  "workspace": "",
  "sites": [
    {
      "id": "blog",
      "label": "静态博客",
      "repo": "fuwari",
      "project": "fuwari-blog",
      "domain": "blog.example.com",
      "type": "build",
      "buildCommand": "npm run build",
      "outputDir": "dist",
      "branch": "main",
      "bindings": [],
      "patches": ["disable-rss-route", "disable-sitemap", "tolerate-partial-build"]
    }
  ]
}
```

### 字段说明

| 字段 | 必填 | 说明 |
| :--- | :--- | :--- |
| `id` | ✅ | 命令行里用的短名（`--only blog`） |
| `label` | | 显示名 |
| `repo` | ✅ | GitHub 仓库名（不含 owner） |
| `project` | ✅ | Cloudflare Pages 项目名 |
| `domain` | | 自定义域名，用于显示和线上检查 |
| `type` | | `build`（需构建）或 `static`（纯静态）。默认 `static` |
| `buildCommand` | build 类型必填 | 如 `npm run build` |
| `outputDir` | ✅ | 构建产物目录，相对仓库根。纯静态站点通常填 `.` |
| `branch` | | 默认 `main` |
| `bindings` | | D1 / R2 / KV 绑定，部署前会检查是否存在 |
| `patches` | | 构建补丁，见下节 |
| `protected` | | 🔒 只读保护，见上节 |

### 工作区

`workspace` 留空时，仓库会 clone 到 `<项目目录>/.sites/`。
想放到别处就填绝对路径，例如 `"workspace": "D:\\sites"`。

---

## 构建补丁

上游依赖经常有版本兼容问题。这类问题不该让你手动改源码 ——
**手工改的东西下次 clone 就没了**。

所以把「为了能构建成功必须做的调整」写成声明式补丁，每次部署前自动应用：

```json
"patches": ["disable-rss-route", "disable-sitemap"]
```

### 可用补丁

| 补丁 | 做什么 | 什么时候用 |
| :--- | :--- | :--- |
| `disable-rss-route` | 把 RSS 路由文件移出仓库 | `@astrojs/rss` 与 `zod 4` 不兼容，构建 RSS 时崩溃 |
| `disable-sitemap` | 从 astro.config 注释掉 sitemap 集成 | `@astrojs/sitemap` 在 `astro:build:done` 钩子崩溃 |
| `skip-astro-check` | 从 build 脚本去掉 `astro check` | 类型检查失败但代码能跑 |
| `tolerate-partial-build` | 构建报错但产物完整时继续部署 | 某个路由崩了但其他页面都好 |

应用补丁时会在原文件旁留 `.cfm-backup` 备份；补丁是**幂等**的，重复运行不会出错。

### `tolerate-partial-build` 的判据

它不会盲目忽略错误。只有当产物满足这些条件才继续：

- 输出目录里有根级 `index.html`
- 文件数 ≥ 5

否则照常报失败。这样「完全没有构建成功」和「99% 成功只有一页崩了」能被区分开。

---

## 常见问题

### 部署会消耗 Pages 每月 500 次的构建额度吗？

**不会。** 脚本用的是 Direct Upload（`wrangler pages deploy`），
本地构建好后直接上传产物，不经过 Cloudflare 的构建系统。

### 会覆盖我现有的站点吗？

- 非保护站点：会更新同名的 Pages 项目部署。这是预期行为。
- **保护站点：不会。** 三道拦截保证它不被误碰。

如果你不希望任何站点被自动更新，把 `protected: true` 加到那个站点上。

### clone 失败 / 私有仓库

私有仓库需要凭据，三选一：

```bash
gh auth login                              # 用 GitHub CLI
# 或配置 SSH 后改仓库地址为 git@github.com:...
# 或在环境变量里设置 GITHUB_TOKEN
```

### 依赖装不上

先换镜像源：

```bash
npm config set registry https://registry.npmmirror.com
pnpm config set registry https://registry.npmmirror.com
```

慢网络下首次安装可能要十几分钟，脚本给了 30 分钟超时。
如果还是失败，可以手动在 `.sites/<repo>` 里装好，然后用 `--skip clone` 复用。

### 部署报 401 / 权限不足

Token 需要 `Account | Cloudflare Pages | Edit` 权限。

或者用浏览器登录（不需要 Token）：

```bash
npx wrangler login
```

### 自定义域名什么时候生效？

部署完成后 DNS 通常几分钟内生效，证书签发可能要更久。
脚本默认**不自动访问线上域名**（避免每次部署都打生产），
需要验证时手动加 `--verify`。

---

## 命令参考

```
cfm deploy [选项]

模式
  --list                 列出配置与本地状态（只读）
  --check                环境体检
  --check-online         线上状态巡检（只读，含受保护站点）
  --list-bindings        列出账号下的 D1 / R2 资源（填配置用）
  --dry-run              预演，不实际执行

范围
  --only <id,...>        只处理指定站点
  --steps <a,b>          只跑指定步骤（clone / build / deploy）
  --skip <a,b>           跳过指定步骤

安全
  --include-protected    允许操作受保护站点（仍需二次确认）
  --skip-binding-check   跳过 D1/R2 存在性检查
  --continue             某个站点失败后继续处理后面的
  --no-patches           不应用构建补丁
  --no-verify            部署后不验证
  --verify               部署后验证（默认关闭）

认证
  --token <token>        API Token（或环境变量 CLOUDFLARE_API_TOKEN）
  --account <id>         账号 ID（或环境变量 CLOUDFLARE_ACCOUNT_ID）

通用
  --yes, -y              跳过确认
  --verbose              打印详细日志
```
