import { join } from 'node:path'
import { shell } from 'electron'
import type { McpServerConfigView, McpServerSaveInput } from '@i-pi-desk/shared'
import { getAppPaths } from '../paths.js'
import { ensureDir, readJson, writeJsonAtomic } from './json-store.js'
import { piAgentDir } from './pi-config.js'

/**
 * MCP 配置：应用侧权威在 userData，运行时同步一份到 `<piAgentDir>/mcp.json`
 * 供 createMcpExtension 默认加载（projectTrusted=false 时不会读仓库里的 .pi/mcp.json）。
 */

interface McpStoreFile {
  global: McpServerConfigView[]
  /** workspaceId → 项目级服务器 */
  projects: Record<string, McpServerConfigView[]>
}

function storePath(): string {
  return join(getAppPaths().userData, 'mcp-servers.json')
}

function emptyStore(): McpStoreFile {
  return { global: [], projects: {} }
}

function load(): McpStoreFile {
  const raw = readJson<McpStoreFile>(storePath(), emptyStore())
  return {
    global: Array.isArray(raw.global) ? raw.global : [],
    projects: raw.projects && typeof raw.projects === 'object' ? raw.projects : {}
  }
}

function persist(data: McpStoreFile): void {
  writeJsonAtomic(storePath(), data)
}

function nowIso(): string {
  return new Date().toISOString()
}

function normalizeId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

function toPiServerConfig(server: McpServerConfigView): Record<string, unknown> {
  const base: Record<string, unknown> = {
    enabled: server.enabled !== false,
    exposure: server.exposure || 'direct'
  }
  if (server.description) base.description = server.description
  if (server.transport === 'http') {
    base.url = server.url
    if (server.headers && Object.keys(server.headers).length > 0) base.headers = server.headers
    return base
  }
  base.command = server.command
  if (server.args?.length) base.args = server.args
  if (server.env && Object.keys(server.env).length > 0) base.env = server.env
  return base
}

/** 合并全局 + 指定项目，写到 pi agentDir/mcp.json。 */
export function syncMcpRuntime(workspaceId?: string): { path: string; count: number } {
  const data = load()
  const merged = new Map<string, McpServerConfigView>()
  for (const server of data.global) merged.set(server.id, server)
  if (workspaceId) {
    for (const server of data.projects[workspaceId] ?? []) merged.set(server.id, server)
  }
  const mcpServers: Record<string, unknown> = {}
  for (const server of merged.values()) {
    if (!server.id) continue
    mcpServers[server.id] = toPiServerConfig(server)
  }
  const agentDir = piAgentDir()
  ensureDir(agentDir)
  const path = join(agentDir, 'mcp.json')
  writeJsonAtomic(path, { mcpServers })
  return { path, count: Object.keys(mcpServers).length }
}

export function listMcpServers(workspaceId?: string): McpServerConfigView[] {
  const data = load()
  const list = [...data.global]
  if (workspaceId) list.push(...(data.projects[workspaceId] ?? []))
  return list.sort((a, b) => a.id.localeCompare(b.id))
}

export function saveMcpServer(input: McpServerSaveInput): McpServerConfigView {
  const id = normalizeId(input.id)
  if (!id) throw Object.assign(new Error('服务器名不能为空'), { code: 'MCP_INVALID_ID' })
  if (input.transport === 'stdio' && !input.command?.trim()) {
    throw Object.assign(new Error('stdio 服务器必须填写 command'), { code: 'MCP_INVALID_COMMAND' })
  }
  if (input.transport === 'http' && !input.url?.trim()) {
    throw Object.assign(new Error('http 服务器必须填写 url'), { code: 'MCP_INVALID_URL' })
  }
  if (input.scope === 'project' && !input.workspaceId?.trim()) {
    throw Object.assign(new Error('项目级 MCP 需要当前工作区'), { code: 'MCP_NEED_WORKSPACE' })
  }

  const data = load()
  const bucket =
    input.scope === 'project'
      ? (data.projects[input.workspaceId!] ??= [])
      : data.global
  const existing = bucket.findIndex((s) => s.id === id)
  const next: McpServerConfigView = {
    id,
    label: (input.label ?? id).trim() || id,
    scope: input.scope,
    workspaceId: input.scope === 'project' ? input.workspaceId : undefined,
    enabled: input.enabled !== false,
    exposure: input.exposure ?? 'direct',
    transport: input.transport,
    command: input.command?.trim(),
    args: input.args?.map((a) => a.trim()).filter(Boolean),
    env: input.env,
    url: input.url?.trim(),
    headers: input.headers,
    description: input.description?.trim(),
    updatedAt: nowIso()
  }
  if (existing === -1) bucket.push(next)
  else bucket[existing] = next
  persist(data)
  syncMcpRuntime(input.workspaceId)
  return next
}

export function removeMcpServer(input: {
  id: string
  scope: 'global' | 'project'
  workspaceId?: string
}): { id: string } {
  const data = load()
  const id = normalizeId(input.id)
  if (input.scope === 'project') {
    const wid = input.workspaceId?.trim()
    if (!wid) throw Object.assign(new Error('缺少 workspaceId'), { code: 'MCP_NEED_WORKSPACE' })
    data.projects[wid] = (data.projects[wid] ?? []).filter((s) => s.id !== id)
  } else {
    data.global = data.global.filter((s) => s.id !== id)
  }
  persist(data)
  syncMcpRuntime(input.workspaceId)
  return { id }
}

export function setMcpEnabled(input: {
  id: string
  scope: 'global' | 'project'
  workspaceId?: string
  enabled: boolean
}): McpServerConfigView {
  const data = load()
  const id = normalizeId(input.id)
  const bucket =
    input.scope === 'project'
      ? (data.projects[input.workspaceId ?? ''] ?? [])
      : data.global
  const index = bucket.findIndex((s) => s.id === id)
  if (index === -1) {
    throw Object.assign(new Error(`MCP 服务器不存在: ${id}`), { code: 'MCP_NOT_FOUND' })
  }
  bucket[index] = { ...bucket[index], enabled: input.enabled, updatedAt: nowIso() }
  persist(data)
  syncMcpRuntime(input.workspaceId)
  return bucket[index]
}

export function openMcpDir(): { path: string } {
  const dir = join(getAppPaths().userData)
  ensureDir(dir)
  void shell.openPath(dir)
  return { path: dir }
}
