#!/usr/bin/env node
/**
 * 把 README 里写的断言条数，与**最近一次全量日志里数出来的**条数对账。
 *
 * ## 为什么要单独一个脚本
 *
 * 「数字是数出来的」是这个项目的一条纪律：README 的表格里每个验证脚本都标了条数。
 * 但条数是会漂的 —— 加了两条断言忘了改表格、或者改了表格却没加断言。
 * 手工核对一次可以，长期靠人记就会糊。
 *
 * 这个脚本只做一件事：**把日志按脚本切段、数 PASS 行、与 README 对**。
 * 它不判断断言写得好不好（那是别的事情的职责），只判断**数字是否一致**。
 *
 * ## 三类数字要分开看（第一版把它们混成了一条规则，于是报了一堆假红）
 *
 *  1. **`verify:*` 行**：README 写的是一个确切数字，必须与日志**精确相等**；
 *  2. **`pnpm test` 行**：README 是**描述性**的（列几个单测套件的例数，不是总计），
 *     所以只报告实测值，不做相等判断；
 *  3. **总计**：README 里那句「**N 条断言**」对的是**日志里全部 PASS 行**
 *     （含 `pnpm test` 那些带 `packages/xxx test:` 前缀的行 —— 第一版只数行首恰为
 *     两空格的，于是少算了 334 条）。
 *
 * ## 用法
 *
 * ```powershell
 * pnpm verify *> "$env:TEMP\verify.log"
 * pnpm --filter @i-pi-desk/desktop run verify:packaging *>> "$env:TEMP\verify.log"
 * pnpm --filter @i-pi-desk/desktop run verify:packaged  *>> "$env:TEMP\verify.log"
 * node tools/reconcile-counts.mjs "$env:TEMP\verify.log"
 * ```
 *
 * **后两步必须走 pnpm**：直接 `node scripts/xxx.mjs` 不会打印脚本横幅，
 * 那两段输出会被算进前一个脚本的桶里（第一版就是这么把 `verify:bundle` 数成 43 条的）。
 */

import { readFileSync } from 'node:fs'
import { argv, exit } from 'node:process'

const logPath = argv[2]
if (!logPath) {
  console.error('用法：node tools/reconcile-counts.mjs <全量验证日志> [README 路径]')
  exit(2)
}
const readmePath = argv[3] ?? 'README.md'
const readme = readFileSync(readmePath, 'utf8')
const log = readFileSync(logPath, 'utf8')

/** README 表格行：拿脚本名与「**…… N 条**」里的 N。 */
function declaredCounts(text) {
  const exact = new Map()
  const descriptive = new Map()
  for (const line of text.split('\n')) {
    const row = /^\|\s*`pnpm ([a-z][a-z0-9:-]*)`\s*\|/.exec(line)
    if (!row) continue
    const name = row[1]
    // 「**… N 条**」允许数字前有词（例如「**生命周期 12 条**」）
    const count = /\*\*[^*]*?(\d+)\s*条\*\*/.exec(line)
    if (name.startsWith('verify:') && count) exact.set(name, Number(count[1]))
    else if (!name.startsWith('verify:')) descriptive.set(name, count ? Number(count[1]) : undefined)
  }
  return { exact, descriptive }
}

/**
 * 日志分桶。
 *
 * pnpm 的输出有三层，第一版没分清，于是报了 5 条假红：
 *
 *  1. **包横幅**（块首，权威）：`> @i-pi-desk/agent-host@0.1.0 verify:plugins D:\…`
 *     —— 这里的名字就是 README 表格里的那个；
 *  2. **内层命令行**（同一块内，必须忽略）：`> node scripts/verify-plugin-host.mjs`
 *     —— 第一版把它当成新块，于是 `verify:plugins` 的 16 条被记到了 `verify:plugin-host` 名下；
 *  3. **`$` 开头的顶层命令**：我的 `cmd /c "… && pnpm …"` 链里，
 *     打包两步只留了 `$ node scripts/verify-packaging.mjs` 这种形式，
 *     没有包横幅 —— 这时才用**文件名**兜底（`verify-packaging.mjs` → `verify:packaging`）。
 *
 * PASS 行的缩进也不统一（打包脚本是 4 空格），所以用「行内出现 PASS 且前面只有空白」判定；
 * 带 `packages/xxx test:` 前缀的是**单测**，单独归一桶，不混进验证脚本。
 */
