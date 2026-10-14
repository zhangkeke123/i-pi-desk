import { IPC, type McpServerConfigView, type McpServerSaveInput } from '@i-pi-desk/shared'
import {
  listMcpServers,
  openMcpDir,
  removeMcpServer,
  saveMcpServer,
  setMcpEnabled,
  syncMcpRuntime
} from '../store/mcp.js'
import { arg, handle } from './wrap.js'

export function registerMcpIpc(): void {
  handle<McpServerConfigView[]>(IPC.invoke.mcpList, (_event, ...args) => {
    const workspaceId = typeof args[0] === 'string' ? args[0] : undefined
    return listMcpServers(workspaceId)
  })

  handle<McpServerConfigView>(IPC.invoke.mcpSave, (_event, ...args) => {
    const input = arg<McpServerSaveInput>(args, 0)
    if (!input) throw Object.assign(new Error('缺少 MCP 配置'), { code: 'MCP_INVALID' })
    return saveMcpServer(input)
  })

  handle<{ id: string }>(IPC.invoke.mcpRemove, (_event, ...args) => {
    const input = arg<{ id: string; scope: 'global' | 'project'; workspaceId?: string }>(args, 0)
    if (!input) throw Object.assign(new Error('缺少参数'), { code: 'MCP_INVALID' })
    return removeMcpServer(input)
  })

  handle<McpServerConfigView>(IPC.invoke.mcpSetEnabled, (_event, ...args) => {
    const input = arg<{
      id: string
      scope: 'global' | 'project'
      workspaceId?: string
      enabled: boolean
    }>(args, 0)
    if (!input) throw Object.assign(new Error('缺少参数'), { code: 'MCP_INVALID' })
    return setMcpEnabled(input)
  })

  handle<{ path: string }>(IPC.invoke.mcpOpenDir, () => openMcpDir())

  handle<{ path: string; count: number }>(IPC.invoke.mcpSyncRuntime, (_event, ...args) => {
    const workspaceId = typeof args[0] === 'string' ? args[0] : undefined
    return syncMcpRuntime(workspaceId)
  })
}
