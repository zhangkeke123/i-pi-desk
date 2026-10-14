import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { Loader2, Plus, TerminalSquare, X } from 'lucide-react'
import type { TerminalSession } from '@i-pi-desk/shared'
import { useAppStore } from '../../stores/app-store.js'
import { call, getDesk, IpcError } from '../../lib/desk.js'
import { terminalPalette } from '../../lib/terminal-theme.js'
import { useResolvedTheme } from '../theme/use-theme.js'

/**
 * 交互式终端面板（PTY）。
 *
 * ⚠️ 这是**用户自己的 shell**，不是 agent 的工具。agent 的 shell 能力仍是 `bash` 工具、
 * 逐条走审批闸门。详情见 packages/shared 里 TerminalSession 的注释。
 *
 * ## 三个必须做对的实现细节
 *
 * 1. **切换标签用隐藏而不是卸载**。后台会话必须继续跑 —— 卸载组件会把 PTY 一起收掉，
 *    用户切回来发现「刚才那条命令被杀了」。
 * 2. **隐藏的 pane 不会触发 ResizeObserver**，所以切回来时必须手动 `fit()` 一次，
 *    否则尺寸还是隐藏前的，TUI 会画错。
 * 3. **卸载时要主动 dispose**。这是「不留僵尸 shell」三处清理里的第二处
 *    （另两处：窗口销毁、before-quit）。
 */

interface Tab {
  session: TerminalSession
  term: Terminal
  fit: FitAddon
  exited: boolean
}

export interface TerminalPanelProps {
  onClose: () => void
}

