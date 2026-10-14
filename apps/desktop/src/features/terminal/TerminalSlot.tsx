import { Suspense, lazy } from 'react'
import { ChunkBoundary, ChunkLoading } from '../../lib/chunk-boundary.js'
import type { TerminalPanelProps } from './TerminalPanel.js'

/**
 * 按需加载的终端面板。
 *
 * ## 为什么拆
 *
 * `@xterm/xterm`（含 addon-fit 与它的 CSS）约 **411 KB**，是主 chunk 里除了
 * React 之外最大的一块 —— 而**它只在用户真的打开终端时才需要**。
 * 实测：拆出去之后主 chunk 从 1585 KB 降到约 1180 KB。
 *
 * 这里的判断和编辑器那次是同一条：**代价（多一个加载态）只在真正使用该功能时付，
 * 收益（启动少解析几百 KB）所有会话都享受。**
 *
 * 终端比编辑器更值得拆：很多会话根本不碰终端，而打开文件是更常见的动作。
 *
 * ⚠️ xterm 的 CSS 也在这条链上（`@xterm/xterm/css/xterm.css`）。
 * 按需加载后样式随 chunk 一起注入，所以「样式有没有到」必须单独验 ——
 * 只验 DOM 里有没有 `.xterm` 是验不出这个的（node 存在但样式没到 = 布局全乱）。
 */
const LazyTerminalPanel = lazy(async () => {
  const module = await import('./TerminalPanel.js')
  return { default: module.TerminalPanel }
})

export function TerminalSlot(props: TerminalPanelProps): React.ReactElement {
  return (
    <ChunkBoundary what="终端">
      <Suspense fallback={<ChunkLoading label="终端" />}>
        <LazyTerminalPanel {...props} />
      </Suspense>
    </ChunkBoundary>
  )
}
