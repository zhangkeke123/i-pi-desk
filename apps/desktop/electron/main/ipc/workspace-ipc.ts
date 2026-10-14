import { IPC, type Workspace, type WorkspaceFacts } from '@i-pi-desk/shared'
import { listWorkspaces, openWorkspace, removeWorkspace, setWorkspaceColor } from '../store/workspaces.js'
import { inspectWorkspace } from '../store/workspace-facts.js'
import { syncMcpRuntime } from '../store/mcp.js'
import type { AppContext } from '../context.js'
import { arg, handle, requireString } from './wrap.js'

export function registerWorkspaceIpc(ctx: AppContext): void {
  handle<Workspace[]>(IPC.invoke.workspaceList, () => listWorkspaces())

  handle<Workspace>(IPC.invoke.workspaceOpen, (_event, ...args) => {
    const path = requireString(args[0], 'path')
    const workspace = openWorkspace(path)
    if (!workspace) {
      // 目录不存在 / 不是目录：这是用户会遇到的常见情况（选了被删掉的目录），
      // 必须给出可读信息而不是一个 fs 的 ENOENT 堆栈。
      throw Object.assign(new Error(`无法打开目录（不存在或不是目录）: ${path}`), {
        code: 'WORKSPACE_NOT_FOUND'
      })
    }
    /**
     * 广播「工作区已打开」。
     *
     * ⚠️ 当前渲染层**不订阅**这个事件：它打开工作区后会自己再拉一次
     * `workspace.list()`（见 store 的 `openWorkspace`）。保留这条广播是因为
     * 多窗口场景下它才有意义，但别指望现在的界面会因此自动刷新。
     */
    ctx.broadcast(IPC.event.workspace, { type: 'opened', workspace })
    try {
      syncMcpRuntime(workspace.id)
    } catch {
      /* 合并项目级 MCP 失败不阻断打开目录 */
    }
    return workspace
  })

  /**
   * 工作区事实：一次问清，供空状态生成起手任务。
   *
   * 用路径而不是 id：事实是关于**目录**的，而目录可能在列表被清掉之后仍然开着。
   * 失败一律返回已知的部分（见 store/workspace-facts.ts 的 catch），
   * 因此这里不设错误码 —— 空状态会退回通用起手任务。
   */
  handle<WorkspaceFacts>(IPC.invoke.workspaceFacts, (_event, ...args) => {
    const path = requireString(args[0], 'path')
    return inspectWorkspace(path)
  })

  handle<{ id: string }>(IPC.invoke.workspaceRemove, (_event, ...args) => {
    const id = requireString(args[0], 'id')
    removeWorkspace(id)
    return { id }
  })

  handle<Workspace>(IPC.invoke.workspaceSetColor, (_event, ...args) => {
    const input = arg<{ id: string; color?: string }>(args, 0) ?? { id: '' }
    const id = requireString(input.id, 'id')
    const workspace = setWorkspaceColor(id, input.color)
    if (!workspace) {
      throw Object.assign(new Error(`工作区不存在: ${id}`), { code: 'WORKSPACE_NOT_FOUND' })
    }
    ctx.broadcast(IPC.event.workspace, { type: 'updated', workspace })
    return workspace
  })
}
