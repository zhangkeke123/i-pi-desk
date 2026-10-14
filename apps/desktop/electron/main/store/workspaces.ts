import { randomUUID } from 'node:crypto'
import { basename, resolve } from 'node:path'
import { statSync } from 'node:fs'
import type { Workspace } from '@i-pi-desk/shared'
import { getAppPaths } from '../paths.js'
import { readJson, writeJsonAtomic } from './json-store.js'
import { hideWorkspace, upsertWorkspace, visibleWorkspaces } from './workspace-list.js'

/**
 * 工作区 = 一个被 agent 操作的代码目录。
 *
 * 这里保留一份列表只是为了「最近打开」；真正的路径合法性校验在每次使用时重做，
 * 因为目录随时可能被用户删掉或改名。
 *
 * **规则**（按路径复用同一条记录、「移除」只隐藏不删除）都在 `workspace-list.ts` 里，
 * 并且有单测 —— 因为那条规则一旦改坏，后果是**丢对话**（见那个文件头的说明）。
 */

let cache: Workspace[] | null = null

function load(): Workspace[] {
  if (cache) return cache
  const raw = readJson<Workspace[]>(getAppPaths().workspaces, [])
  cache = Array.isArray(raw) ? raw : []
  return cache
}

function persist(): void {
  if (!cache) return
  writeJsonAtomic(getAppPaths().workspaces, cache)
}

/** 给界面看的最近目录：藏起来的不返回。 */
export function listWorkspaces(): Workspace[] {
  return visibleWorkspaces(load())
}

/**
 * 打开一个目录并加入最近列表。
 * 返回 null 表示路径不存在或不是目录 —— 调用方负责报错，这里不抛。
 */
export function openWorkspace(inputPath: string): Workspace | null {
  const path = resolve(inputPath)
  try {
    if (!statSync(path).isDirectory()) return null
  } catch {
    return null
  }

  const result = upsertWorkspace(load(), {
    path,
    name: basename(path) || path,
    now: new Date().toISOString(),
    newId: randomUUID()
  })
  cache = result.list
  persist()
  return result.workspace
}

/**
 * 从最近列表里**移除**（实现上是隐藏，不是删除）。
 *
 * 为什么不是 `splice`：删掉记录就丢了 id→路径 的对应关系，
 * 而会话是用 `workspaceId` 关联目录的 —— 那个目录下的对话会**永远变成孤儿**
 * （还在磁盘上，但界面按当前工作区过滤，再也看不到）。
 * 「从列表移除」只是整理列表，不该有丢数据的后果。
 */
export function removeWorkspace(id: string): void {
  const result = hideWorkspace(load(), id)
  if (!result.changed) return
  cache = result.list
  persist()
}

/**
 * 按 id 取记录 —— **包含藏起来的**。
 *
 * 这一条很关键：隐藏只是「不显示」，会话解析 cwd 时仍然要能按 id 找到它
 * （否则隐藏一个目录会让它下面的会话立刻报「工作区已不存在」）。
 */
export function getWorkspace(id: string): Workspace | undefined {
  return load().find((workspace) => workspace.id === id)
}

/** 写入侧栏项目色；`color` 为空则清除。 */
export function setWorkspaceColor(id: string, color?: string): Workspace | null {
  const list = load()
  const index = list.findIndex((workspace) => workspace.id === id)
  if (index === -1) return null
  const next = { ...list[index] }
  if (color?.trim()) next.color = color.trim()
  else delete next.color
  list[index] = next
  cache = [...list]
  persist()
  return next
}
