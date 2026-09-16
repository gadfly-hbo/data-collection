"""脚手架自检：配置文件可解析、顶层包可导入。"""
import pathlib

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]


def test_settings_yaml_parses():
    cfg = yaml.safe_load((ROOT / "config" / "settings.yaml").read_text())
    known = {"gemini", "anthropic-compat", "openai-compat"}
    assert cfg["provider"]["primary"] in known
    assert cfg["provider"]["fallback"] in known
    assert cfg["fetch"]["respect_robots"] is True
    assert cfg["budget"]["max_tasks_per_day"] > 0


def test_sources_yaml_parses():
    cfg = yaml.safe_load((ROOT / "config" / "sources.yaml").read_text())
    assert cfg["sources"], "至少保留一个采集来源示例"
    for src in cfg["sources"]:
        assert src["url"].startswith("http")
        assert src["interval_s"] > 0


def test_top_level_packages_importable():
    import core
    import core.providers
    import models
    import storage  # noqa: F401
