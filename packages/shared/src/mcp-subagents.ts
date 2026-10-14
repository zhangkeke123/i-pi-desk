/**
 * MCP 服务器与子智能体的共享契约（设置页 + 主进程落盘）。
 */

/** MCP 暴露方式：与 pi 的 exposure 对齐；产品默认 direct，便于模型直接调用。 */
export type McpExposureMode = 'direct' | 'codemode' | 'deferred' | 'hidden'

export type McpTransportKind = 'stdio' | 'http'

export interface McpServerConfigView {
  /** 稳定 id（也是 mcpServers 里的 key / 服务器名） */
  id: string
  label: string
  scope: 'global' | 'project'
  /** 项目级时绑定的 workspaceId；全局为空 */
  workspaceId?: string
  enabled: boolean
  exposure: McpExposureMode
  transport: McpTransportKind
  /** stdio */
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** http */
  url?: string
  headers?: Record<string, string>
  description?: string
  updatedAt: string
}

export interface McpServerSaveInput {
  id: string
  label?: string
  scope: 'global' | 'project'
  workspaceId?: string
  enabled?: boolean
  exposure?: McpExposureMode
  transport: McpTransportKind
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  description?: string
}

export type SubagentToolProfile = 'readonly' | 'full' | 'none'

export interface SubagentDefinition {
  id: string
  name: string
  description: string
  /** 系统提示补充 */
  systemPrompt: string
  /** 工具档：只读 / 全量 / 不给工具（纯推理） */
  tools: SubagentToolProfile
  enabled: boolean
  /** 内置预设不可删，可关 */
  builtin: boolean
  updatedAt: string
}

export interface SubagentSaveInput {
  id?: string
  name: string
  description: string
  systemPrompt: string
  tools?: SubagentToolProfile
  enabled?: boolean
}
