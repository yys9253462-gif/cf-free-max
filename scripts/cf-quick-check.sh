#!/usr/bin/env bash
#
# cf-quick-check.sh — 不依赖 Node 的最小额度检查
#
# 为什么有这个脚本：
#   主工具 cfm 需要 Node 18+。但在很多场景下（路由器、NAS、
#   刚装好的 VPS、只有 busybox 的容器）你只想快速看一眼额度，
#   不想为了这个装一个运行时。
#
#   这个脚本只用 bash + curl + 可选 jq，覆盖最要紧的三项检查：
#     Workers 请求、KV 写入、D1 扫描行 —— 也就是最容易撞墙的三个。
#
# 用法：
#   CF_API_TOKEN=xxx CF_ACCOUNT_ID=yyy ./cf-quick-check.sh
#   CF_API_TOKEN=xxx ./cf-quick-check.sh --zones      只列 zone
#
# 退出码：0 = 全部正常；1 = 有指标超过阈值；2 = 用法或环境错误
#
# 安全性：只读。不发送任何写请求。

set -euo pipefail

THRESHOLD="${THRESHOLD:-80}"
API="https://api.cloudflare.com/client/v4"

# ---------- 前置检查 ----------

die() { printf '\033[31m✘\033[0m %s\n' "$1" >&2; exit 2; }
ok()  { printf '\033[32m✔\033[0m %s\n' "$1"; }
warn(){ printf '\033[33m⚠\033[0m %s\n' "$1"; }
info(){ printf '\033[34mℹ\033[0m %s\n' "$1"; }

command -v curl >/dev/null 2>&1 || die "需要 curl"
HAVE_JQ=0
command -v jq >/dev/null 2>&1 && HAVE_JQ=1

[ -n "${CF_API_TOKEN:-}" ] || die "请设置 CF_API_TOKEN 环境变量"

if [ "$HAVE_JQ" -eq 0 ]; then
  warn "未检测到 jq，JSON 解析将用 grep 兜底（精度降低，建议装 jq）"
fi

# ---------- HTTP 封装 ----------
#
# 注意 set -e 的坑：命令替换里的管道，只要第一个命令非零退出
# （curl 网络失败时返回 6/7 等），pipefail 就会让整个赋值失败，
# set -e 直接中断脚本。所以这里必须显式兜底。

api_get() {
  local path="$1"
  local out
  out=$(curl -sS --max-time 20 \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H 'Content-Type: application/json' \
    "${API}${path}" 2>/dev/null) || {
    printf '{"success":false,"errors":[{"code":0,"message":"网络请求失败"}]}'
    return 0
  }
  printf '%s' "$out"
}

api_gql() {
  local body="$1"
  local out
  out=$(curl -sS --max-time 25 \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H 'Content-Type: application/json' \
    -d "$body" \
    "${API}/graphql" 2>/dev/null) || {
    printf '{"errors":[{"message":"网络请求失败"}]}'
    return 0
  }
  printf '%s' "$out"
}

# 从 JSON 里取标量值（有 jq 用 jq，没有则 grep 兜底）
jget() {
  local json="$1" path="$2" default="${3:-null}"
  if [ "$HAVE_JQ" -eq 1 ]; then
    printf '%s' "$json" | jq -r "${path} // \"${default}\"" 2>/dev/null || printf '%s' "$default"
  else
    # 兜底：取最后一个 key 的数值（粗略但够用）
    local key="${path##*.}"
    printf '%s' "$json" | grep -o "\"${key}\":[0-9]*" | head -1 | cut -d: -f2 || printf '%s' "$default"
  fi
}

# ---------- 检查 ----------

check_token() {
  local res
  res=$(api_get '/user/tokens/verify')
  if printf '%s' "$res" | grep -q '"success":true'; then
    ok "API Token 有效"
    return 0
  fi
  local msg
  msg=$(printf '%s' "$res" | sed -n 's/.*"message":"\([^"]*\)".*/\1/p' | head -1)
  die "API Token 无效：${msg:-未知错误}"
}

