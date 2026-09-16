"""LLM 文本响应中的 JSON 提取工具（Anthropic / OpenAI 兼容层共用）。"""
from __future__ import annotations


def strip_code_fence(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        first_line_break = text.find("\n")
        if first_line_break != -1:  # 掉落 ```json 等语言标记行
            text = text[first_line_break + 1:]
        if text.rstrip().endswith("```"):
            text = text.rstrip()[:-3]
    return text.strip()


def extract_json_object(text: str) -> str:
    """提取第一个完整的最外层 JSON 对象（感知字符串内的花括号与转义）。

    兼容模型在 JSON 前后偶发附加说明文字的情况；无花括号时原样返回。
    """
    start = text.find("{")
    if start == -1:
        return text
    depth, in_string, escape = 0, False, False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
        elif ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return text[start:]
