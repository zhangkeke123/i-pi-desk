import { ArrowLeft, ArrowRight } from 'lucide-react'
import { useNavigationStore } from '../../stores/navigation-store.js'

/**
 * PI 风格全局后退 / 前进（应用视图栈，不是浏览器历史）。
 * 主壳顶栏放在右侧图标行；设置页 header 也可复用。
 */
export function HistoryNavButtons({ className }: { className?: string }): React.ReactElement {
  const index = useNavigationStore((s) => s.index)
  const entriesLength = useNavigationStore((s) => s.entries.length)
  const goBack = useNavigationStore((s) => s.goBack)
  const goForward = useNavigationStore((s) => s.goForward)
  const canGoBack = index > 0
  const canGoForward = index >= 0 && index < entriesLength - 1

  return (
    <div
      className={className ?? 'header-bar__nav flex shrink-0 items-center'}
      role="group"
      aria-label="视图导航"
    >
      <button
        type="button"
        className="header-bar__icon"
        onClick={() => goBack()}
        disabled={!canGoBack}
        title="后退"
        aria-label="后退"
      >
        <ArrowLeft size={15} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        className="header-bar__icon"
        onClick={() => goForward()}
        disabled={!canGoForward}
        title="前进"
        aria-label="前进"
      >
        <ArrowRight size={15} strokeWidth={1.75} />
      </button>
    </div>
  )
}
