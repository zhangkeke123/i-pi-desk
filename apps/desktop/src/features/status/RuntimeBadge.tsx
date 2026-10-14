import { useEffect } from 'react'
import { useAppStore } from '../../stores/app-store.js'
import { call, getDesk } from '../../lib/desk.js'

/** sidecar 健康状态。它崩溃时用户必须立刻知道，否则会以为是「模型不回话」。 */
export function RuntimeBadge({ compact = false }: { compact?: boolean }): React.ReactElement {
  const runtime = useAppStore((s) => s.runtime)

  /**
   * 启动竞态：sidecar 先 ready、渲染层后挂载时可能漏掉推送。
   * 周期性主动问一次，避免徽标长期停在「启动中 / 已停止」。
   */
  useEffect(() => {
    let alive = true
    const tick = (): void => {
      void call(getDesk().agent.status())
        .then((status) => {
          if (alive) useAppStore.setState({ runtime: status })
        })
        .catch(() => undefined)
    }
    tick()
    const timer = setInterval(tick, 3000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  const map = {
    starting: { text: '内核启动中', color: 'var(--color-warn)', pulse: true },
    ready: { text: '内核就绪', color: 'var(--color-ok)', pulse: false },
    crashed: { text: `内核已崩溃（重启 ${runtime.restarts} 次）`, color: 'var(--color-danger)', pulse: false },
    stopped: { text: '内核已停止', color: 'var(--color-muted)', pulse: false }
  } as const

  const view = map[runtime.state] ?? map.stopped

  return (
    <span
      className={
        compact
          ? 'flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)]'
          : 'flex items-center gap-1.5 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[11px] text-[var(--color-muted)]'
      }
      title={runtime.lastError ?? view.text}
      aria-label={view.text}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${view.pulse ? 'animate-pulse' : ''}`}
        style={{ background: view.color }}
      />
      {compact ? null : view.text}
    </span>
  )
}
