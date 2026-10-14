import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { generateDiffString } from '@earendil-works/pi-coding-agent'

/**
 * 审批前的差异预览。
 *
 * 这是权限层「有用」与「摆设」的分界线：只告诉用户「agent 想写 file.ts」然后让他点允许，
 * 和把要改的每一行摊开给他看，是完全不同的两件事。后者才是真正的知情同意。
 *
 * ## 为什么不用 pi 内部的 `computeEditsDiff`
 *
 * pi 确实有这么个函数，注释还明确写着「用于执行前预览」，但它**没有从包根导出**
 * （`exports` 只放开了 `.` / `./rpc-entry` / `./client` / `./experimental/plugin`），
 * 子路径导入会被 Node 的 exports 校验挡掉。所以这里只用它导出的
 * `generateDiffString` 自己推演一遍。
 *
 * ## 自己推演的语义边界（必须诚实标注）
 *
 * pi 的 `edit` 匹配规则是：全部 `oldText` 都对**原始内容**匹配（不是逐次修改后的内容），
 * 然后按倒序应用；必要时还会做模糊匹配（去行尾空白、Unicode 引号/连字符归一）。
 * 这里只做**精确匹配 + 首次出现**，因此：
 *  - 精确匹配失败 → 不猜，直接退回「按编辑意图列出改动」，并注明未能定位；
 *  - `oldText` 在同一文件出现多次 → 标注歧义。pi 自己的 guideline 就要求 oldText 必须唯一，
 *    所以这个提示本身是有价值的 lint，而不只是免责声明。
 */

/** 预览时读取的原文件大小上限；超过就不做整文件对比。 */
const MAX_COMPARE_BYTES = 512 * 1024

interface EditPair {
  oldText: string
  newText: string
}

interface EditArgs {
  path?: unknown
  edits?: unknown
}

interface WriteArgs {
  path?: unknown
  content?: unknown
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function resolvePath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path)
}

/** 读文件；读不到（不存在/目录/过大/二进制）返回 null，由调用方决定降级方式。 */
function tryReadText(absolute: string): { text: string; truncated: boolean } | null {
  try {
    const stats = statSync(absolute)
    if (!stats.isFile()) return null
    if (stats.size > MAX_COMPARE_BYTES) return null
    return { text: readFileSync(absolute, 'utf8'), truncated: false }
  } catch {
    return null
  }
}

/**
 * 为一次工具调用生成差异预览。
 * 返回 undefined 表示「这个工具没什么可预览的」（例如 bash —— 要审的是命令本身）。
 */
export function buildApprovalPreview(toolName: string, args: unknown, cwd: string): string | undefined {
  if (!args || typeof args !== 'object') return undefined

  if (toolName === 'edit') return previewEdit(args as EditArgs, cwd)
  if (toolName === 'write') return previewWrite(args as WriteArgs, cwd)
  return undefined
}

function previewEdit(args: EditArgs, cwd: string): string | undefined {
  const path = asString(args.path)
  if (!path) return undefined

  const pairs = toEditPairs(args.edits)
  if (pairs.length === 0) return undefined

  const header = `文件：${path}（${pairs.length} 处改动）`
  const file = tryReadText(resolvePath(path, cwd))

  if (!file) {
    return `${header}\n\n（原文件不可读或过大，以下按编辑意图列出改动）\n\n${intentOnly(pairs)}`
  }

  // 精确匹配 + 唯一性检查。两者任一不满足都退回「意图视图」——
  // 给一个可能与真实执行不一致的漂亮 diff，比不给更糟。
  const matches: Array<{ start: number; end: number; newText: string }> = []
  const notes: string[] = []

  for (const pair of pairs) {
    const first = file.text.indexOf(pair.oldText)
    if (first === -1) {
      return `${header}\n\n⚠️ 有 oldText 未在文件中精确匹配到（实际执行可能走模糊匹配，或直接失败）。\n\n${intentOnly(pairs)}`
    }
    if (file.text.indexOf(pair.oldText, first + 1) !== -1) {
      notes.push(`⚠️ 有一段 oldText 在文件中出现多次，实际改动位置可能与此处不同。`)
    }
    matches.push({ start: first, end: first + pair.oldText.length, newText: pair.newText })
  }

  // 倒序应用，保证前面的替换不会让后面的偏移失效（与 pi 的做法一致）。
  matches.sort((a, b) => b.start - a.start)
  let next = file.text
  for (const match of matches) {
    next = next.slice(0, match.start) + match.newText + next.slice(match.end)
  }

  const { diff } = generateDiffString(file.text, next)
  return notes.length > 0 ? `${header}\n${notes.join('\n')}\n\n${diff}` : `${header}\n\n${diff}`
}

function previewWrite(args: WriteArgs, cwd: string): string | undefined {
  const path = asString(args.path)
  const content = asString(args.content)
  if (!path || content === undefined) return undefined

  const absolute = resolvePath(path, cwd)
  const file = tryReadText(absolute)

  if (!file) {
    // 不存在 = 新建；读不到（过大/目录）= 无法比较。两者都用「全部新增」呈现，语义都对。
    return `文件：${path}（将写入 ${content.split('\n').length} 行）\n\n${generateDiffString('', content).diff}`
  }

  const { diff } = generateDiffString(file.text, content)
  return `文件：${path}（整文件覆盖）\n\n${diff}`
}

function toEditPairs(value: unknown): EditPair[] {
  if (!Array.isArray(value)) return []
  const pairs: EditPair[] = []
  for (const item of value) {
    const record = item as { oldText?: unknown; newText?: unknown }
    const oldText = asString(record?.oldText)
    const newText = asString(record?.newText)
    if (oldText !== undefined && newText !== undefined) pairs.push({ oldText, newText })
  }
  return pairs
}

/** 无法定位时退回到「意图视图」：把每处 old/new 各自渲染成一个 diff 块。 */
function intentOnly(pairs: EditPair[]): string {
  return pairs
    .map((pair, index) => {
      const { diff } = generateDiffString(pair.oldText, pair.newText)
      return `── 改动 ${index + 1} ──\n${diff}`
    })
    .join('\n\n')
}
