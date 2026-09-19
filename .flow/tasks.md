# 任务拆解（技术债偿还）

- [x] 1. webapp.ts 拆分：scripts/routes/{sources,jobs,research,connectors,chat,export,overview}.ts + webapp.ts 只保留 app 组装/静态/调度
  - **Blocked by**: 无
  - **验收**: 123 测试全绿 + tsc 零错误 + webapp 启动正常
- [x] 2. app.js 拆分：web/js/{api,nav,chat,sources,research,data,overview,export}.js + index.html 多 script 标签顺序加载
  - **Blocked by**: 无
  - **验收**: Playwright 四页截图（总览/研究/数据源/对话）与拆分前一致 + 场景卡/待办链接跳转正常 + 0 控制台报错
