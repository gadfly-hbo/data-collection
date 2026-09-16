#!/usr/bin/env bash
# 一键检查：安装依赖 → 全量测试（不含 live）→ 覆盖率报告
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
fi
.venv/bin/pip install -q --disable-pip-version-check -r requirements.txt
.venv/bin/pytest --cov=core --cov=storage --cov-report=term-missing
