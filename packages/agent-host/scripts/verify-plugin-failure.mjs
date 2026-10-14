#!/usr/bin/env node
/**
 * 插件**不听话**时会怎样。
 *
 * ## 为什么单开一份
 *
 * `verify-plugin-host.mjs` 验的是「正常路径 + 环境裁剪」（激活、调用、`ctx.log`、
 * `leakedSecret === null`、停用不留残余）。这一份验的是**失败路径** ——
 * 而失败路径恰恰是插件机制里最容易把一个会话一起带走的地方：
 *
 *  - 插件在**激活时抛错**：会不会让整个宿主不可用？其余的插件还能不能起来？
 *  - 插件在**调用中途进程退出**：调用是挂住、抛异常，还是变成一条 `isError` 结果？
 *  - 插件**激活时不回应**（死循环/卡住）：有没有**上限**，还是一直等下去？
 *  - 插件往 stdout 写**非协议内容**：会不会被当成帧、把宿主带崩？
 *
 * `plugin-host.ts` 里对此有明确承诺：「失败一律转成 `isError: true` 而不是抛异常 ——
 * 因为它的调用者是模型……抛异常则会中断整轮，让一次可恢复的失败变成一次失败的会话」。
 * 这份自测就是来钉住这句话的。
 *
 * 用法：node packages/agent-host/scripts/verify-plugin-failure.mjs
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PluginHost } from '../dist/plugin-host.js'
import { validatePluginManifest } from '../../shared/dist/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const healthyDir = join(repoRoot, 'tools', 'fixture-plugin')

let failures = 0
function check(label, condition, detail = '') {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

const root = mkdtempSync(join(tmpdir(), 'ipi-plugin-fail-'))

/** 造一个插件目录：manifest + main。 */
function makePlugin(id, name, mainSource, tools = []) {
  const dir = join(root, id.replace(/\./g, '-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        id,
        name,
        version: '1.0.0',
        description: '失败路径夹具',
        author: 'i-pi-desk',
        main: 'index.mjs',
        permissions: ['agent.tool.register'],
        contributes: { agentTools: tools }
      },
      null,
      2
    ),
    'utf8'
  )
  writeFileSync(join(dir, 'index.mjs'), mainSource, 'utf8')
  return dir
}

const TOOL_SCHEMA = {
  name: 'boom',
  description: '失败路径用的工具',
  parameters: { type: 'object', properties: {} }
}

// A. 激活时抛错
const throwDir = makePlugin(
  'ipi.fail-throw',
  'Fail Throw',
  `export async function activate() { throw new Error('夹具：激活时故意炸了') }\nexport const tools = {}\n`
)

// B. 激活正常，调用中途整个进程退出
const exitDir = makePlugin(
  'ipi.fail-exit',
  'Fail Exit',
  `export async function activate() {}
export const tools = {
  async boom() {
    // 直接退出：宿主那边那个 pending 调用必须被结算掉，而不是挂住。
    process.exit(7)
  }
}
`,
  [TOOL_SCHEMA]
)

// C. 激活时不回应（卡住）
const silentDir = makePlugin(
  'ipi.fail-silent',
  'Fail Silent',
  `export async function activate() { await new Promise(() => {}) }\nexport const tools = {}\n`
)

// D. 往 stdout 写非协议内容
const garbageDir = makePlugin(
  'ipi.fail-garbage',
  'Fail Garbage',
  `export async function activate() {
  process.stdout.write('这不是 JSON，插件不该把 stdout 当自家日志\\n')
  process.stdout.write('   \\n')
}
export const tools = { async boom() { return '没事' } }\n`,
  [TOOL_SCHEMA]
)

const logs = []
const host = new PluginHost({ log: (line) => logs.push(line), toolTimeoutMs: 8_000 })

function registerDir(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  const validation = validatePluginManifest(manifest)
  if (!validation.ok) throw new Error(`夹具 manifest 不合法：${JSON.stringify(validation.errors)}`)
  host.register(validation.manifest, dir)
  return validation.manifest.id
}

const stateOf = (id) => host.list().find((record) => record.id === id)

