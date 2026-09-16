"""极简 .env 加载器：把 KEY=VALUE 注入 os.environ（已存在的环境变量优先）。

凭证只允许经环境变量/.env 进入程序（AGENTS.md 硬性规则），.env 已被 .gitignore 排除。
"""
from __future__ import annotations

import os
from pathlib import Path


def load_dotenv(path: str | Path = ".env") -> None:
    p = Path(path)
    if not p.exists():
        return
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value
