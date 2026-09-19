# Red-Team: 技术债偿还——webapp.ts/app.js 模块化拆分（行为不变）

## Top Kill-Assumptions

1. **Claim：拆分可以在不改变行为的前提下完成。**
   Fails if：全局函数/闭包状态在拆分后断裂（尤其 app.js 的内联 onclick → 全局函数依赖）。
   Cheapest test：拆分后 123 测试全绿 + Playwright 逐页截图对比 + `new Function()` 语法检查。

2. **Claim：无构建前端可以安全拆成多文件。**
   Fails if：浏览器 script 加载顺序/全局作用域出问题（module scope ≠ global scope）。
   Kill criterion：用多 `<script>` 标签顺序加载（非 ES module），保持全局作用域不变——内联 onclick 才能继续工作。
   Cheapest test：Playwright 加载首页 + 点三个场景卡 + chat 交互。

3. **Claim：值得现在拆。**
   Steelman：491 行 webapp.ts 每加一个路由都在恶化；659 行 app.js 每加一个页面也在恶化。下一轮功能（统计局 connector、品牌/企业报告 live）会让它们更难拆。现在拆成本最低。
   Verdict：成立。

## What's Well-Reasoned
- 纯重构，不改行为——123 项测试是回归网
- 文件已到临界点（每文件超 500 行即拆是行业共识）
- 前端用顺序 script 标签（非 module）保持全局作用域——inline onclick 不断

## Verdict: **GO**