list_zones() {
  local res
  res=$(api_get '/zones?per_page=50')
  local count
  if [ "$HAVE_JQ" -eq 1 ]; then
    count=$(printf '%s' "$res" | jq -r '.result_info.total_count // 0')
    printf '%s' "$res" | jq -r '.result[]? | "  \(.name)  [\(.plan.name // "?")]  \(.status)"'
  else
    count=$(printf '%s' "$res" | grep -o '"total_count":[0-9]*' | cut -d: -f2)
    printf '%s' "$res" | grep -o '"name":"[^"]*"' | head -20 | cut -d'"' -f4 | sed 's/^/  /'
  fi
  info "共 ${count:-0} 个 zone"
}

# 额度进度条
meter() {
  local pct="$1"
  local filled=$(( pct / 5 ))
  [ "$filled" -gt 20 ] && filled=20
  local bar=""
  local i=0
  while [ "$i" -lt "$filled" ]; do bar="${bar}█"; i=$((i+1)); done
  while [ "$i" -lt 20 ]; do bar="${bar}░"; i=$((i+1)); done
  if [ "$pct" -ge 90 ]; then printf '\033[31m%s %s%%\033[0m' "$bar" "$pct"
  elif [ "$pct" -ge 70 ]; then printf '\033[33m%s %s%%\033[0m' "$bar" "$pct"
  else printf '\033[32m%s %s%%\033[0m' "$bar" "$pct"; fi
}

