#!/usr/bin/env node
/**
 * 审批等待超时自测。
 *
 * ## 为什么需要它
 *
 * 「审批等 5 分钟没裁决就按 deny 处理」这条逻辑一直写在代码里，但从没被**真跑过** ——
 * 因为它要 5 分钟。于是它长期躺在「未验证」清单里：
 * 代码看着对，但谁也没见过它触发，更没见过触发之后**运行真的继续下去了**。
 *
 * ## 这个自测怎么绕过 5 分钟
 *
 * `AgentRuntime` 的构造函数本来就把 `approvalTimeoutMs` 做成了可注入参数
 * （生产用默认值，测试传小值），所以**不需要给生产代码加任何测试开关**。
 * 这里用 800ms 跑机制，另外单独断言**默认值确实是 5 分钟**。
 *
 * `--real` 参数会用真实默认值跑一次完整的 5 分钟 —— 那是这条逻辑的最终证据，
 * 但它太慢，不适合放进常规验证链。
 *
 * ## 对照组是必需的
 *
 * 只断言「超时之后文件没被写」是不够的：如果工具调用这条路本来就不通，
 * 那条断言会**永远为真**。所以必须再跑一轮「手动放行」并断言**文件真的被写出来**，
 * 证明这条路径本身是通的。
 *
 * 用法：
 *   node scripts/verify-approval-timeout.mjs          # 快跑（默认，约 5 秒）
 *   node scripts/verify-approval-timeout.mjs --real   # 用真实的 5 分钟默认值跑一次
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')

const { AgentRuntime, DEFAULT_APPROVAL_TIMEOUT_MS } = await import('../dist/runtime.js')

const REAL = process.argv.includes('--real')
/** 快跑时用的注入值；--real 时不注入，走生产默认。 */
const SHORT_TIMEOUT_MS = 800
/** 判定「超时确实生效」的容忍窗口（快跑模式）。 */
const MIN_OK_MS = 600
const MAX_OK_MS = 5000

const MOCK_PORT = 8127
const BASE = `http://127.0.0.1:${MOCK_PORT}`

