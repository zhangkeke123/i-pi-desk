import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage, Session, SessionSnapshot } from '@i-pi-desk/shared'
import { getAppPaths } from '../paths.js'
import { ensureDir, readJson, writeJsonAtomic } from './json-store.js'

/**
 * 会话持久化：一个会话一个 JSON 文件。
 *
 * 为什么「一文件一会话」而不是「全塞一个文件」：
 *  - 写一条消息只重写一个会话，不会因为会话变多而让每次写入越来越慢；
 *  - 单个文件写坏只损失一个会话，不会全丢。
 *
 * 列表用「扫目录 + 读每个文件的元数据」。会话数量在单机场景下是几十到几百，
 * 这个成本可以忽略；换来的是没有索引文件与实体文件不一致的问题。
 */

interface SessionFile {
  session: Session
  messages: ChatMessage[]
}

function sessionsDir(): string {
  return getAppPaths().sessionsDir
}

function sessionFile(id: string): string {
  return join(sessionsDir(), `${id}.json`)
}

function readSessionFile(id: string): SessionFile | null {
  const file = sessionFile(id)
  if (!existsSync(file)) return null
  const data = readJson<SessionFile | null>(file, null)
  if (!data?.session) return null
  return { session: data.session, messages: Array.isArray(data.messages) ? data.messages : [] }
}

function writeSessionFile(data: SessionFile): void {
  writeJsonAtomic(sessionFile(data.session.id), data)
}

export function listSessions(): Session[] {
  const dir = sessionsDir()
  if (!existsSync(dir)) return []

  const sessions: Session[] = []
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue
    const data = readJson<SessionFile | null>(join(dir, entry), null)
    if (data?.session) sessions.push(data.session)
  }

  // 最近更新的排前面。
  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function createSession(input: {
  workspaceId: string
  title?: string
  providerId?: string
  modelId?: string
}): Session {
  ensureDir(sessionsDir())
  const now = new Date().toISOString()
  const session: Session = {
    id: randomUUID(),
    workspaceId: input.workspaceId,
    title: input.title?.trim() || '新会话',
    createdAt: now,
    updatedAt: now,
    providerId: input.providerId,
    modelId: input.modelId,
    messageCount: 0,
    runStatus: 'new'
  }
  writeSessionFile({ session, messages: [] })
  return session
}

export function loadSession(id: string): SessionSnapshot | null {
  const data = readSessionFile(id)
  return data ? { session: data.session, messages: data.messages } : null
}

/**
 * 复制会话：新 id、同工作区、消息一并拷贝；标题加「副本」，不继承置顶。
 */
export function duplicateSession(id: string): Session | null {
  const data = readSessionFile(id)
  if (!data) return null
  const now = new Date().toISOString()
  const baseTitle = data.session.title.trim() || '新会话'
  const session: Session = {
    ...data.session,
    id: randomUUID(),
    title: `${baseTitle} 副本`,
    createdAt: now,
    updatedAt: now,
    pinned: false,
    messageCount: data.messages.length,
    runStatus: data.messages.length > 0 ? data.session.runStatus ?? 'done' : 'new'
  }
  writeSessionFile({ session, messages: data.messages })
  return session
}

export function patchSession(
  id: string,
  patch: Omit<Partial<Omit<Session, 'id'>>, 'color'> & { color?: string | null }
): Session | null {
  const data = readSessionFile(id)
  if (!data) return null
  const { color: colorPatch, ...rest } = patch
  const next: Session = {
    ...data.session,
    ...rest,
    id: data.session.id,
    updatedAt: new Date().toISOString()
  }
  // `color: null` 表示清除自定义色（JSON 里删掉字段）。
  if (colorPatch === null) delete next.color
  else if (typeof colorPatch === 'string') next.color = colorPatch
  data.session = next
  writeSessionFile(data)
  return data.session
}

export function appendMessage(sessionId: string, message: ChatMessage): Session | null {
  const data = readSessionFile(sessionId)
  if (!data) return null

  // 幂等：同 id 的消息重复到达（例如 sidecar 重连后重放）时覆盖而不是追加。
  const index = data.messages.findIndex((m) => m.id === message.id)
  if (index === -1) data.messages.push(message)
  else data.messages[index] = message

  data.session = {
    ...data.session,
    messageCount: data.messages.length,
    updatedAt: new Date().toISOString(),
    // 首条用户消息兼作标题，省得让用户手动命名。
    title:
      data.session.title === '新会话' && message.role === 'user'
        ? deriveTitle(message)
        : data.session.title
  }
  writeSessionFile(data)
  return data.session
}

export function replaceMessages(sessionId: string, messages: ChatMessage[]): Session | null {
  const data = readSessionFile(sessionId)
  if (!data) return null
  data.messages = messages
  data.session = { ...data.session, messageCount: messages.length, updatedAt: new Date().toISOString() }
  writeSessionFile(data)
  return data.session
}

/**
 * 把一次工具调用的最终状态回写到**已落盘的那条消息**里。
 *
 * ## 为什么需要它
 *
 * 内核在工具**执行之前**就定稿了带 `tool-call` part 的那条 assistant 消息
 * （`message.committed`），而工具结果是在之后才产生的。结果到达时，渲染层把内存里的
 * live 状态更新了，落盘的那份却没人管 —— 于是**重启之后，界面上那次调用永远停在
 * 「调用中」，也看不到结果**。用户会以为它还卡着，而实际上早就跑完了。
 *
 * 这是「一条消息有两个写入方」的又一例（§5.5）：消息本体在定稿时写一次，
 * 工具结果在之后写一次，第二次之前根本不存在。
 *
 * 匹配靠 `callId`：同一条消息里可能串行挂着多个工具调用。
 */
export function patchToolCallInSession(
  sessionId: string,
  callId: string,
  patch: { state: string; result?: unknown; error?: string; finishedAt?: string }
): Session | null {
  const data = readSessionFile(sessionId)
  if (!data) return null

  let touched = false
  for (const message of data.messages) {
    for (const part of message.parts) {
      if (part.kind !== 'tool-call' || part.callId !== callId) continue
      Object.assign(part, patch)
      touched = true
    }
  }
  // 没找到就什么都不写：这不是错误（例如结果在重启后才到达），
  // 但**也不能顺手把文件重写一遍**，那只会白白改动 updatedAt。
  if (!touched) return null

  writeSessionFile(data)
  return data.session
}

export function deleteSession(id: string): boolean {
  const file = sessionFile(id)
  if (!existsSync(file)) return false
  rmSync(file, { force: true })
  return true
}

function deriveTitle(message: ChatMessage): string {
  const text = message.parts
    .map((part) => (part.kind === 'text' ? part.text : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return '新会话'
  return text.length > 24 ? `${text.slice(0, 24)}…` : text
}