export function TerminalPanel({ onClose }: TerminalPanelProps): React.ReactElement {
  const workspacePath = useWorkspacePath()
  const themeId = useResolvedTheme()

  const [probe, setProbe] = useState<{ available: boolean; message?: string } | null>(null)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /** 每个标签的 DOM 容器。xterm 需要真实挂载点，不能由 React 管理其内部 DOM。 */
  const containers = useRef(new Map<string, HTMLDivElement>())
  /** 事件回来时要按 session id 找到对应的 Terminal，所以单独存一份索引。 */
  const byId = useRef(new Map<string, Tab>())

  useEffect(() => {
    let cancelled = false
    void call(getDesk().terminal.probe())
      .then((result) => {
        if (!cancelled) setProbe(result)
      })
      .catch((err) => {
        if (!cancelled) setProbe({ available: false, message: err instanceof IpcError ? err.message : String(err) })
      })
    return () => {
      cancelled = true
    }
  }, [])

  const createTab = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const session = await call(
        getDesk().terminal.create({
          // 以工作区为初始目录最符合直觉：用户开终端多半是为了在当前项目里跑命令。
          cwd: workspacePath,
          cols: 100,
          rows: 24
        })
      )

      const term = new Terminal({
        fontFamily: "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace",
        fontSize: 12,
        cursorBlink: true,
        // 让滚动缓冲足够看长输出，又不会无限吃内存。
        scrollback: 5000,
        fontWeight: 400,
        fontWeightBold: 600,
        // 配色来自当前主题的语义 token（见 lib/terminal-theme.ts 的归一化说明）。
        theme: terminalPalette()
      })
      const fit = new FitAddon()
      term.loadAddon(fit)

      const tab: Tab = { session, term, fit, exited: false }
      byId.current.set(session.id, tab)
      setTabs((prev) => [...prev, tab])
      setActiveId(session.id)

      // 用户敲键 → 送到 PTY。
      term.onData((data) => {
        void getDesk().terminal.write(session.id, data)
      })
      // TUI 需要知道窗口尺寸变化（否则 vim/top 会画错）。
      term.onResize(({ cols, rows }) => {
        void getDesk().terminal.resize(session.id, cols, rows)
      })
    } catch (err) {
      setError(err instanceof IpcError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [workspacePath])

  /** 面板一打开就自动开一个终端：用户点「终端」就是想用，不该再点第二次。 */
  useEffect(() => {
    if (probe?.available && tabs.length === 0 && !busy && !error) void createTab()
  }, [probe?.available, tabs.length, busy, error, createTab])

  // 把 xterm 挂到容器上。放在 effect 里是因为容器要等这一轮渲染出来才存在。
  useEffect(() => {
    for (const tab of tabs) {
      const container = containers.current.get(tab.session.id)
      if (!container || container.dataset.mounted === '1') continue
      tab.term.open(container)
      container.dataset.mounted = '1'
      tab.fit.fit()
    }
  }, [tabs])

  /**
   * 主题变化时把新配色推给**已经开着的**终端。
   *
   * xterm 不会读 CSS 变量（见 lib/terminal-theme.ts），所以这一步不能省 ——
   * 少了它就会出现「切到浅色主题后终端还是黑的」这种局部不跟随。
   */
  useEffect(() => {
    const palette = terminalPalette()
    for (const tab of tabs) tab.term.options.theme = palette
    // themeId 变化 = 主题变了；tabs 变化 = 新开的终端也要补一次。
  }, [themeId, tabs])

  // 接收 PTY 输出并按 id 分发到对应的 xterm。
  useEffect(() => {
    const desk = getDesk()
    const offData = desk.events.onTerminalData(({ id, data }) => {
      byId.current.get(id)?.term.write(data)
    })
    const offExit = desk.events.onTerminalExit(({ id, exitCode }) => {
      const tab = byId.current.get(id)
      if (!tab) return
      tab.exited = true
      tab.term.write(`\r\n\x1b[90m[进程已退出，code=${exitCode}]\x1b[0m\r\n`)
      // 强制重渲染，让标签上的「已退出」标记出现。
      setTabs((prev) => [...prev])
    })
    return () => {
      offData()
      offExit()
    }
  }, [])

  /**
   * 容器尺寸变化 → 重新计算行列数。
   *
   * 只对**可见**的那个容器接 ResizeObserver：隐藏的容器尺寸是 0，
   * 对它 fit 会把终端压成 1x1，切回来时内容全乱。
   */
  useEffect(() => {
    if (!activeId) return
    const container = containers.current.get(activeId)
    const tab = byId.current.get(activeId)
    if (!container || !tab) return

    const fitActive = (): void => {
      try {
        tab.fit.fit()
      } catch {
        // 容器还没布局完时 fit 会抛。下一帧或下一次 resize 会补上。
      }
    }
    // 切标签时隐藏的 pane 不会触发 observer，所以这里必须主动补一次。
    requestAnimationFrame(fitActive)

    const observer = new ResizeObserver(fitActive)
    observer.observe(container)
    return () => observer.disconnect()
  }, [activeId, tabs])

  const closeTab = useCallback(async (id: string) => {
    const tab = byId.current.get(id)
    byId.current.delete(id)
    containers.current.delete(id)
    if (tab) {
      tab.term.dispose()
      // 主动收掉 PTY 进程，不等窗口关闭。
      await getDesk().terminal.dispose(id).catch(() => undefined)
    }
    setTabs((prev) => {
      const next = prev.filter((item) => item.session.id !== id)
      // 关掉当前标签后自动选中相邻的一个，避免出现「无激活标签」的空状态。
      setActiveId((current) => {
        if (current !== id) return current
        return next.length > 0 ? next[next.length - 1].session.id : null
      })
      return next
    })
  }, [])

  // 卸载 = 关闭面板：把本面板创建的终端全部收掉（第二处清理）。
  useEffect(() => {
    const index = byId.current
    return () => {
      for (const [id, tab] of index) {
        tab.term.dispose()
        void getDesk().terminal.dispose(id).catch(() => undefined)
      }
      index.clear()
    }
  }, [])

  const activeTab = tabs.find((tab) => tab.session.id === activeId)

  return (
    <section className="flex h-72 shrink-0 flex-col border-t border-[var(--color-border)] bg-[var(--color-canvas)]">
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-2">
        <TerminalSquare size={13} className="mr-1 shrink-0 text-[var(--color-muted)]" />

        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((tab) => (
            <div
              key={tab.session.id}
              className={`group flex shrink-0 items-center gap-1 rounded-[var(--radius-sm)] px-2 py-1 text-2xs transition-colors ${
                tab.session.id === activeId
                  ? 'bg-[var(--color-surface)] text-[var(--color-ink)] shadow-[var(--shadow-sm)]'
                  : 'text-[var(--color-muted)] hover:bg-[var(--color-surface)]/60 hover:text-[var(--color-ink)]'
              }`}
            >
              <button type="button" onClick={() => setActiveId(tab.session.id)} className="max-w-[12rem] truncate">
                {tab.exited ? '⏹ ' : ''}
                {tab.session.shell}
              </button>
              <button
                type="button"
                onClick={() => void closeTab(tab.session.id)}
                className="grid h-4 w-4 place-items-center rounded opacity-0 transition-opacity hover:text-[var(--color-danger)] group-hover:opacity-100"
                title="关闭终端"
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={() => void createTab()}
          disabled={!probe?.available || busy}
          className="icon-btn h-6 w-6 shrink-0"
          title="新建终端"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={14} />}
        </button>
        <button type="button" onClick={onClose} className="icon-btn h-6 w-6 shrink-0" title="收起终端">
          <X size={14} />
        </button>
      </header>

      {error && <p className="px-3 py-2 text-xs text-[var(--color-danger)]">{error}</p>}

      {probe && !probe.available && (
        <div className="m-3 rounded-lg border border-[var(--color-warn)]/50 bg-[var(--color-warn)]/8 p-3 text-xs leading-relaxed">
          <p className="font-medium text-[var(--color-warn)]">终端不可用</p>
          <p className="mt-1 text-[var(--color-muted)]">{probe.message}</p>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {tabs.map((tab) => (
          <div
            key={tab.session.id}
            ref={(node) => {
              if (node) containers.current.set(tab.session.id, node)
            }}
            // 隐藏而不是卸载：后台会话必须继续运行（见文件头第 1 条）。
            className={`absolute inset-0 px-2 py-1 ${tab.session.id === activeId ? '' : 'hidden'}`}
          />
        ))}

        {tabs.length === 0 && probe?.available && !error && (
          <p className="grid h-full place-items-center text-xs text-[var(--color-muted)]">
            {busy ? '正在启动终端…' : '没有打开的终端'}
          </p>
        )}
      </div>

      {activeTab && (
        <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 font-mono text-2xs text-[var(--color-muted)]">
          <span className="truncate">{activeTab.session.cwd}</span>
          <span className="ml-auto shrink-0 tabular-nums">
            {activeTab.term.cols}×{activeTab.term.rows}
          </span>
        </footer>
      )}
    </section>
  )
}

/** 单独取工作区，避免整个组件因为会话列表变化而重渲染。 */
function useWorkspacePath(): string | undefined {
  return useAppStore((state) => state.currentWorkspace?.path)
}
