"""LLM Provider 抽象：core/ 其余代码只依赖本协议（AGENTS.md 硬性规则）。

Provider SDK（google-genai / openai）只允许出现在 core/providers/ 内。
"""
from dataclasses import dataclass
from typing import Generic, Protocol, TypeVar, runtime_checkable

from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)


class TransientProviderError(Exception):
    """供应商侧可重试的瞬态错误（429 / 5xx / 网络抖动），由退避层处理。"""


@dataclass
class ExtractionResult(Generic[T]):
    """单次语义提取的产出：强类型对象 + Token 用量（台账与预算熔断依赖）。"""

    item: T
    input_tokens: int
    output_tokens: int
    provider: str
    model: str


@runtime_checkable
class LLMProvider(Protocol):
    """供应商可替换性的边界：输入正文与 Pydantic 模型，返回强类型结果。"""

    name: str

    async def extract(
        self, content: str, schema: type[T], *, instruction: str = ""
    ) -> ExtractionResult[T]: ...
