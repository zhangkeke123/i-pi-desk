#!/usr/bin/env node
/**
 * maxSteps（限额）的语义自测 —— 以及一条**如实的覆盖缺口**。
 *
 * ## 这一轮实际学到的事
 *
 * 原本想在这里验「maxSteps=1 → 这一轮以 max_steps 收尾」。真跑之后发现**不会**：
 * 假模型的回复在一轮里就结束了（一次 write + 一段文本），而内核的 maxSteps 计的是
 * **模型轮数** —— 单轮任务永远撞不到它。
 *
 * 所以这个脚本改成钉住**真实语义**（这是有价值的：语义被写下来，改动会被看见）：
 *
 *   ① maxSteps=1 时，单轮任务仍然正常 end_turn（不是 max_steps）；
 *   ② 也不是 error —— 上限不该把正常收尾变成失败；
 *   ③ 这一轮确实干了活（有工具调用）—— 否则 ① 可能只是「什么都没发生」。
 *
 * ## 如实记下的覆盖缺口
 *
 * **max_steps 的正面路径目前没有任何自动化覆盖**：要触发它需要一个**连续多轮调用工具**
 * 的假模型（现在的假模型一轮就停）。界面上那句通知的文案由
 * `apps/desktop/src/lib/run-status.ts` 的 `maxStepsNotice()` 生成，那一句由单测覆盖
 * （带具体步数、指向设置位置、说明什么被保住了）；界面上「不该常驻」由
 * verify:renderer 的反面断言覆盖。缺的只是「真的撞上之后那句话出现在屏幕上」。
 *
 * 这条缺口写进了 docs/UI-DESIGN.md 的验收清单，不假装它被盖住了。
 *
 * 用法：node scripts/verify-max-steps.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')

const { AgentRuntime } = await import('../dist/runtime.js')

const MOCK_PORT = 8133
const BASE = `http://127.0.0.1:${MOCK_PORT}`
const RUN_TIMEOUT_MS = 20_000

let failures = 0
let checks = 0
function check(label, condition, detail = '') {
  checks += 1
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

const workspace = mkdtempSync(join(tmpdir(), 'ipi-steps-ws-'))
const agentDir = mkdtempSync(join(tmpdir(), 'ipi-steps-agent-'))

const provider = {
  id: 'steps-provider',
  label: 'Steps Mock',
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

const sinks = new Map()
const sinkFor = (sessionId) => {
  if (!sinks.has(sessionId)) sinks.set(sessionId, [])
  return sinks.get(sessionId)
}
const runtime = new AgentRuntime({
  writeEvent: (sessionId, event) => sinkFor(sessionId).push(event),
  log: () => {}
})

async function runOnce(sessionId, text, maxSteps) {
  const sink = sinkFor(sessionId)
  const before = sink.length
  const prompt = runtime
    .prompt({
      provider,
      apiKey: 'ipi-local-no-auth',
      modelId: 'mock-model',
      permissionMode: 'ask',
      cwd: workspace,
      agentDir,
      sessionId,
      text,
      maxSteps
    })
    .then(
      (value) => value,
      (error) => ({ stopReason: 'error', error: String(error && error.message ? error.message : error) })
    )

  let result
  prompt.then((value) => {
    result = value
  })

  const deadline = Date.now() + RUN_TIMEOUT_MS
  const handled = new Set()
  while (result === undefined && Date.now() < deadline) {
    for (const event of sink.slice(before)) {
      if (event.type !== 'approval.requested' || handled.has(event.approvalId)) continue
      handled.add(event.approvalId)
      try {
        runtime.resolveApproval({ sessionId, approvalId: event.approvalId, decision: 'allow-once' })
      } catch (error) {
        console.log(`  NOTE  放行审批失败：${String(error)}`)
      }
    }
    await new Promise((r) => setTimeout(r, 50))
  }

  if (result === undefined) {
    try {
      await runtime.abortSession(sessionId)
    } catch {
      // 无所谓
    }
    return { result: { stopReason: 'error', error: '这一轮没有收尾' }, events: sink.slice(before) }
  }
  return { result, events: sink.slice(before) }
}

try {
  await waitForMock()

  console.log('\n── maxSteps 是「模型轮数」上限：单轮任务不会撞上它 ──')
  {
    const cramped = await runOnce('steps-a', '写一个文件', 1)
    check(
      'maxSteps=1 时单轮任务仍然 normal end_turn（这条钉住内核的语义）',
      cramped.result?.stopReason === 'end_turn',
      JSON.stringify(cramped.result)
    )
    check('也不是 error（上限不该把正常收尾变成失败）', cramped.result?.stopReason !== 'error', JSON.stringify(cramped.result))
    check(
      '这一轮确实干了活（有工具调用）——否则上一条可能只是「什么都没发生」',
      cramped.events.some((event) => event.type === 'tool.finished'),
      JSON.stringify(cramped.events.map((event) => event.type))
    )
  }

  console.log('\n── 上限足够大时行为一致（说明上一条不是因为上限太小而「跳过」了什么）──')
  {
    const roomy = await runOnce('steps-b', '写一个文件', 20)
    check('上限 20 时也是 end_turn', roomy.result?.stopReason === 'end_turn', JSON.stringify(roomy.result))
    check(
      '两次都完成了工具调用',
      roomy.events.some((event) => event.type === 'tool.finished'),
      JSON.stringify(roomy.events.map((event) => event.type))
    )
  }

  console.log('\n── 覆盖缺口（写下来，不假装盖住了）──')
  console.log('  NOTE  max_steps 的正面路径需要「连续多轮调用工具」的假模型；')
  console.log('  NOTE  现在的假模型一轮就结束，所以撞上限这条路在所有测试层都不可达。')
  console.log('  NOTE  UI 那句通知的文案由 lib/run-status.ts 的单测覆盖；「不该常驻」由 verify:renderer 覆盖。')

  console.log(`\n（跑了 ${checks} 条断言）`)
  console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
} finally {
  mock.kill()
  rmSync(workspace, { recursive: true, force: true })
  rmSync(agentDir, { recursive: true, force: true })
}

process.exit(failures === 0 ? 0 : 1)
