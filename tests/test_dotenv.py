"""core/dotenv 加载器测试。"""
import os

from core.dotenv import load_dotenv


def test_load_dotenv_parses_and_keeps_existing(tmp_path, monkeypatch):
    monkeypatch.setenv("DOTENV_TEST_EXISTING", "keep")
    env = tmp_path / ".env"
    env.write_text(
        "DOTENV_TEST_A=1\n"
        "# 注释行\n"
        "DOTENV_TEST_EXISTING=override\n"
        'DOTENV_TEST_B="quoted"\n'
        "\n"
        "无等号的坏行\n",
        encoding="utf-8",
    )
    load_dotenv(env)
    assert os.environ.get("DOTENV_TEST_A") == "1"
    assert os.environ.get("DOTENV_TEST_EXISTING") == "keep"  # 已存在优先
    assert os.environ.get("DOTENV_TEST_B") == "quoted"
    for name in ("DOTENV_TEST_A", "DOTENV_TEST_EXISTING", "DOTENV_TEST_B"):
        monkeypatch.delenv(name, raising=False)


def test_load_dotenv_missing_file_is_noop(tmp_path):
    load_dotenv(tmp_path / "no-such-file.env")  # 不抛异常即可
