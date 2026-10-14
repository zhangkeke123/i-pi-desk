import type { BrowserWindow } from 'electron'
import { IPC } from '@i-pi-desk/shared'
import { log } from './logger.js'
import { decideClose, type CloseDecision } from './close-guard.js'

/**
 * 关窗拦截的**有状态**那一半（纯规则在 `close-guard.ts`）。
 *
 * 做成模块级单例而不是往 `AppContext` 里再塞一个字段：关窗是**进程级**的事，
 * 一个主进程只有一个窗口需要管（macOS 上会重建窗口，`attach` 覆盖即可）。
 */
export interface CloseGuardHost {
  /** 渲染层上报「编辑器里有没有未保存的改动」。 */
  setDirty(dirty: boolean): void
  /** 用户确认「不保存并退出」：这一次真的关。 */
  confirmQuit(): boolean
  /** 把某个窗口纳入拦截（每次 `createMainWindow()` 都要调）。 */
  attach(window: BrowserWindow): void
  /** 供自测/日志查看当前状态。 */
  snapshot(): { dirty: boolean; confirmed: boolean; askCount: number }
}

export function createCloseGuardHost(): CloseGuardHost {
  let dirty = false
  let confirmed = false
  let askedAt: number | null = null
  let askCount = 0
  let window: BrowserWindow | null = null

  /** 真正的决定点：纯函数说了算，这里只负责副作用。 */
  const onCloseAttempt = (event: { preventDefault: () => void }, target: BrowserWindow): void => {
    const decision: CloseDecision = decideClose({ dirty, confirmed, askedAt, now: Date.now() })

    if (decision === 'force-close') {
      /**
       * 兜底放行。走到这里说明渲染层一直没回音（卡住/崩溃）。
       * **宁可丢掉一次未保存的改动，也不能让窗口关不掉。**
       */
      log(`[close-guard] 问过但 ${Math.round((Date.now() - (askedAt ?? 0)) / 1000)}s 没有回应，放行关窗`)
      return
    }
    if (decision === 'close') return

    event.preventDefault()
    askedAt = Date.now()
    askCount += 1
    log(`[close-guard] 编辑器有未保存改动，已拦下关窗并询问（第 ${askCount} 次）`)
    try {
      target.webContents.send(IPC.event.closeRequested)
    } catch (error) {
      // 连通知都发不出去（webContents 已销毁）：不能把用户关在应用里，直接放行。
      log(`[close-guard] 通知渲染层失败，放行关窗：${String(error)}`)
      dirty = false
      confirmed = true
      target.close()
    }
  }

  return {
    setDirty(next: boolean): void {
      if (dirty === next) return
      dirty = next
      /**
       * 状态回到「干净」（例如用户保存了）时，上一次的询问记录要清掉 ——
       * 否则下一次关窗会因为「超时」而直接放行，把询问跳过去。
       */
      if (!next) askedAt = null
    },

    confirmQuit(): boolean {
      confirmed = true
      const target = window
      if (!target || target.isDestroyed()) return false
      target.close()
      return true
    },

    attach(next: BrowserWindow): void {
      window = next
      next.on('close', (event) => onCloseAttempt(event, next))
    },

    snapshot() {
      return { dirty, confirmed, askCount }
    }
  }
}

/** 全进程共用一份。 */
export const closeGuard = createCloseGuardHost()
