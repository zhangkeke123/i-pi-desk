#!/usr/bin/env node
/**
 * 渲染层产物体积守卫。
 *
 * ## 为什么这件事需要一个测试
 *
 * 「语言包按需加载」这个优化**没有行为症状**：如果有人把 `import()` 改回静态 `import`，
 * 功能完全正常，只是主 chunk 悄悄涨回 350 KB —— 没有任何测试会红，
 * 直到某天有人抱怨启动慢。
 *
 * 所以把「主 chunk 不含语言解析器」写成一条**构建期断言**。它守的不是功能，
 * 而是一个容易被无声回退的决定。
 *
 * ## 阈值怎么定
 *
 * 语言包按需加载后主 chunk ≈ 2.39 MB；CodeMirror 内核也改成按需加载后 ≈ 1.58 MB；
 * 终端（xterm ≈ 411 KB）再拆出去后 ≈ **1.20 MB**。
 * 阈值取 **1.35 MB**：比当前值留出约 12% 余量（不同 rollup 版本的微小差异、
 * 少量新增代码不会弄成假红），但只要有人把 CodeMirror、xterm 或语言包改回静态
 * import，主 chunk 会立刻越过它。
 *
 * 光有体积上限还不够：体积可能因为别的改动而涨，却没人注意到拆分已经失效。
 * 所以另外两条断言直接盯着**拆分本身** —— 「必须存在一个名叫 CodeEditor-*.js /
 * TerminalPanel-*.js 的独立 chunk 且它有几百 KB」。`import()` 一旦被改回 `import`，
 * 那个 chunk 会消失，这条会立刻失败，而且失败信息直接指向原因。
 *
 * 用法：node scripts/verify-bundle.mjs
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const assetsDir = join(here, '..', 'out', 'renderer', 'assets')
const indexPath = join(here, '..', 'out', 'renderer', 'index.html')

/** 主 chunk 上限（KB）。见文件头的推算。 */
const MAX_MAIN_CHUNK_KB = 1350
/** 至少要切出这么多独立 chunk（当前 10 个；留出余量以免正常调整就红）。 */
const MIN_CHUNKS = 6
/** 编辑器 chunk 至少这么大才说明 CodeMirror 真的在里面（当前 ≈ 780 KB）。 */
const MIN_EDITOR_CHUNK_KB = 300
/** 终端 chunk 至少这么大才说明 xterm 真的在里面（当前 ≈ 424 KB）。 */
const MIN_TERMINAL_CHUNK_KB = 200
/**
 * 快速启动面板的 chunk 至少这么大，才说明 cmdk 在里面（当前 ≈ 111 KB）。
 *
 * 守两件事：① cmdk（连带 `@radix-ui/react-dialog`，实测让主 chunk +131 KB）没有被并回主 chunk；
 * ② 面板确实还在 —— 删掉按需加载时这个 chunk 会消失。
 */
const MIN_LAUNCHER_CHUNK_KB = 60

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

if (!existsSync(indexPath) || !existsSync(assetsDir)) {
  console.error('找不到渲染层产物，请先跑：pnpm --filter @i-pi-desk/desktop build')
  process.exit(1)
}

const html = readFileSync(indexPath, 'utf8')
const mainMatch = /<script[^>]+src="\.\/assets\/([^"]+)"/.exec(html)
check('index.html 用相对路径引用入口脚本（file:// 下才能加载）', Boolean(mainMatch), html.slice(0, 300))

if (!mainMatch) {
  console.log(`\nFAILURES=${failures}`)
  process.exit(1)
}

const jsAssets = readdirSync(assetsDir)
  .filter((name) => name.endsWith('.js'))
  .map((name) => {
    const bytes = readFileSync(join(assetsDir, name)).length
    return { name, kb: Math.round(bytes / 1024) }
  })
  .sort((a, b) => b.kb - a.kb)

const mainChunk = jsAssets.find((asset) => asset.name === mainMatch[1])
check('入口脚本存在于产物里', Boolean(mainChunk), mainMatch[1])

if (mainChunk) {
  console.log(`        主 chunk: ${mainChunk.name} = ${mainChunk.kb} KB（上限 ${MAX_MAIN_CHUNK_KB} KB）`)
  check(
    `主 chunk 不超过 ${MAX_MAIN_CHUNK_KB} KB（语言包必须是按需加载的）`,
    mainChunk.kb <= MAX_MAIN_CHUNK_KB,
    `实际 ${mainChunk.kb} KB。若刚把语言包改回静态 import，主 chunk 会涨回 ~2740 KB —— 那正是这条断言要拦的。`
  )
}

