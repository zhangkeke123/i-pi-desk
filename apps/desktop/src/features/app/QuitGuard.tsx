import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { getDesk } from '../../lib/desk.js'
import { useAppStore } from '../../stores/app-store.js'

/**
 * 关窗前的最后一问。
 *
 * ## 为什么需要这个组件
 *
 * 关窗口是每个使用会话的最后一步，而它原本会**静默丢掉**编辑器里没保存的内容。
 * 「关窗」这件事只有主进程能拦（`close` 事件在它那里），但「有没有未保存」
 * 只有渲染层知道 —— 所以协议是：主进程拦下 → 通知渲染层 → 渲染层问一句 →
 * 用户确认后调 `app.confirmQuit()` 真的关掉。
 *
 * ## 两个方向都要接上
 *
 *  1. **上报**：脏状态一变就告诉主进程（主进程自己没法知道）；
 *  2. **接收**：主进程说「有人想关窗」，这里弹出来问。
 *
 * 上报用 `void` 丢掉 Promise 但不吞错 —— 上报失败意味着主进程不知道有未保存内容，
 * 那样关窗就会静默丢东西。所以失败时要在控制台留下痕迹（这是唯一能做的：
 * 这条链路本身就是为了「别丢东西」，不能反过来因为它失败而丢东西）。
 */
export function QuitGuard(): React.ReactElement | null {
  const editorDirty = useAppStore((s) => s.editorDirty)
  const [asking, setAsking] = useState(false)

  /** 方向一：把脏状态同步给主进程。 */
  useEffect(() => {
    void getDesk()
      .app.setEditorDirty(editorDirty)
      .catch((error: unknown) => {
        console.error('[quit-guard] 未保存状态同步失败，关窗拦截可能不会生效：', error)
      })
  }, [editorDirty])

  /** 方向二：主进程拦下了关窗，我们来问。 */
  useEffect(() => {
    return getDesk().events.onCloseRequested(() => setAsking(true))
  }, [])

  if (!asking) return null

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-[var(--color-overlay)] p-6 backdrop-blur-[2px]">
      <div className="w-full max-w-md rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-lg)]">
        <div className="mb-2 flex items-center gap-2 text-[var(--color-warn)]">
          <AlertTriangle size={16} />
          <span className="font-medium">有未保存的改动</span>
        </div>
        <p className="text-ui leading-relaxed text-[var(--color-muted)]">
          编辑器里的改动还没有保存到磁盘。现在退出会<strong className="text-[var(--color-ink)]">丢弃</strong>它们。
        </p>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => setAsking(false)}
            className="btn h-8 px-3"
            title="取消退出"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => {
              setAsking(false)
              void getDesk().app.confirmQuit()
            }}
            className="btn btn-outline h-8 border-[var(--color-danger)]/50 px-3 text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]"
            title="不保存并退出"
          >
            不保存并退出
          </button>
        </div>
      </div>
    </div>
  )
}
