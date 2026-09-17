#!/bin/bash
# 双击启动采集控制台（自动准备环境 + 打开浏览器）
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
  echo "首次运行：正在创建 Python 环境（约 1~2 分钟，请勿关闭窗口）…"
  python3 -m venv .venv || { echo "创建环境失败：需要 python3"; read -r; exit 1; }
fi
echo "正在检查依赖…"
.venv/bin/pip install -q --disable-pip-version-check -r requirements.txt -r requirements-ui.txt
echo "启动中，浏览器将自动打开（若未打开请手动访问提示的地址）；采集完成后可直接关闭本窗口。"
exec .venv/bin/python scripts/webapp.py