const chunks = jsAssets.filter((asset) => asset.name !== mainMatch[1])
console.log(`        独立 chunk: ${chunks.length} 个（合计 ${chunks.reduce((sum, c) => sum + c.kb, 0)} KB）`)
for (const chunk of chunks.slice(0, 10)) console.log(`          ${chunk.name} ${chunk.kb} KB`)

check(
  `至少切出 ${MIN_CHUNKS} 个独立 chunk（说明按需加载还在）`,
  chunks.length >= MIN_CHUNKS,
  `实际 ${chunks.length} 个`
)

/**
 * 直接盯住「编辑器内核确实被拆出去了」。
 *
 * 体积上限是间接证据：别的改动也可能让主 chunk 变大，那时人会去调阈值，
 * 而拆分其实早就失效了。这条断言把**拆分本身**变成契约。
 */
const editorChunk = chunks.find((chunk) => /^CodeEditor-.*\.js$/.test(chunk.name))
check(
  '代码编辑器内核被拆成独立的按需 chunk',
  Boolean(editorChunk) && editorChunk.kb >= MIN_EDITOR_CHUNK_KB,
  editorChunk
    ? `找到 ${editorChunk.name} 但只有 ${editorChunk.kb} KB（预期 ≥ ${MIN_EDITOR_CHUNK_KB} KB）`
    : `产物里没有 CodeEditor-*.js。多半是 EditorSlot 里的 import() 被改回了静态 import —— 那样每次启动都要白解析这几百 KB。`
)

/**
 * 终端同理。它是主 chunk 里除 React 之外最大的一块（xterm ≈ 411 KB），
 * 而**很多会话根本不打开终端** —— 所以这条拆分的收益面比编辑器还大。
 */
const terminalChunk = chunks.find((chunk) => /^TerminalPanel-.*\.js$/.test(chunk.name))
check(
  '终端面板被拆成独立的按需 chunk',
  Boolean(terminalChunk) && terminalChunk.kb >= MIN_TERMINAL_CHUNK_KB,
  terminalChunk
    ? `找到 ${terminalChunk.name} 但只有 ${terminalChunk.kb} KB（预期 ≥ ${MIN_TERMINAL_CHUNK_KB} KB）`
    : `产物里没有 TerminalPanel-*.js。多半是 App.tsx 又把 TerminalPanel 改回了静态 import —— 那样不打开终端的用户也要为 xterm 付启动时间。`
)

/**
 * 快速启动面板（Ctrl+K）同理，而且它的依赖最不显眼：
 * `cmdk` 会拖进 `@radix-ui/react-dialog` 等一串包，实测让主 chunk **+131 KB**。
 * 面板是「偶尔按一下」的功能，不该让每次启动都付这个成本。
 *
 * 这条断言同时守住「拆分还在」与「面板还在」：删掉按需加载时这个 chunk 会消失。
 */
const launcherChunk = chunks.find((chunk) => /^CommandPalette-.*\.js$/.test(chunk.name))
check(
  '快速启动面板被拆成独立的按需 chunk（cmdk 没被并回主 chunk）',
  Boolean(launcherChunk) && launcherChunk.kb >= MIN_LAUNCHER_CHUNK_KB,
  launcherChunk
    ? `找到 ${launcherChunk.name} 但只有 ${launcherChunk.kb} KB（预期 ≥ ${MIN_LAUNCHER_CHUNK_KB} KB）`
    : `产物里没有 CommandPalette-*.js。多半是 App.tsx 把 CommandPalette 改回了静态引用 —— 那样 cmdk 与 radix 这一百多 KB 会进主 chunk。`
)

const totalKb = jsAssets.reduce((sum, asset) => sum + asset.kb, 0)
console.log(`        JS 总计: ${totalKb} KB（主 chunk + 全部按需 chunk）`)

// 顺带守住一件容易忽略的事：按需加载不该让**总量**大幅膨胀
// （例如把同一份依赖打进多个 chunk）。当前 ≈ 2819 KB。
/*
  上限是**预算**，不是「当前测得多少」。基线调整过，原因写在下面：
  · 3000 → 3020：这一轮新增了手写模块（会话分页、设置整窗面板的左导航与图标、
    以及迟到元素预留空间 / 思考强度 / 长会话渲染窗口那几项）。
    调整前核对过**没有复制依赖**：主 chunk 1295/1350 KB、编辑器 762 KB、
    终端 416 KB、启动面板 111 KB，都与上一版一致或更小。
  它仍然抓得到真正的问题（依赖被复制会一次跳几十 KB），
  但不该因为「这轮多写了两百行代码」而拦住构建。
*/
check('JS 总量没有异常膨胀（拆包不应复制依赖）', totalKb <= 3020, `实际 ${totalKb} KB`)

console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
