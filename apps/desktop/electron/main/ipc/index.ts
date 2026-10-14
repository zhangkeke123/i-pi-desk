import type { AppContext } from '../context.js'
import { registerAgentIpc } from './agent-ipc.js'
import { registerAppIpc } from './app-ipc.js'
import { registerControlPlaneIpc } from './control-plane-ipc.js'
import { registerFsIpc } from './fs-ipc.js'
import { registerGitIpc } from './git-ipc.js'
import { registerPluginsIpc } from './plugins-ipc.js'
import { registerProviderIpc } from './provider-ipc.js'
import { registerSessionIpc } from './session-ipc.js'
import { registerScheduledTasksIpc } from './scheduled-tasks-ipc.js'
import { registerSettingsIpc } from './settings-ipc.js'
import { registerSkillsIpc } from './skills-ipc.js'
import { registerMcpIpc } from './mcp-ipc.js'
import { registerSubagentsIpc } from './subagents-ipc.js'
import { registerTerminalIpc } from './terminal-ipc.js'
import { registerWorkspaceIpc } from './workspace-ipc.js'
import { syncMcpRuntime } from '../store/mcp.js'
import { syncSubagentsRuntime } from '../store/subagents.js'

/** IPC 注册的唯一入口。新增一个域就在这里加一行。 */
export function registerAllIpc(ctx: AppContext): void {
  registerAppIpc(ctx)
  registerWorkspaceIpc(ctx)
  registerSessionIpc(ctx)
  registerAgentIpc(ctx)
  registerProviderIpc(ctx)
  registerSettingsIpc()
  registerScheduledTasksIpc()
  registerFsIpc()
  registerGitIpc()
  registerSkillsIpc()
  registerMcpIpc()
  registerSubagentsIpc()
  registerTerminalIpc(ctx)
  registerControlPlaneIpc()
  registerPluginsIpc(ctx)
  // 启动时把配置同步到 pi agentDir，避免首会话读到空 mcp.json / subagents.json。
  try {
    syncMcpRuntime()
    syncSubagentsRuntime()
  } catch {
    /* 启动期同步失败不阻断；设置页保存时会再写 */
  }
}
