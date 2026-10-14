/**
 * diff 解析自测。
 *
 * 并排视图的难点不在渲染，而在**把 `-`/`+` 配对成左右两列** ——
 * 配对错位会让用户看到「删的是 A、加的是 B」这种错误对应，比不显示并排更糟。
 * 所以这里逐条覆盖配对的边界情况，全部用真实格式的样例文本
 * （带行号、带文件头与警告行，见 `diff-parse.ts` 的说明）。
 *
 * 纯逻辑模块（不 import React / Electron），所以能被 node 直接跑。
 *
 * 用法：node --experimental-strip-types scripts/verify-diff-parse.ts
 */

import { diffStats, parseDiffRows } from '../src/features/diff/diff-parse.ts'

let failures = 0
const check = (label: string, condition: boolean, detail = ''): void => {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

/**
 * 断言用的两个投影。
 *
 * 刻意**分开取**「meta 行」与「配对行」，而不是按下标去数全部行：
 * diff 文本里文件头后面跟一个空行，它也是一个 meta 行 —— 按绝对下标断言的话，
 * 每换一个样例就要重算一次偏移，而那种失败看起来像解析器错了，其实只是测试数错了。
 */
const metas = (diff: string): string[] =>
  parseDiffRows(diff)
    .filter((row) => row.kind === 'meta')
    .map((row) => row.text.trim())

const pairs = (diff: string): string[] =>
  parseDiffRows(diff)
    .filter((row) => row.kind === 'pair')
    .map(
      (row) =>
        `L:${row.left ? `${row.left.number}=${row.left.text}` : '-'}|R:${row.right ? `${row.right.number}=${row.right.text}` : '-'}`
    )

const show = (diff: string): string =>
  parseDiffRows(diff)
    .map((row) => (row.kind === 'meta' ? `meta:${row.text.trim()}` : `pair:${row.left?.text ?? ''} → ${row.right?.text ?? ''}`))
    .join('\n        ')

console.log('[1] 一删一增：应当配成同一行')
const oneToOne = `文件：src/sample.ts（1 处改动）
 
 1 const a = 1
-2 const b = 2
+2 const b = 20
 3 export default a`
console.log('        ' + show(oneToOne))
const rows = pairs(oneToOne)
check('文件头被识别为 meta', metas(oneToOne)[0] === '文件：src/sample.ts（1 处改动）', JSON.stringify(metas(oneToOne)))
check('上下文行两侧内容相同（行号也相同）', rows[0] === 'L:1=const a = 1|R:1=const a = 1', rows[0])
check('删除与新增被配到同一行', rows[1] === 'L:2=const b = 2|R:2=const b = 20', rows[1])
check('改动后的上下文行仍在', rows[2] === 'L:3=export default a|R:3=export default a', rows[2])

console.log('\n[2] 删多增少（3 删 1 增）：右侧留空，不左移错位')
const uneven = `文件：src/x.ts（1 处改动）
 
-1 a
-2 b
-3 c
+1 z
 4 keep`
const unevenRows = pairs(uneven)
console.log('        ' + show(uneven))
check('第一对是 a → z', unevenRows[0] === 'L:1=a|R:1=z', unevenRows[0])
check('第二对只剩左格（b）', unevenRows[1] === 'L:2=b|R:-', unevenRows[1])
check('第三对只剩左格（c）', unevenRows[2] === 'L:3=c|R:-', unevenRows[2])
check('上下文行不被卷入配对', unevenRows[3] === 'L:4=keep|R:4=keep', unevenRows[3])

console.log('\n[3] 纯新增（没有删除）：左格留空')
const pureAdd = `文件：src/new.txt（1 处改动）
 
+1 line1
+2 line2`
const addRows = pairs(pureAdd)
check('第一行左空右有', addRows[0] === 'L:-|R:1=line1', addRows[0])
check('第二行左空右有', addRows[1] === 'L:-|R:2=line2', addRows[1])

console.log('\n[4] 纯删除（没有新增）：右格留空')
const pureRemove = `文件：src/gone.txt（1 处改动）
 
-1 old1
-2 old2`
const removeRows = pairs(pureRemove)
check('第一行左有右空', removeRows[0] === 'L:1=old1|R:-', removeRows[0])
check('第二行左有右空', removeRows[1] === 'L:2=old2|R:-', removeRows[1])

console.log('\n[5] 多个改动块之间必须断开（不能跨块配对）')
const twoBlocks = `文件：src/multi.ts（2 处改动）
 
-1 a
+1 A
 2 mid
── 改动 2 ──
-3 c
+3 C`
const blockRows = pairs(twoBlocks)
console.log('        ' + show(twoBlocks))
check('第一块正常配对', blockRows[0] === 'L:1=a|R:1=A', blockRows[0])
check('块分隔行是 meta（横跨两列）', metas(twoBlocks).includes('── 改动 2 ──'), JSON.stringify(metas(twoBlocks)))
check('第二块单独配对，没有与第一块混在一起', blockRows[2] === 'L:3=c|R:3=C', blockRows[2])
check('块之间的上下文行仍在', blockRows[1] === 'L:2=mid|R:2=mid', blockRows[1])

console.log('\n[6] 元信息行不会被当成改动（否则会多出假的配对）')
const withWarning = `文件：src/w.ts（1 处改动）
⚠️ 有一段 oldText 在文件中出现多次。
 
-1 x
+1 y`
check('警告行是 meta', metas(withWarning).includes('⚠️ 有一段 oldText 在文件中出现多次。'), JSON.stringify(metas(withWarning)))
check(
  '元信息没有产生额外的配对行',
  pairs(withWarning).length === 1 && pairs(withWarning)[0] === 'L:1=x|R:1=y',
  JSON.stringify(pairs(withWarning))
)

console.log('\n[7] 边界输入不应抛错')
for (const [label, input] of [
  ['空字符串', ''],
  ['只有换行', '\n\n'],
  ['只有文件头', '文件：a.ts（0 处改动）'],
  ['没有行号的改动行', '-foo\n+bar'],
  ['不认识的形状', '???\n!!!']
] as const) {
  let ok = true
  let detail = ''
  try {
    const result = parseDiffRows(input)
    ok = Array.isArray(result)
    detail = JSON.stringify(result)
  } catch (error) {
    ok = false
    detail = String(error)
  }
  check(`${label} → 返回数组而不是抛错`, ok, detail)
}

console.log('\n[8] 没有行号时正文仍然完整保留')
const noNumber = pairs('-const a = 1\n+const a = 2')
check('无行号时 number 为空、正文完整', noNumber[0] === 'L:=const a = 1|R:=const a = 2', noNumber[0])

console.log('\n[9] 统计只数改动行（元信息与上下文不算）')
const stats = diffStats(oneToOne)
check('增删计数正确', stats.added === 1 && stats.removed === 1, JSON.stringify(stats))
const statsWithMeta = diffStats(withWarning)
check('警告行不影响计数', statsWithMeta.added === 1 && statsWithMeta.removed === 1, JSON.stringify(statsWithMeta))
const emptyStats = diffStats('')
check('空输入统计为 0', emptyStats.added === 0 && emptyStats.removed === 0, JSON.stringify(emptyStats))

console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
