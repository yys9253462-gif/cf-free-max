#!/usr/bin/env bash
#
# 跨 Node 版本运行测试。
#
# 为什么需要这个脚本：
#   Node 21+ 支持 `node --test "test/**/*.test.mjs"` 这种 glob 展开，
#   Node 18/20 **不支持** —— 会把 glob 当成字面路径，报
#   "Could not find '.../test/**/*.test.mjs'"。
#   实测踩过：本地 Node 24 全绿，CI 上 Node 18/20 直接失败。
#
# 这里显式列举文件，任何版本都能跑。

set -euo pipefail

cd "$(dirname "$0")/.."

FILES=()
while IFS= read -r f; do
  FILES+=("$f")
done < <(find test -name '*.test.mjs' -type f | sort)

if [ ${#FILES[@]} -eq 0 ]; then
  echo "没有找到测试文件" >&2
  exit 1
fi

echo "运行 ${#FILES[@]} 个测试文件："
printf '  %s\n' "${FILES[@]}"
echo

exec node --test "${FILES[@]}"