function countedPerScript(text) {
  const out = new Map()
  let current = null
  const bump = (name) => out.set(name, (out.get(name) ?? 0) + 1)

  for (const line of text.split('\n')) {
    if (/^[>$] /.test(line)) {
      /**
       * 包横幅的判据：**版本号之后紧跟脚本名**。
       *
       * 不要试图去解析包名 —— 第一版写成 `@[a-z-]+@[\d.]+`，而作用域包名里带斜杠
       * （`@i-pi-desk/agent-host@0.1.0`），于是所有包横幅都不认，20 条全红。
       * 锚在「`@0.1.0 ` 后面那个词」上，作用域、根包名、workspace 别名就都不影响了。
       */
      const pkgBanner = /^[>$] .*@[\d.]+\s+([a-z][a-z0-9:-]*)\b/.exec(line)
      const fromFile = /(verify-[a-z-]+)\.mjs/.exec(line)
      if (pkgBanner) {
        const name = pkgBanner[1]
        if (name.startsWith('verify:')) current = name
        else if (name === 'test' || name === 'typecheck') current = '(unit)'
        /**
         * 其余脚本名（`build` / `bundle` / `build:deps` …）**不切块**：
         * 它们多半是某个验证脚本内部为了「先把前提造出来」而调用的
         * （例如 `verify:renderer` 会先 `build:deps && build`）。
         * 第一版把「非 verify 都当单测」，于是 648 条验证断言被算进了单测桶，20 条全红。
         */
      } else if (fromFile && line.startsWith('$ ')) {
        current = fromFile[1].replace(/^verify-/, 'verify:')
      }
      // 其余（内层命令行 `> node scripts/…`）保持当前块不变
      continue
    }
    const isUnit = /^\s*\S+ test:\s+PASS {2}/.test(line)
    const isPass = /^\s*PASS {2}/.test(line)
    if (isUnit) bump('(unit)')
    else if (isPass && current) bump(current)
  }
  return out
}

const { exact, descriptive } = declaredCounts(readme)
const counted = countedPerScript(log)

if (counted.size === 0) {
  console.error('日志里一个脚本桶都没切出来 —— 检查日志是否为全量验证输出（UTF-8）')
  exit(2)
}

const names = [...new Set([...exact.keys(), ...counted.keys()])].filter((n) => n !== '(unit)').sort()
let mismatches = 0
const width = Math.max(...names.map((n) => n.length))

console.log(`${'脚本'.padEnd(width)}  README  日志  结论`)
for (const name of names) {
  const d = exact.get(name)
  const c = counted.get(name)
  if (d === undefined) {
    // 日志里有、README 没写确切数字（`pnpm test` 这类描述性条目会落到这里）
    console.log(`${name.padEnd(width)}  ${descriptive.has(name) ? '描述' : '-'}  ${String(c ?? '-').padStart(4)}  ok（描述性条目，不比数字）`)
    continue
  }
  const same = d === c
  if (!same) mismatches += 1
  console.log(`${name.padEnd(width)}  ${String(d).padStart(6)}  ${String(c ?? '-').padStart(4)}  ${same ? 'ok' : 'X'}`)
}

const totalExact = [...exact.values()].reduce((a, b) => a + b, 0)
console.log(`\nverify:* 行声明合计 ${totalExact} 条`)

/**
 * 总计对的是**全部** PASS 行：`pnpm test` 的单测输出带 `packages/xxx test:` 前缀，
 * 所以这里用「行内出现两个空格 + PASS + 两个空格」来数，而不是行首锚定。
 */
const allPass = (log.match(/ {2}PASS {2}/g) ?? []).length
const unitPass = counted.get('(unit)') ?? 0
const stated = /\*\*(\d+) 条断言\*\*/.exec(readme)
console.log(`日志 PASS 行：${allPass} 条（其中单测 ${unitPass} 条、验证脚本 ${allPass - unitPass} 条）`)
if (stated) {
  const claim = Number(stated[1])
  const okTotal = claim === allPass
  console.log(`README 总计：${claim} 条 → ${okTotal ? 'ok' : 'X 不一致'}`)
  if (!okTotal) mismatches += 1
}

console.log(mismatches === 0 ? '\nALL_PASS' : `\nMISMATCHES=${mismatches}`)
exit(mismatches === 0 ? 0 : 1)