check_quota() {
  local account="$1"
  local alert=0

  local since until
  since=$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
          date -u -v-24H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '')
  until=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  if [ -z "$since" ]; then
    warn "系统 date 命令不支持相对时间，跳过用量采集"
    return 0
  fi

  printf '\n%-24s %12s %12s  %s\n' "指标" "已用" "上限" "占用"
  printf '%s\n' "────────────────────────────────────────────────────────────────"

  # Workers
  local wq wjson wreq wpct
  wq="{ \"query\": \"query(\\\$a:String!,\\\$s:Time!,\\\$u:Time!){viewer{accounts(filter:{accountTag:\\\"\\\$a\\\"}){workersInvocationsAdaptive(limit:100,filter:{datetime_geq:\\\"\\\$s\\\",datetime_leq:\\\"\\\$u\\\"}){sum{requests}}}}}\", \"variables\": {\"a\":\"${account}\",\"s\":\"${since}\",\"u\":\"${until}\"} }"
  wjson=$(api_gql "$wq")

  if [ "$HAVE_JQ" -eq 1 ]; then
    wreq=$(printf '%s' "$wjson" | jq -r '[.data.viewer.accounts[0].workersInvocationsAdaptive[]?.sum.requests] | add // 0' 2>/dev/null || echo 0)
  else
    wreq=$(printf '%s' "$wjson" | grep -o '"requests":[0-9]*' | cut -d: -f2 | awk '{s+=$1} END {print s+0}')
  fi
  wreq=${wreq:-0}
  wpct=$(( wreq * 100 / 100000 ))
  printf '%-24s %12s %12s  %s\n' "Workers 请求 (24h)" "$wreq" "100000" "$(meter "$wpct")"
  [ "$wpct" -ge "$THRESHOLD" ] && alert=1

  # KV
  local kq kjson kr kw kpct
  kq="{ \"query\": \"query(\\\$a:String!,\\\$s:Time!,\\\$u:Time!){viewer{accounts(filter:{accountTag:\\\"\\\$a\\\"}){kvOperationsAdaptiveGroups(limit:100,filter:{datetime_geq:\\\"\\\$s\\\",datetime_leq:\\\"\\\$u\\\"}){sum{requests} dimensions{actionType}}}}}\", \"variables\": {\"a\":\"${account}\",\"s\":\"${since}\",\"u\":\"${until}\"} }"
  kjson=$(api_gql "$kq")

  if [ "$HAVE_JQ" -eq 1 ]; then
    kr=$(printf '%s' "$kjson" | jq -r '[.data.viewer.accounts[0].kvOperationsAdaptiveGroups[]? | select(.dimensions.actionType | test("read";"i")) | .sum.requests] | add // 0' 2>/dev/null || echo 0)
    kw=$(printf '%s' "$kjson" | jq -r '[.data.viewer.accounts[0].kvOperationsAdaptiveGroups[]? | select(.dimensions.actionType | test("write";"i")) | .sum.requests] | add // 0' 2>/dev/null || echo 0)
  else
    kr=0; kw=0
  fi
  kr=${kr:-0}; kw=${kw:-0}

  kpct=$(( kr * 100 / 100000 ))
  printf '%-24s %12s %12s  %s\n' "KV 读 (24h)" "$kr" "100000" "$(meter "$kpct")"
  [ "$kpct" -ge "$THRESHOLD" ] && alert=1

  local kwpct=$(( kw * 100 / 1000 ))
  printf '%-24s %12s %12s  %s\n' "KV 写 (24h)" "$kw" "1000" "$(meter "$kwpct")"
  [ "$kwpct" -ge "$THRESHOLD" ] && alert=1

  # D1
  local dq djson dr dw dpct
  dq="{ \"query\": \"query(\\\$a:String!,\\\$s:Time!,\\\$u:Time!){viewer{accounts(filter:{accountTag:\\\"\\\$a\\\"}){d1AnalyticsAdaptiveGroups(limit:100,filter:{datetime_geq:\\\"\\\$s\\\",datetime_leq:\\\"\\\$u\\\"}){sum{rowsRead rowsWritten}}}}}\", \"variables\": {\"a\":\"${account}\",\"s\":\"${since}\",\"u\":\"${until}\"} }"
  djson=$(api_gql "$dq")

  if [ "$HAVE_JQ" -eq 1 ]; then
    dr=$(printf '%s' "$djson" | jq -r '[.data.viewer.accounts[0].d1AnalyticsAdaptiveGroups[]?.sum.rowsRead] | add // 0' 2>/dev/null || echo 0)
  else
    dr=0
  fi
  dr=${dr:-0}
  dpct=$(( dr * 100 / 5000000 ))
  printf '%-24s %12s %12s  %s\n' "D1 扫描行 (24h)" "$dr" "5000000" "$(meter "$dpct")"
  [ "$dpct" -ge "$THRESHOLD" ] && alert=1

  printf '\n'
  if [ "$alert" -eq 1 ]; then
    warn "有指标超过 ${THRESHOLD}% 告警线"
    printf '  建议：\n'
    printf '    KV 写超限     → 改用 D1，或跑 cfm kv budget <ns> 做场景估算\n'
    printf '    D1 扫描行超限 → 跑 cfm d1 explain <db> --sql "..." 检查索引\n'
    printf '    Workers 超限  → 检查是否有循环调用或爬虫\n'
    return 1
  fi
  ok "全部指标低于 ${THRESHOLD}% 告警线"
  return 0
}

# ---------- 主流程 ----------

main() {
  printf '\n\033[1mCloudflare 免费额度快查\033[0m  %s\n\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  check_token

  if [ "${1:-}" = "--zones" ]; then
    printf '\n'
    list_zones
    printf '\n'
    info "提示：完整功能（体检/审计/批量操作）需要 Node 18+，见 README"
    exit 0
  fi

  local account="${CF_ACCOUNT_ID:-}"
  if [ -z "$account" ]; then
    local ares
    ares=$(api_get '/accounts?per_page=5')
    if [ "$HAVE_JQ" -eq 1 ]; then
      account=$(printf '%s' "$ares" | jq -r '.result[0].id // ""')
      local aname
      aname=$(printf '%s' "$ares" | jq -r '.result[0].name // ""')
      local n
      n=$(printf '%s' "$ares" | jq -r '.result | length')
      if [ "$n" -gt 1 ]; then
        warn "有多个账号，请用 CF_ACCOUNT_ID 指定，否则只检查第一个（${aname}）"
      fi
    fi
  fi

  if [ -z "$account" ]; then
    die "无法确定账号 ID，请设置 CF_ACCOUNT_ID"
  fi

  info "账号：${account}"
  check_quota "$account"
}

main "$@"
