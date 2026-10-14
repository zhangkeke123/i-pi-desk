import { IPC, type Session, type SessionSnapshot } from '@i-pi-desk/shared'
import {
  createSession,
  deleteSession,
  duplicateSession,
  listSessions,
  loadSession,
  patchSession
} from '../store/sessions.js'
import type { AppContext } from '../context.js'
import { arg, handle, requireString } from './wrap.js'

export function registerSessionIpc(ctx: AppContext): void {
  handle<Session[]>(IPC.invoke.sessionList, () => listSessions())

  handle<Session>(IPC.invoke.sessionCreate, (_event, ...args) => {
    const input = arg<{ workspaceId: string; title?: string; providerId?: string; modelId?: string }>(args, 0) ?? {
      workspaceId: ''
    }
    const workspaceId = requireString(input.workspaceId, 'workspaceId')
    const session = createSession({
      workspaceId,
      title: input.title,
      providerId: input.providerId,
      modelId: input.modelId
    })
    ctx.broadcast(IPC.event.session, { type: 'created', session })
    return session
  })

  handle<SessionSnapshot>(IPC.invoke.sessionLoad, (_event, ...args) => {
    const id = requireString(args[0], 'sessionId')
    const snapshot = loadSession(id)
    if (!snapshot) {
      throw Object.assign(new Error(`会话不存在: ${id}`), { code: 'SESSION_NOT_FOUND' })
    }
    return snapshot
  })

  handle<Session>(IPC.invoke.sessionRename, (_event, ...args) => {
    const input = arg<{ id: string; title: string }>(args, 0) ?? { id: '', title: '' }
    const id = requireString(input.id, 'id')
    const title = requireString(input.title, 'title')
    const session = patchSession(id, { title })
    if (!session) {
      throw Object.assign(new Error(`会话不存在: ${id}`), { code: 'SESSION_NOT_FOUND' })
    }
    ctx.broadcast(IPC.event.session, { type: 'updated', session })
    return session
  })

  handle<Session>(IPC.invoke.sessionDuplicate, (_event, ...args) => {
    const id = requireString(args[0], 'sessionId')
    const session = duplicateSession(id)
    if (!session) {
      throw Object.assign(new Error(`会话不存在: ${id}`), { code: 'SESSION_NOT_FOUND' })
    }
    ctx.broadcast(IPC.event.session, { type: 'created', session })
    return session
  })

  /**
   * 置顶 / 取消置顶。
   *
   * 复用 patchSession（它会顺带更新 updatedAt）—— 但**置顶不该改变排序**：
   * 列表是按 updatedAt 倒序的，置顶靠的是单独一个分组（见 session-groups.ts 的 splitPinned），
   * 而不是靠改时间。这一点在单测里有断言。
   */
  handle<Session>(IPC.invoke.sessionSetPinned, (_event, ...args) => {
    const input = arg<{ id: string; pinned: boolean }>(args, 0) ?? { id: '', pinned: false }
    const id = requireString(input.id, 'id')
    const session = patchSession(id, { pinned: input.pinned === true })
    if (!session) {
      throw Object.assign(new Error(`会话不存在: ${id}`), { code: 'SESSION_NOT_FOUND' })
    }
    ctx.broadcast(IPC.event.session, { type: 'updated', session })
    return session
  })

  handle<Session>(IPC.invoke.sessionPatch, (_event, ...args) => {
    const input =
      arg<{ id: string; color?: string | null; runStatus?: Session['runStatus'] }>(args, 0) ?? {
        id: ''
      }
    const id = requireString(input.id, 'id')
    const patch: { runStatus?: Session['runStatus']; color?: string | null } = {}
    if (input.runStatus !== undefined) patch.runStatus = input.runStatus
    if (input.color === null) patch.color = null
    else if (typeof input.color === 'string') patch.color = input.color.trim() || null
    const session = patchSession(id, patch)
    if (!session) {
      throw Object.assign(new Error(`会话不存在: ${id}`), { code: 'SESSION_NOT_FOUND' })
    }
    ctx.broadcast(IPC.event.session, { type: 'updated', session })
    return session
  })

  handle<{ id: string }>(IPC.invoke.sessionDelete, (_event, ...args) => {
    const id = requireString(args[0], 'sessionId')

    // 先让 sidecar 释放内存里的会话，再删磁盘。顺序反了会留下一个「内存里还活着、
    // 磁盘上已消失」的会话，后续事件回来时无处落库。
    void ctx.supervisor.request('session.dispose', { sessionId: id }).catch(() => undefined)
    deleteSession(id)

    ctx.broadcast(IPC.event.session, { type: 'deleted', id })
    return { id }
  })
}
