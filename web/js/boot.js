/* 启动初始化 */
setInterval(() => {
  if ($("#page-runs").classList.contains("active")) refreshRuns();
}, 15000);

loadSchemas()
  .then(() => { refreshOverview(); refreshSources(); refreshConnectors(); refreshCustomJobs(); })
  .catch((e) => console.error("初始化失败：", e));
