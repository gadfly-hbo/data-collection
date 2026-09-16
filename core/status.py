"""任务终态状态机：取值以 PLAN.md §5.5 为准，不新造同义词。

独立成模块供 pipeline / storage / dedup 共同引用，避免循环导入。
"""
from enum import Enum


class RunStatus(str, Enum):
    SUCCESS = "SUCCESS"
    FETCH_ERROR = "FETCH_ERROR"
    BLOCKED = "BLOCKED"
    SKIPPED_UNCHANGED = "SKIPPED_UNCHANGED"
    SKIPPED_NO_CONTENT = "SKIPPED_NO_CONTENT"
    SCHEMA_ERROR = "SCHEMA_ERROR"


# 消耗 LLM 调用的终态：预算统计与面板 Token 口径的唯一依据
BILLABLE_STATUSES = ("SUCCESS", "SCHEMA_ERROR")
