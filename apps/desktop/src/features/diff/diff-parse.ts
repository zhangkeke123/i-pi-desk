/**
 * 展示用 diff 文本 → 结构化行。
 *
 * ## 输入长什么样
 *
 * pi 的 `generateDiffString` 产出的是「带行号的类 unified diff」：
 *
 * ```
 * 文件：src/sample.ts（1 处改动）
 *
 *  1 const a = 1
 * -2 const b = 2
 * +2 const b = 20
 *  3 export default a
 * ```
 *
 * 前缀是 ` ` / `-` / `+`，后面跟**行号**再跟正文。除了改动行，还有几类元信息行：
 * 文件头、歧义/未匹配警告、`── 改动 N ──` 分隔、以及空行。
 *
 * ## 为什么把解析单独放一个模块
 *
 * 并排视图的核心难点不是渲染，而是**把 `-`/`+` 配对成左右两列**，
 * 而配对规则有一堆边界（删除比新增多、纯新增、纯删除、多个改动块、元信息行不该被配对）。
 * 这些用 node 跑单测最直接 —— 所以这里不 import 任何 React 或 Electron。
 */

export type DiffSide = 'add' | 'remove' | 'context'

/** 并排视图里的一个格子。 */
export interface DiffCell {
  /** 行号（diff 文本里带的那个）。上下文行两侧相同。 */
  number: string
  text: string
  side: DiffSide
}

/**
 * 并排视图里的一行。
 *
 * - `meta`：文件头 / 警告 / 空行 / `── 改动 N ──` —— 这类内容**横跨两列**，
 *   不该被塞进左格子，否则并排视图会出现「元信息只显示在左边」的怪异效果。
 * - `pair`：左格与右格。两侧都可能为空（删除比新增多时右空，反之左空）。
 */
export type DiffRow =
  | { kind: 'meta'; text: string }
  | { kind: 'pair'; left?: DiffCell; right?: DiffCell }

const META_PREFIXES = ['文件：', '⚠️', '── 改动']

/** 解析前缀与行号。取不到行号时返回空字符串（不影响正文展示）。 */
function splitLine(line: string): { marker: string; number: string; text: string } {
  const marker = line.slice(0, 1)
  const rest = line.slice(1)
  const match = /^\s*(\d+)\s?(.*)$/.exec(rest)
  if (match) return { marker, number: match[1], text: match[2] }
  return { marker, number: '', text: rest }
}

function isMeta(line: string): boolean {
  if (line.trim().length === 0) return true
  // `@@` 是标准 unified diff 的块头（别的来源可能给这个形式）。
  if (line.startsWith('@@')) return true
  if (line.startsWith('+++') || line.startsWith('---')) return true
  return META_PREFIXES.some((prefix) => line.startsWith(prefix))
}

function toCell(line: string, side: DiffSide): DiffCell {
  const { number, text } = splitLine(line)
  return { number, text, side }
}

/**
 * 把 diff 文本转成并排视图的行模型。
 *
 * ## 配对规则
 *
 * 在一个改动块里，unified diff 的约定是**先列删除、再列新增**。所以按顺序扫：
 * 收集连续的 `-` 到一个缓冲，遇到 `+` 就开始收集新增；两边都收完（遇到上下文行
 * 或块结束）时按索引两两配对。
 *
 * 长度不等时短的那侧留空 —— 这正是并排视图相对统一视图的价值：
 * **一眼看出「这几行删了、那一行顶上」**，而不是自己在脑子里对位。
 */
export function parseDiffRows(diff: string): DiffRow[] {
  const lines = (diff ?? '').split('\n')
  const rows: DiffRow[] = []

  /** 当前待配对的删除行与新增行。 */
  let removed: string[] = []
  let added: string[] = []

  const flush = (): void => {
    if (removed.length === 0 && added.length === 0) return
    const size = Math.max(removed.length, added.length)
    for (let index = 0; index < size; index += 1) {
      const left = removed[index]
      const right = added[index]
      rows.push({
        kind: 'pair',
        ...(left !== undefined ? { left: toCell(left, 'remove') } : {}),
        ...(right !== undefined ? { right: toCell(right, 'add') } : {})
      })
    }
    removed = []
    added = []
  }

  for (const line of lines) {
    if (isMeta(line)) {
      // 元信息会打断配对：一个改动块到元信息行就结束了。
      flush()
      rows.push({ kind: 'meta', text: line })
      continue
    }

    const marker = line.slice(0, 1)
    if (marker === '-') {
      // 已经开始收新增了又出现删除？说明该块的删除段已经结束，先落一次。
      if (added.length > 0) flush()
      removed.push(line)
      continue
    }
    if (marker === '+') {
      added.push(line)
      continue
    }

    // 其余（上下文行）本身自成一行的两侧相同内容。
    flush()
    const cell = toCell(line, 'context')
    rows.push({ kind: 'pair', left: cell, right: { ...cell } })
  }

  flush()
  return rows
}

/** 统计增删行数（统一视图与并排视图共用）。 */
export function diffStats(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of (diff ?? '').split('\n')) {
    if (isMeta(line)) continue
    if (line.startsWith('+')) added += 1
    else if (line.startsWith('-')) removed += 1
  }
  return { added, removed }
}