let failures = 0
function check(label, condition, detail = '') {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

const mock = spawn(
  process.execPath,
  [join(repoRoot, 'tools', 'mock-control-plane', 'server.mjs'), '--port', String(MOCK_PORT)],
  { stdio: ['ignore', 'pipe', 'pipe'] }
)
let mockLog = ''
mock.stdout.on('data', (chunk) => {
  mockLog += chunk.toString()
})
mock.stderr.on('data', (chunk) => {
  mockLog += chunk.toString()
})

const workspace = mkdtempSync(join(tmpdir(), 'ipi-timeout-ws-'))
const agentDir = mkdtempSync(join(tmpdir(), 'ipi-timeout-agent-'))
const WRITTEN = 'agent-wrote.txt'

const provider = {
  id: 'timeout-provider',
  label: 'Timeout Mock',
  apiStyle: 'openai-completions',
  baseUrl: `${BASE}/v1`,
  models: [{ id: 'mock-model' }],
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

async function waitForMock(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/__health`)
      if (response.ok) return
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`假模型启动超时。日志：\n${mockLog}`)
}

/** 造一个 runtime；`approvalTimeoutMs` 只在快跑模式注入。 */
function makeRuntime(sink, logs) {
  return new AgentRuntime({
    writeEvent: (_sessionId, event) => sink.push(event),
    log: (line) => logs.push(line),
    ...(REAL ? {} : { approvalTimeoutMs: SHORT_TIMEOUT_MS })
  })
}

async function waitFor(sink, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = sink.find(predicate)
    if (hit) return hit
    await new Promise((r) => setTimeout(r, 50))
  }
  return undefined
}

try {
  await waitForMock()

  console.log(REAL ? '── 真实默认值：5 分钟 ──' : `── 注入 ${SHORT_TIMEOUT_MS}ms 跑机制 ──`)

  // ── 第一轮：把审批放着不管，等它超时 ──
  const sinkA = []
  const logsA = []
  const runtimeA = makeRuntime(sinkA, logsA)
  const sessionA = 'timeout-session-a'
  const expectedTimeout = REAL ? DEFAULT_APPROVAL_TIMEOUT_MS : SHORT_TIMEOUT_MS

  const startedAt = Date.now()
  const promptA = runtimeA
    .prompt({
      provider,
      apiKey: 'ipi-local-no-auth',
      modelId: 'mock-model',
      // ask 模式：write 必须过审批闸门，这正是我们要等的那一步。
      permissionMode: 'ask',
      cwd: workspace,
      agentDir,
      sessionId: sessionA,
      text: '写一个文件',
      maxSteps: 10
    })
    .catch((error) => ({ stopReason: 'error', error: String(error) }))

  const requested = await waitFor(sinkA, (e) => e.type === 'approval.requested', 20_000)
  check('审批请求如期弹出（说明闸门在等我们裁决）', Boolean(requested), JSON.stringify(sinkA.map((e) => e.type)))
  check('审批就是那个需要闸门的 write', requested?.toolName === 'write', JSON.stringify(requested?.toolName))

  const requestedAt = Date.now()
  const resultA = await promptA
  const elapsed = Date.now() - requestedAt
  const totalElapsed = Date.now() - startedAt

  const timeoutLog = logsA.find((line) => /等待超时/.test(line))
  check('超时日志里带着本次生效的毫秒数', Boolean(timeoutLog) && timeoutLog.includes(String(expectedTimeout)), String(timeoutLog))

  if (REAL) {
    // 真实默认值：允许 ±20% 的调度误差（5 分钟不要求毫秒级精确）。
    const low = expectedTimeout * 0.8
    const high = expectedTimeout * 1.2
    check(
      `确实等满约 5 分钟才收尾（实际 ${Math.round(elapsed / 1000)}s）`,
      elapsed >= low && elapsed <= high,
      `期望 ${low}-${high}ms，实际 ${elapsed}ms`
    )
  } else {
    check(
      `超时按注入值生效（实际 ${elapsed}ms）`,
      elapsed >= MIN_OK_MS && elapsed <= MAX_OK_MS,
      `期望 ${MIN_OK_MS}-${MAX_OK_MS}ms，实际 ${elapsed}ms`
    )
    /** 上一条的下界很重要：它排除「立刻就 deny 了」这种**看似通过**的情况。 */
    check('不是立刻就 deny 的（否则上一条恒真）', elapsed >= MIN_OK_MS, `实际 ${elapsed}ms`)
  }

  check('超时之后这一轮**正常收尾**（没有永久挂住）', typeof resultA?.stopReason === 'string', JSON.stringify(resultA))
  check('超时没有把这一轮判成失败', resultA?.stopReason !== 'error', JSON.stringify(resultA?.stopReason))

  const toolFinishedA = sinkA.find((e) => e.type === 'tool.finished')
  check('工具调用被明确地标为未成功', toolFinishedA?.ok === false, JSON.stringify(toolFinishedA))
  check('超时判定为 deny 之后，文件**没有被写出来**', !existsSync(join(workspace, WRITTEN)), join(workspace, WRITTEN))
  check(`整轮耗时与超时量级一致（${Math.round(totalElapsed / 1000)}s）`, totalElapsed >= expectedTimeout * 0.5, `${totalElapsed}ms`)

  // ── 第二轮（对照组）：手动放行，文件必须真的被写出来 ──
  console.log('\n── 对照组：手动放行 ──')
  const sinkB = []
  const logsB = []
  const runtimeB = makeRuntime(sinkB, logsB)
  const sessionB = 'timeout-session-b'
  const workspaceB = mkdtempSync(join(tmpdir(), 'ipi-timeout-ws2-'))

  const promptB = runtimeB
    .prompt({
      provider,
      apiKey: 'ipi-local-no-auth',
      modelId: 'mock-model',
      permissionMode: 'ask',
      cwd: workspaceB,
      agentDir,
      sessionId: sessionB,
      text: '写一个文件',
      maxSteps: 10
    })
    .catch((error) => ({ stopReason: 'error', error: String(error) }))

  const requestedB = await waitFor(sinkB, (e) => e.type === 'approval.requested', 20_000)
  check('对照组也弹出了审批', Boolean(requestedB), JSON.stringify(sinkB.map((e) => e.type)))
  runtimeB.resolveApproval({ sessionId: sessionB, approvalId: requestedB?.approvalId, decision: 'allow-once' })

  const resultB = await promptB
  check('放行之后这一轮正常收尾', typeof resultB?.stopReason === 'string', JSON.stringify(resultB))
  check(
    '放行之后文件**真的被写出来**（证明这一条路径本身是通的）',
    existsSync(join(workspaceB, WRITTEN)),
    `目录内容：${JSON.stringify(
      // 只报文件名，避免把绝对路径刷屏。
      (await import('node:fs')).readdirSync(workspaceB)
    )}`
  )
  check('对照组没有触发超时日志', !logsB.some((line) => /等待超时/.test(line)), JSON.stringify(logsB.slice(-3)))

  // ── 默认值本身 ──
  console.log('\n── 默认值 ──')
  check(
    '默认审批超时是 5 分钟（改了要在这里看见）',
    DEFAULT_APPROVAL_TIMEOUT_MS === 5 * 60 * 1000,
    `实际 ${DEFAULT_APPROVAL_TIMEOUT_MS}ms`
  )

  // 顺带留一条痕迹：确认写出来的内容确实是假模型给的（不是凭空出现）。
  if (existsSync(join(workspaceB, WRITTEN))) {
    const content = readFileSync(join(workspaceB, WRITTEN), 'utf8')
    check('写出来的内容是假模型给的那份', content.includes('written-by-fake-model'), content.slice(0, 80))
  }

  rmSync(workspaceB, { recursive: true, force: true })
} catch (error) {
  failures += 1
  console.log(`  FAIL  自测自身出错: ${String(error)}\n${mockLog.slice(-500)}`)
} finally {
  mock.kill()
  rmSync(workspace, { recursive: true, force: true })
  rmSync(agentDir, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