try {
  console.log('── A. 激活时抛错：宿主必须活下来，且说明原因 ──')
  const throwId = registerDir(throwDir)
  let throwError = null
  try {
    await host.activate(throwId)
  } catch (error) {
    throwError = error
  }
  check('激活抛错会向调用方抛出（而不是静默成功）', throwError !== null, String(throwError))
  check(
    '错误信息里带着插件自己给的原因',
    String(throwError?.message ?? '').includes('激活时故意炸了'),
    String(throwError?.message)
  )
  check('状态被标成 failed（UI 才显示得出来）', stateOf(throwId)?.state === 'failed', JSON.stringify(stateOf(throwId)))
  check(
    '失败原因被记下来（不是只有一个状态字）',
    String(stateOf(throwId)?.lastError ?? '').includes('激活时故意炸了'),
    JSON.stringify(stateOf(throwId)?.lastError)
  )
  /**
   * 这两条是**同一件事的两面**，必须分开看：
   * `state` 是记录，`running` 是事实。早期版本在失败路径上只改前者、不收后者 ——
   * 于是「状态 failed」和「进程还活着」同时成立，而只看状态的断言发现不了。
   */
  check('激活失败后，记录里标明子进程已经收掉', stateOf(throwId)?.running === false, JSON.stringify(stateOf(throwId)))

  console.log('\n── B. 激活时不回应：必须有上限，不能一直等 ──')
  const silentId = registerDir(silentDir)
  const silentStart = Date.now()
  let silentError = null
  try {
    await host.activate(silentId)
  } catch (error) {
    silentError = error
  }
  const silentMs = Date.now() - silentStart
  check('无响应的激活最终会失败（不是永远挂着）', silentError !== null, String(silentError))
  check(
    '失败原因是**超时**（15 秒上限）',
    /超时/.test(String(silentError?.message ?? '')),
    String(silentError?.message)
  )
  check(`有界等待：实测 ${Math.round(silentMs / 1000)} 秒 < 25 秒`, silentMs < 25_000, `${silentMs}ms`)
  check('超时后状态也是 failed', stateOf(silentId)?.state === 'failed', JSON.stringify(stateOf(silentId)))
  /**
   * **这条才是泄漏的直接判据。** 一个「激活时卡住、永不回应」的插件，
   * 如果失败路径不收掉它的进程，它就会一直活着（并占着插件目录，让用户删不掉）。
   * 注意它必须放在 `deactivateAll()` **之前** —— 否则收尾会把泄漏一起扫掉，
   * 断言看着全绿，问题却还在（第一版就是这么放错的）。
   */
  check(
    '超时失败后，子进程被收掉（不能留一个永远卡住的进程）',
    stateOf(silentId)?.running === false,
    JSON.stringify(stateOf(silentId))
  )

  console.log('\n── C. 调用中途进程退出：转成 isError，而不是挂住或抛异常 ──')
  const exitId = registerDir(exitDir)
  await host.activate(exitId)
  check('这个夹具本来能激活', stateOf(exitId)?.state === 'active', JSON.stringify(stateOf(exitId)))
  const exitCallStart = Date.now()
  const exitResult = await host.callTool(exitId, 'boom', {}, repoRoot)
  const exitCallMs = Date.now() - exitCallStart
  check('调用返回的是结果对象（没有抛异常）', typeof exitResult === 'object' && exitResult !== null, JSON.stringify(exitResult))
  check('被标成 isError（模型能据此换个做法）', exitResult.isError === true, JSON.stringify(exitResult))
  check(
    '内容里说明了是插件进程退出、以及退出码',
    /退出/.test(exitResult.content) && exitResult.content.includes('7'),
    exitResult.content
  )
  check(`没有拖到工具超时（实测 ${exitCallMs}ms < 8000ms）`, exitCallMs < 8_000, `${exitCallMs}ms`)
  check('进程退出后状态变成 failed', stateOf(exitId)?.state === 'failed', JSON.stringify(stateOf(exitId)))

  console.log('\n── D. 往 stdout 写非协议内容：丢弃并记录，不崩 ──')
  const garbageId = registerDir(garbageDir)
  let garbageOk = false
  try {
    await host.activate(garbageId)
    garbageOk = true
  } catch {
    garbageOk = false
  }
  check('杂音不影响激活成功', garbageOk && stateOf(garbageId)?.state === 'active', JSON.stringify(stateOf(garbageId)))
  check(
    '杂音被明确记成「丢弃无法解析的帧」（而不是静默吞掉）',
    logs.some((line) => line.includes('丢弃无法解析的帧')),
    JSON.stringify(logs.filter((line) => line.includes('丢弃')).slice(0, 2))
  )
  const garbageTool = await host.callTool(garbageId, 'boom', {}, repoRoot)
  check('杂音之后工具照常可用', garbageTool.isError === false && garbageTool.content === '没事', JSON.stringify(garbageTool))

  console.log('\n── E. 对照：坏插件之后，好插件照常工作 ──')
  const healthyManifest = JSON.parse(
    readFileSync(join(healthyDir, 'manifest.json'), 'utf8')
  )
  const healthyValidation = validatePluginManifest(healthyManifest)
  host.register(healthyValidation.manifest, healthyDir)
  const healthyId = healthyValidation.manifest.id
  const healed = await host.activate(healthyId)
  check('好插件仍然能激活（宿主没有被前面的失败污染）', healed.tools.includes('fixture_echo'), JSON.stringify(healed))
  const echo = await host.callTool(healthyId, 'fixture_echo', { text: 'still-alive' }, repoRoot)
  check(
    '好插件的工具照常执行（证明子进程机制本身没被搞坏）',
    echo.isError === false && JSON.parse(echo.content).echo === 'still-alive',
    echo.content
  )

  console.log('\n── F. activateAll：一个坏的不该挡住其他插件 ──')
  {
    const mixed = new PluginHost({ log: () => undefined, toolTimeoutMs: 5_000 })
    const mixedThrow = join(root, 'ipi-fail-throw')
    const mixedOk = healthyDir
    for (const dir of [mixedThrow, mixedOk]) {
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
      const validation = validatePluginManifest(manifest)
      mixed.register(validation.manifest, dir)
    }
    const failuresMap = await mixed.activateAll()
    check('activateAll 收集到了失败的那个', failuresMap.has('ipi.fail-throw'), JSON.stringify([...failuresMap.keys()]))
    check(
      'activateAll 没有把好插件一起算失败',
      !failuresMap.has('ipi.fixture-plugin'),
      JSON.stringify([...failuresMap.keys()])
    )
    check(
      '好插件在批量激活里确实起来了',
      mixed.list().find((record) => record.id === 'ipi.fixture-plugin')?.state === 'active',
      JSON.stringify(mixed.list().map((record) => `${record.id}:${record.state}`))
    )
    await mixed.deactivateAll()
  }

  console.log('\n── G. 收尾：deactivateAll 不留残余 ──')
  await host.deactivateAll()
  check(
    '所有插件都回到 inactive',
    host.list().every((record) => record.state === 'inactive'),
    JSON.stringify(host.list().map((record) => `${record.id}:${record.state}`))
  )
  console.log('\n── H. 失败路径不许留下活着的子进程 ──')
  /**
   * 判据用的是**插件目录能不能删掉**。
   *
   * 子进程的 `cwd` 就是插件目录（`spawn(..., { cwd: record.dir })`），
   * 所以只要还有一个活着的子进程，Windows 上 `rmSync` 就会 EPERM ——
   * 这比「看状态字」强得多：状态字可以是对的，而进程还在跑。
   *
   * 这条断言是有来历的：第一版自测的收尾就撞上了这个 EPERM，
   * 才暴露出「激活失败（抛错 / 超时）时漏杀子进程」这个真问题。
   */
  await new Promise((resolve) => setTimeout(resolve, 600))
  let removable = true
  try {
    for (const entry of ['ipi-fail-throw', 'ipi-fail-silent', 'ipi-fail-exit', 'ipi-fail-garbage']) {
      rmSync(join(root, entry), { recursive: true, force: true })
    }
  } catch {
    removable = false
  }
  check('失败过的插件目录都能删掉（= 没有子进程还占着它）', removable, root)
} catch (error) {
  failures += 1
  console.log(`  FAIL  自测自身出错: ${String(error)}`)
} finally {
  // 清理本身也容忍失败：**删不掉正是上面那条断言的证据**，不该让收尾再抛一次。
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    console.log(`  NOTE  临时目录删不掉（可能有子进程仍占着）：${root}`)
  }
}

console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
