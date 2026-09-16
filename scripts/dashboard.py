"""监控面板：streamlit run scripts/dashboard.py

状态监控 / 数据查询只读（mode=ro 连接）；来源管理的写入收敛在 sources 表
（T5.2：单一事实源），采集数据保持只读。
"""
from __future__ import annotations

import pathlib
import sqlite3
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from core.dotenv import load_dotenv

load_dotenv()

import pandas as pd  # noqa: E402
import streamlit as st  # noqa: E402

from models.registry import SCHEMA_REGISTRY  # noqa: E402
from storage.db import MIN_INTERVAL_S, Database  # noqa: E402
from storage.queries import (blocked_sources, connect_ro, daily_tokens,  # noqa: E402
                             list_sources_with_last_run, query_items,
                             status_summary)

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
DB_PATH = REPO_ROOT / "data" / "collector.db"


def _render_monitor() -> None:
    conn = connect_ro(DB_PATH)
    try:
        summary = status_summary(conn)
        c1, c2, c3, c4 = st.columns(4)
        c1.metric("总任务数", summary["total"])
        c2.metric("成功率", f"{summary['success_rate']:.0%}")
        c3.metric("今日 LLM 任务", summary["today_tasks"])
        c4.metric("今日 input tokens", f"{summary['today_input_tokens']:,}")

        st.subheader("状态分布")
        st.bar_chart(pd.Series(summary["by_status"], name="任务数"))

        st.subheader("Token 消耗趋势（按天，仅计 LLM 任务）")
        daily = pd.DataFrame([dict(r) for r in daily_tokens(conn, days=30)])
        if not daily.empty:
            st.line_chart(daily.set_index("day")[["input_tokens", "output_tokens"]])
        else:
            st.caption("暂无数据")

        st.subheader("被封锁来源（最近）")
        blocked = pd.DataFrame([dict(r) for r in blocked_sources(conn)])
        if blocked.empty:
            st.caption("暂无 BLOCKED 记录")
        else:
            st.dataframe(blocked, use_container_width=True)
    finally:
        conn.close()


def _render_query() -> None:
    conn = connect_ro(DB_PATH)
    try:
        c1, c2, c3 = st.columns(3)
        schema_choice = c1.selectbox("Schema 类型", ["（全部）"] + sorted(SCHEMA_REGISTRY))
        keyword = c2.text_input("关键词（内容 / URL）")
        limit = c3.slider("条数上限", 50, 1000, 200, step=50)
        c4, c5 = st.columns(2)
        since = c4.date_input("起始日期", value=None)
        until = c5.date_input("结束日期", value=None)

        rows, total = query_items(
            conn,
            schema_type=None if schema_choice.startswith("（") else schema_choice,
            keyword=keyword or None,
            since=since.isoformat() if since else None,
            until=until.isoformat() if until else None,
            limit=limit)
        st.caption(f"匹配 {total} 条，显示前 {len(rows)} 条")
        if not rows:
            st.info("无匹配数据")
            return

        st.dataframe(
            pd.DataFrame([{**{k: v for k, v in r.items() if k != "item"},
                           "title": r["item"].get("title")
                           or r["item"].get("headline") or ""}
                          for r in rows]),
            use_container_width=True)
        for r in rows:
            title = r["item"].get("title") or r["item"].get("headline") \
                or r["source_url"]
            with st.expander(f"#{r['id']}  {title}"):
                st.json(r["item"], expanded=True)
    finally:
        conn.close()


def _render_sources() -> None:
    st.caption("配置写入仅限 sources 表（单一事实源）；守护进程在下一个 tick "
               f"（默认 30s）内生效。调度间隔下限 {MIN_INTERVAL_S}s。")
    db = Database(DB_PATH)
    try:
        sources = list_sources_with_last_run(db.conn)
        st.dataframe(pd.DataFrame([dict(r) for r in sources]),
                     use_container_width=True)

        st.subheader("新增 / 更新来源")
        with st.form("source_form"):
            url = st.text_input("URL（已存在则更新）")
            name = st.text_input("名称（可选）")
            schema_type = st.selectbox("Schema 类型", sorted(SCHEMA_REGISTRY))
            interval_s = st.number_input(f"采集间隔（秒，≥ {MIN_INTERVAL_S}）",
                                         min_value=MIN_INTERVAL_S, value=3600,
                                         step=60)
            use_browser = st.checkbox("使用浏览器渲染（JS 渲染站点，需已装 playwright）")
            instruction = st.text_input("附加提取指令（可选）")
            enabled = st.checkbox("启用", value=True)
            submitted = st.form_submit_button("保存")
        if submitted:
            try:
                db.upsert_source(url=url.strip(), schema_type=schema_type,
                                 name=name or None, interval_s=int(interval_s),
                                 enabled=enabled, use_browser=use_browser,
                                 instruction=instruction)
                st.success(f"已保存：{url}")
                st.rerun()
            except ValueError as e:
                st.error(str(e))

        st.subheader("启停 / 删除")
        if not sources:
            st.caption("暂无来源")
            return
        sid = int(st.selectbox("选择来源 ID", [str(r["id"]) for r in sources]))
        row = next(r for r in sources if r["id"] == sid)
        col1, col2 = st.columns(2)
        if col1.button("停用" if row["enabled"] else "启用"):
            db.upsert_source(url=row["url"], schema_type=row["schema_type"],
                             name=row["name"], interval_s=row["interval_s"],
                             enabled=not row["enabled"],
                             use_browser=bool(row["use_browser"]),
                             instruction=row["instruction"])
            st.rerun()
        if col2.button("删除"):
            try:
                db.delete_source(sid)
                st.success("已删除")
                st.rerun()
            except sqlite3.IntegrityError:
                st.error("该来源存在关联台账，不可删除（已保持原状；如需停止采集请改用「停用」）")
    finally:
        db.close()


def main() -> None:
    st.set_page_config(page_title="采集监控", page_icon="🕸️", layout="wide")
    st.title("智能数据采集监控")
    if not DB_PATH.exists():
        st.warning(f"数据库不存在：{DB_PATH}——先运行 run_once 或 import_sources")
        st.stop()
    tab_monitor, tab_query, tab_sources = st.tabs(
        ["状态监控", "数据查询", "来源管理"])
    with tab_monitor:
        _render_monitor()
    with tab_query:
        _render_query()
    with tab_sources:
        _render_sources()


if __name__ == "__main__":
    main()
