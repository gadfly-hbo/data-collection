#!/bin/bash
# 双击启动采集控制台（自动装依赖 + 打开浏览器）
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js（需 ≥22.5）：请先从 https://nodejs.org 安装，或运行 brew install node"
  read -r
  exit 1
fi
echo "正在安装依赖（首次约 1~2 分钟，请勿关闭窗口）…"
npm install --no-audit --no-fund
echo "启动中，浏览器将自动打开（若未打开请手动访问提示的地址）；采集完成后可直接关闭本窗口。"
exec node scripts/webapp.ts
