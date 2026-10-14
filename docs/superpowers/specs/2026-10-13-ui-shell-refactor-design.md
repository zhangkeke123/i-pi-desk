# i-pi-desk UI 壳层重构设计（v3）

> 状态：已对齐需求，进入实现。日期：2026-10-13。  
> 主参考：Codex 结构（图标轨 + 会话栏 + 大输入）+ Pi-Desktop 运行态（深色、步骤流、进度）+ Pi 右侧审查栏。

## 目标

**左 Codex / 右 PI-desktop**：聊天流与任务流融合。  
左侧：图标轨 + 新聊天/项目/最近 + 空状态「我们要构建什么？」+ Composer（选择项目 / 随心输入）。  
右侧：PI 工作台枢纽「新建」→ 审阅(Git) / 浏览器(项目搜索) / 文件管理器。  
本期布局固定；拖拽停靠下期。

## 壳

```
IconRail(48) | SessionPane(~260) | MainStage | RightInspector(~300, 可折叠)
                                   + 底栏 Terminal（按需）
                                   + ComposerCard 悬浮
```

- **多工作区**：SessionPane「项目」列其它仓。
- **多 git**：工作区可为父目录（如 a3-lib）；右栏扫描子 `.git`（深度上限、跳过 node_modules）；Git Tab 按选中 root 显示 status + 只读 diff。
- **文件树 / 搜索**：覆盖整个工作区根。
- **Diff 两层**：对话内审批 = agent 拟改；右栏 Git = 工作区已改。

## Composer

悬浮卡片：工作区行 · 输入 · `+` / 权限 / 思考 / 模型 / 进度环 / 停止|发送。

## 时间线

用户消息 + agent 回合卡（正文 + 可折叠工具步骤 + 耗时/工具数）。审批内嵌。长会话仍 40 条窗口。

## 非目标（本期）

- 面板自由拖拽；Git stage/commit；跨仓一键提交；浅色 Codex 主题为主（保留现有主题切换）。

## 实现边界

- Renderer 不碰 fs；pi-* 仅 agent-host。
- 新增 IPC：`git.discover` / `git.status` / `git.diff` / `fs.search`（均 workspaceId + 相对路径约束）。
- 改完跑 `pnpm typecheck`；动 UI 后 `verify:renderer`；装包冒烟。
