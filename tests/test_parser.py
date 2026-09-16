"""T1.4：正文抽取 Parser 验收测试。"""
import pathlib

from core.parser import extract_markdown

FIXTURES = pathlib.Path(__file__).parent / "fixtures"


def _fixture(name: str) -> str:
    return (FIXTURES / name).read_text()


def test_article_extracts_markdown_and_strips_noise():
    md = extract_markdown(_fixture("article.html"), url="https://example.test/a/1")
    assert md, "正文型页面必须抽出非空 Markdown"
    assert "量子纠错" in md
    # 导航、评论、页脚噪声被剥离
    assert "沙发" not in md
    assert "首页" not in md
    assert "保留所有权利" not in md


def test_link_list_page_returns_none():
    assert extract_markdown(_fixture("link_list.html")) is None


def test_empty_input_returns_none():
    assert extract_markdown("") is None
    assert extract_markdown("   \n  ") is None
