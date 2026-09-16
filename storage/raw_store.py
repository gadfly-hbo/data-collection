"""原始快照存储：SHA-256 内容哈希寻址，防篡改、同内容天然去重。"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path


class RawStore:
    """快照按 {sha256}.md 落盘：同内容幂等（文件已存在即跳过写入）。"""

    def __init__(self, root: str | Path = "data/raw"):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def content_hash(content: str) -> str:
        return hashlib.sha256(content.encode("utf-8")).hexdigest()

    def save(self, content: str) -> str:
        """写入快照并返回内容哈希；tmp + os.replace 原子落盘，
        进程中断不会留下同名截断文件破坏 exists() 幂等语义。"""
        digest = self.content_hash(content)
        path = self.path(digest)
        if not path.exists():
            tmp = path.with_suffix(".tmp")
            tmp.write_text(content, encoding="utf-8")
            os.replace(tmp, path)
        return digest

    def path(self, content_hash: str) -> Path:
        return self.root / f"{content_hash}.md"

    def exists(self, content_hash: str) -> bool:
        return self.path(content_hash).exists()

    def read(self, content_hash: str) -> str:
        return self.path(content_hash).read_text(encoding="utf-8")
