import { join } from 'node:path'
import type { ScheduledTask } from '@i-pi-desk/shared'
import { getAppPaths } from '../paths.js'
import { readJson, writeJsonAtomic } from './json-store.js'

function tasksFile(): string {
  return join(getAppPaths().userData, 'scheduled-tasks.json')
}

function normalizeTask(raw: unknown): ScheduledTask | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = typeof o.id === 'string' ? o.id : ''
  const description = typeof o.description === 'string' ? o.description : ''
  const repeat = o.repeat
  const timeLocal = typeof o.timeLocal === 'string' ? o.timeLocal : ''
  const timezoneLabel = typeof o.timezoneLabel === 'string' ? o.timezoneLabel : '中国时间'
  const thinkingLevel = o.thinkingLevel
  const createdAt = typeof o.createdAt === 'string' ? o.createdAt : new Date().toISOString()

  if (!id || !description.trim()) return null
  if (repeat !== 'daily' && repeat !== 'weekdays' && repeat !== 'weekly' && repeat !== 'monthly') return null
  if (!/^\d{2}:\d{2}$/.test(timeLocal)) return null
  if (
    thinkingLevel !== 'off' &&
    thinkingLevel !== 'minimal' &&
    thinkingLevel !== 'low' &&
    thinkingLevel !== 'medium' &&
    thinkingLevel !== 'high' &&
    thinkingLevel !== 'xhigh' &&
    thinkingLevel !== 'max'
  ) {
    return null
  }

  const lastRunAt = typeof o.lastRunAt === 'string' && o.lastRunAt.trim() ? o.lastRunAt : undefined
  /** 旧数据无 enabled 字段时默认启用，避免列表全变成「已暂停」。 */
  const enabled = o.enabled === undefined ? true : Boolean(o.enabled)

  return {
    id,
    description,
    repeat,
    timeLocal,
    timezoneLabel,
    newChatEachRun: Boolean(o.newChatEachRun),
    providerId: typeof o.providerId === 'string' ? o.providerId : undefined,
    modelId: typeof o.modelId === 'string' ? o.modelId : undefined,
    thinkingLevel,
    createdAt,
    enabled,
    lastRunAt
  }
}

export function listScheduledTasks(): ScheduledTask[] {
  const raw = readJson<unknown>(tasksFile(), [])
  if (!Array.isArray(raw)) return []
  const out: ScheduledTask[] = []
  for (const item of raw) {
    const task = normalizeTask(item)
    if (task) out.push(task)
  }
  return out
}

export function saveScheduledTasks(tasks: ScheduledTask[]): ScheduledTask[] {
  const normalized = tasks.map((t) => normalizeTask(t)).filter((t): t is ScheduledTask => t !== null)
  writeJsonAtomic(tasksFile(), normalized)
  return normalized
}
