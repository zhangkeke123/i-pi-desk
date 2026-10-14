import { useMemo, useState } from 'react'
import { Columns2, Rows3 } from 'lucide-react'
import { diffStats, parseDiffRows, type DiffCell, type DiffRow } from './diff-parse.js'

/**
 * 差异渲染。
 *
 * 输入是 pi 的 `generateDiffString` 产出的**展示用 diff 文本**（带行号的类 unified diff）。
 * 解析在 `diff-parse.ts`（纯逻辑、可被 node 直接单测），这里只管画。
 *
 * ## 两种视图，默认统一
 *
 * - **统一（unified）**：改动上下排列，省宽度。聊天栏与审批卡片都在一个不宽的列里，
 *   这是默认形态。
 * - **并排（split）**：左右两列，配对显示删除与新增。窗口宽时才真正好用，
 *   但它的价值很直接 —— **不用自己在脑子里给「这几行删了、那一行顶上」对位**。
 *
 * 默认统一、提供切换，而不是直接改成并排：并排视图在窄容器里会把两列都挤到看不清，
 * 而窄容器恰恰是它最常见的出现位置（审批卡片）。
 *
 * 为什么不引 react-diff-viewer：本组件只做逐行上色与配对，
 * 自己写一个解析器（约 120 行、有 20 条单测）比多一个依赖可控 ——
 * 而且我们的 diff 格式是 pi 定的，第三方库未必认。
 */

/**
 * 行样式。
 *
 * 改动的读法：**底色表示哪一侧、左侧色条表示方向、文字保持中性**。
 * 早先的做法是「底色 + 同色系文字」（绿字配绿底），在暗色主题下对比度不足、
 * 长 diff 看久了很累；现在文字用 `ink-soft`，靠 2px 左色条与淡底色区分增删 ——
 * 这也是各家 diff 工具的通行做法。
 */
const LINE_STYLE: Record<DiffCell['side'], string> = {
  add: 'bg-[var(--color-ok)]/10 text-[var(--color-ink-soft)] shadow-[inset_2px_0_0_0_var(--color-ok)]',
  remove: 'bg-[var(--color-danger)]/10 text-[var(--color-ink-soft)] shadow-[inset_2px_0_0_0_var(--color-danger)]',
  context: 'text-[var(--color-muted)]'
}

function UnifiedView({ diff }: { diff: string }): React.ReactElement {
  const lines = useMemo(() => diff.split('\n'), [diff])
  return (
    <div className="overflow-auto">
      <pre className="min-w-full font-mono text-xs leading-[1.6]">
        {lines.map((line, index) => {
          const marker = line.slice(0, 1)
          const kind: DiffCell['side'] | 'meta' =
            line.startsWith('文件：') || line.startsWith('⚠️') || line.startsWith('── 改动')
              ? 'meta'
              : marker === '+'
                ? 'add'
                : marker === '-'
                  ? 'remove'
                  : 'context'
          const style =
            kind === 'meta'
              ? 'text-[var(--color-muted)]'
              : LINE_STYLE[kind as DiffCell['side']]
          return (
            <div key={index} className={`px-2 whitespace-pre ${style}`}>
              {line || ' '}
            </div>
          )
        })}
      </pre>
    </div>
  )
}

function SplitView({ diff }: { diff: string }): React.ReactElement {
  const rows = useMemo(() => parseDiffRows(diff), [diff])

  return (
    <div className="overflow-auto">
      <div className="min-w-full font-mono text-xs leading-[1.6]">
        {rows.map((row, index) =>
          row.kind === 'meta' ? (
            // 元信息横跨两列：塞进左格子会变成「文件头只显示在左边」的怪异效果。
            <div key={index} className="whitespace-pre px-2 text-2xs text-[var(--color-muted)]">
              {row.text || ' '}
            </div>
          ) : (
            <div key={index} className="flex">
              <SplitCell cell={row.left} />
              <SplitCell cell={row.right} />
            </div>
          )
        )}
      </div>
    </div>
  )
}

function SplitCell({ cell }: { cell?: DiffCell }): React.ReactElement {
  if (!cell) {
    // 空的另一半：用斜纹底示意「这一侧没有对应行」，比纯空白色更容易读懂配对关系。
    return (
      <div className="w-1/2 shrink-0 border-l border-[var(--color-border)] bg-[var(--color-surface-2)]/60">
        <span className="block px-2 opacity-0"> </span>
      </div>
    )
  }
  return (
    <div className={`flex w-1/2 min-w-0 shrink-0 border-l border-[var(--color-border)] ${LINE_STYLE[cell.side]}`}>
      <span className="w-8 shrink-0 select-none px-1 text-right opacity-50">{cell.number}</span>
      <span className="min-w-0 flex-1 overflow-hidden whitespace-pre px-1">{cell.text}</span>
    </div>
  )
}

export function DiffView({ diff, maxHeight = '18rem' }: { diff: string; maxHeight?: string }): React.ReactElement {
  const [split, setSplit] = useState(false)
  const stats = useMemo(() => diffStats(diff), [diff])

  return (
    <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5">
        <span className="text-2xs font-medium uppercase tracking-wide text-[var(--color-muted)]">改动</span>
        <span className="flex items-center gap-1.5 font-mono text-2xs tabular-nums">
          <span className="text-[var(--color-ok)]">+{stats.added}</span>
          <span className="text-[var(--color-danger)]">-{stats.removed}</span>
        </span>
        <button
          type="button"
          onClick={() => setSplit((value) => !value)}
          className="btn ml-auto h-6 px-2 text-2xs"
          title={split ? '切换为上下排列' : '切换为并排显示'}
          data-active={split ? 'true' : undefined}
        >
          {split ? <Rows3 size={12} /> : <Columns2 size={12} />}
          {split ? '上下' : '并排'}
        </button>
      </div>
      <div style={{ maxHeight }}>
        {split ? <SplitView diff={diff} /> : <UnifiedView diff={diff} />}
      </div>
    </div>
  )
}
