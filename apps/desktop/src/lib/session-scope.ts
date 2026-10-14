import type { Session } from '@i-pi-desk/shared'

/**
 * 一个工作区里的会话。
 *
 * ## 为什么需要这个（它修的是一个会把活干错目录的缺陷）
 *
 * 会话带 `workspaceId`，而**跑起来时用的目录就是会话自带的那个**（主进程
 * `resolveRunContext` 按 `session.workspaceId` 解析 cwd）。这是对的 ——
 * 一个会话应当始终属于它开始时的那个目录。
 *
 * 但界面这边原本不是这么组织的：会话列表来自 `session.list()`，那是**所有工作区**的会话；
 * 而切换工作区只换了 `currentWorkspace`，**没有动 `currentSessionId`**。于是：
 *
 *   - 切到目录 B 之后，聊天区还显示着 A 的对话；
 *   - 用户在里面敲一句「把那个函数改一下」，`sendPrompt` 用的仍是 A 的会话 ——
 *     **agent 在 A 里干活，而界面（标题、文件树）显示的是 B**；
 *   - 侧栏还会把 A 的会话列为可点，点一下就是同一个错位。
 *
 * 也就是说：**目录是界面的主语，会话必须服从它**。所以凡是「要挑一个会话来用」的地方
 * （启动时自动选中、删掉当前会话后选下一个、切工作区之后重新选），
 * 都先过一遍这个函数。
 */
export function sessionsInWorkspace(sessions: Session[], workspaceId: string | undefined): Session[] {
  // 没有工作区就一个都不算 —— 此时任何会话都不该被选中（agent 没有可用的 cwd）。
  if (!workspaceId) return []
  return sessions.filter((session) => session.workspaceId === workspaceId)
}

/**
 * 在该工作区里挑一个「当前会话」。
 *
 * 约定：`sessions` 已经按 `updatedAt` 倒序（主进程 `listSessions()` 的排序），
 * 所以取第一条就是最近用过的那个。空列表返回 `undefined`，
 * 调用方应当把选中状态**清空**而不是留一个别的目录的会话。
 */
export function pickActiveSession(sessions: Session[], workspaceId: string | undefined): Session | undefined {
  return sessionsInWorkspace(sessions, workspaceId)[0]
}
