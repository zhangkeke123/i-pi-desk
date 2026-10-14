import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SubagentDefinition, SubagentSaveInput, SubagentToolProfile } from '@i-pi-desk/shared'
import { getAppPaths } from '../paths.js'
import { readJson, writeJsonAtomic } from './json-store.js'
import { piAgentDir } from './pi-config.js'

/**
 * 子智能体定义：内置预设 + 用户自定义。
 * 运行时由 agent-host 读同一份文件（经 sidecar 启动参数 / 环境），或主进程在 prompt 前写入 pi-agent。
 */

const BUILTINS: Array<Omit<SubagentDefinition, 'updatedAt'>> = [
  {
    id: 'builtin-explorer',
    name: '探路者',
    description: '只读探索代码库结构、定位文件与符号，不做修改。',
    systemPrompt:
      '你是探路者子智能体。只使用只读工具了解代码库，总结结构与关键路径。不要修改任何文件，不要执行写操作。',
    tools: 'readonly',
    enabled: true,
    builtin: true
  },
  {
    id: 'builtin-reviewer',
    name: '代码审查',
    description: '审查变更风险、风格与潜在 bug，给出可执行建议。',
    systemPrompt:
      '你是代码审查子智能体。聚焦正确性、安全与可维护性。用简洁条目列出问题与建议，区分阻断项与建议项。',
    tools: 'readonly',
    enabled: true,
    builtin: true
  },
  {
    id: 'builtin-implementer',
    name: '实现助手',
    description: '在明确任务下改代码、跑命令，保持改动最小。',
    systemPrompt:
      '你是实现助手子智能体。按任务最小改动完成实现，改完说明触及的文件与如何验证。',
    tools: 'full',
    enabled: false,
    builtin: true
  }
]

interface StoreFile {
  custom: SubagentDefinition[]
  /** 内置项的启用覆盖 */
  builtinEnabled: Record<string, boolean>
}

function storePath(): string {
  return join(getAppPaths().userData, 'subagents.json')
}

function load(): StoreFile {
  const raw = readJson<StoreFile>(storePath(), { custom: [], builtinEnabled: {} })
  return {
    custom: Array.isArray(raw.custom) ? raw.custom : [],
    builtinEnabled: raw.builtinEnabled && typeof raw.builtinEnabled === 'object' ? raw.builtinEnabled : {}
  }
}

function persist(data: StoreFile): void {
  writeJsonAtomic(storePath(), data)
}

function nowIso(): string {
  return new Date().toISOString()
}

export function listSubagents(): SubagentDefinition[] {
  const data = load()
  const builtins: SubagentDefinition[] = BUILTINS.map((item) => ({
    ...item,
    enabled: data.builtinEnabled[item.id] ?? item.enabled,
    updatedAt: nowIso()
  }))
  return [...builtins, ...data.custom].sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1
    return a.name.localeCompare(b.name, 'zh')
  })
}

export function listEnabledSubagents(): SubagentDefinition[] {
  return listSubagents().filter((s) => s.enabled)
}

export function saveSubagent(input: SubagentSaveInput): SubagentDefinition {
  const name = input.name.trim()
  if (!name) throw Object.assign(new Error('名称不能为空'), { code: 'SUBAGENT_INVALID_NAME' })
  const data = load()
  const tools: SubagentToolProfile = input.tools ?? 'readonly'
  if (input.id && BUILTINS.some((b) => b.id === input.id)) {
    throw Object.assign(new Error('内置子智能体请用开关，不能改定义'), { code: 'SUBAGENT_BUILTIN' })
  }
  const id = input.id?.trim() || `custom-${randomUUID().slice(0, 8)}`
  const existing = data.custom.findIndex((s) => s.id === id)
  const next: SubagentDefinition = {
    id,
    name,
    description: input.description.trim() || name,
    systemPrompt: input.systemPrompt.trim() || `你是「${name}」子智能体，专注完成委派任务。`,
    tools,
    enabled: input.enabled !== false,
    builtin: false,
    updatedAt: nowIso()
  }
  if (existing === -1) data.custom.push(next)
  else data.custom[existing] = next
  persist(data)
  return next
}

export function removeSubagent(id: string): { id: string } {
  if (BUILTINS.some((b) => b.id === id)) {
    throw Object.assign(new Error('内置子智能体不能删除，可关闭'), { code: 'SUBAGENT_BUILTIN' })
  }
  const data = load()
  data.custom = data.custom.filter((s) => s.id !== id)
  persist(data)
  return { id }
}

export function setSubagentEnabled(id: string, enabled: boolean): SubagentDefinition {
  const data = load()
  const builtin = BUILTINS.find((b) => b.id === id)
  if (builtin) {
    data.builtinEnabled[id] = enabled
    persist(data)
    return { ...builtin, enabled, updatedAt: nowIso() }
  }
  const index = data.custom.findIndex((s) => s.id === id)
  if (index === -1) {
    throw Object.assign(new Error(`子智能体不存在: ${id}`), { code: 'SUBAGENT_NOT_FOUND' })
  }
  data.custom[index] = { ...data.custom[index], enabled, updatedAt: nowIso() }
  persist(data)
  return data.custom[index]
}

/** 写入 pi-agent 目录，供 sidecar 读取启用列表。 */
export function syncSubagentsRuntime(): { path: string; count: number } {
  const dir = piAgentDir()
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'subagents.json')
  const enabled = listEnabledSubagents()
  writeFileSync(path, JSON.stringify({ subagents: enabled }, null, 2), 'utf8')
  return { path, count: enabled.length }
}
