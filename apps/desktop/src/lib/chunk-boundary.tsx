import { Component, type ReactNode } from 'react'
import { Loader2, TriangleAlert } from 'lucide-react'

/**
 * 按需加载面板的公共件：加载态 + 错误边界。
 *
 * ## 为什么需要错误边界
 *
 * 把一块重依赖改成 `React.lazy` 会引入一个**新的失败模式**：chunk 取不到
 * （文件损坏、打包漏了资源、磁盘读失败）时 lazy 的 promise 会 reject。
 * 没有边界的话 React 会把整棵树卸载 —— 用户看到的是**整块界面白掉**，
 * 而且没有任何提示，看起来像应用坏了。
 *
 * ## 为什么「重试」是整页重载
 *
 * `React.lazy` 会把**失败结果也缓存住**，重新渲染同一个 lazy 组件不会重新发起
 * `import()` —— 那样写出来的「重试」按钮点了没反应，比没有按钮更糟。
 * 桌面端重载渲染层是安全且确定的恢复方式。
 */
export class ChunkBoundary extends Component<
  { children: ReactNode; what: string; bytesHint?: string },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div className="flex h-full min-h-[160px] flex-col items-center justify-center gap-3 px-6 text-center">
        <TriangleAlert size={18} className="text-[var(--color-warn)]" />
        <p className="text-xs leading-relaxed text-[var(--color-muted)]">
          {this.props.what}加载失败（前端资源没读出来）。
          <br />
          {this.props.bytesHint ?? '已经打开的内容没有被动过，重新加载界面即可恢复。'}
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs hover:bg-[var(--color-surface-2)]"
          title="重新加载界面"
        >
          重新加载
        </button>
      </div>
    )
  }
}

/** 加载态：给一个明确的「正在加载什么」，而不是空白。 */
export function ChunkLoading({ label }: { label: string }): React.ReactElement {
  return (
    <div className="flex h-full min-h-[160px] items-center justify-center gap-2 text-xs text-[var(--color-muted)]">
      <Loader2 size={14} className="animate-spin" />
      正在加载{label}…
    </div>
  )
}
