# Agent 精通路线

这是一个帮助 React 高级开发者系统掌握 AI Agent 开发的学习网站，带进度追踪。学习计划分为 7 个阶段，按每周 8–10 小时估算，总周期约 5 个月。

## 功能

- **7 个学习阶段**：从建立直觉、从零手写 Agent，到 Agent 界面、上下文工程、评估、进阶架构，再到形成自己的方向。
- **任务清单**：勾选已完成的任务；侧边栏和首页会显示各阶段与总体进度。
- **代码骨架**：
  - 阶段 1：约 80 行的最小 coding agent；
  - 阶段 2：事件流 reducer，以及断线重连。
- **学习笔记**：每个阶段都有独立的笔记区。
- **精通标准**：用 5 条标准检查自己是否已经掌握。
- **进度备份**：数据只保存在浏览器的 localStorage 中，可以导出或导入 JSON。

## 运行

```sh
npm install
npm run dev      # 开发服务器
npm test         # 单元测试与组件测试
npm run build    # 类型检查并输出到 dist/
npm run lint
```

构建产物使用相对路径，可以部署到任意静态托管服务或子路径。

## 修改学习内容

所有学习内容都在 [src/data/roadmap.ts](src/data/roadmap.ts) 中，代码示例在 [src/data/snippets.ts](src/data/snippets.ts) 中。

进度数据以任务的 `id` 为键保存。修改任务时要保留原有 `id`，删除后的 `id` 也不要重复使用；否则用户已保存的进度会对应到错误的任务。

## 技术栈

Vite、React 19、TypeScript、Vitest、Testing Library 和 oxlint。项目不依赖路由库或状态管理库：hash 路由和进度存储都通过 `useSyncExternalStore` 实现。

## 许可证

MIT
