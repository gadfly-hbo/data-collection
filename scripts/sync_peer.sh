#!/usr/bin/env bash
# 双端同步：先推送本端到 GitHub，再经 SSH 让对端 pull 到最新（mini ↔ MacBook）
# 用法：scripts/sync_peer.sh    （在任一端提交后运行）
set -euo pipefail
cd "$(dirname "$0")/.."

case "$(hostname)" in
  *Mac-mini*)  PEER_SSH="macbook"; PEER_DIR="/Users/huangbo/Dev/Projects/data-collection" ;;
  *MacBook*)   PEER_SSH="myhost";  PEER_DIR="/Users/bendandebaba/DevWorkSpace/Projects/data-collection" ;;
  *) echo "未知主机：$(hostname)，请在脚本中配置对端 SSH 别名与路径"; exit 1 ;;
esac

if ! git diff --cached --quiet || ! git diff --quiet; then
  echo "⚠ 有未提交的改动，请先 git commit"; exit 1
fi

git push
ssh -o BatchMode=yes "$PEER_SSH" "cd '$PEER_DIR' && git pull --ff-only"
echo "✅ 对端已同步：${PEER_SSH}（${PEER_DIR}）"
