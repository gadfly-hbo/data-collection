"""正文抽取：trafilatura → Markdown；无正文返回 None（对应 SKIPPED_NO_CONTENT）。"""
import trafilatura


def extract_markdown(html: str, url: str | None = None) -> str | None:
    """从 HTML 抽取正文并转为 Markdown。

    空输入、纯导航/链接列表等无正文页面返回 None，由 pipeline 记为
    SKIPPED_NO_CONTENT，避免浪费 LLM 调用。
    """
    if not html or not html.strip():
        return None
    # favor_precision：宁缺毋滥——列表页/骨架页返回 None 而不是残留链接标签，
    # 由 pipeline 记 SKIPPED_NO_CONTENT 省下 LLM 调用
    return trafilatura.extract(
        html,
        url=url,
        output_format="markdown",
        include_comments=False,
        favor_precision=True,
    )
