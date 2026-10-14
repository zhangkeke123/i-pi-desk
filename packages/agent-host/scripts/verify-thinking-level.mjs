#!/usr/bin/env node
/**
 * 思考强度的自测：这一轮加的「用户能调档位」到底通没通。
 *
 * ## 为什么要单独一个脚本
 *
 * 档位这件事有三段，任何一段断了都只表现为「好像没什么区别」：
 *
 *   1. **校验**：非法值必须被**明确拒绝**，不能静默忽略 ——
 *      静默忽略会让用户以为自己调了档位，其实一直是默认。
 *   2. **接受**：合法值要真的能让内核把这一轮跑完（档位最终会进 provider 请求）。
 *   3. **换档**：内核只在**建会话**时收档位，所以中途改档位要靠「丢掉内核会话、
 *      下一条消息重建」。这条路必须被真跑过 —— 否则用户改完档位会遇到一个
 *      「没有任何反应的会话」，而现象上完全看不出原因。
 *
 * 用法：node scripts/verify-thinking-level.mjs
 *
 * ## 一条踩过的坑（写给下一个改这个脚本的人）
 *
 * `resolveApproval` 需要 **sessionId**；漏了它不会报「参数错」，而是那一轮永远挂在
 * 审批上 —— 于是整个脚本卡住，而卡住的地方看起来像是「假模型没响应」。
 * 所以这里把放行失败**打出来**，并且给每一轮加了硬超时（超时就判失败，
 * 绝不 await 一个可能永不 settle 的 promise）。
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')

const { AgentRuntime } = await import('../dist/runtime.js')

const MOCK_PORT = 8129
const BASE = `http://127.0.0.1:${MOCK_PORT}`
/** 单轮的硬上限：超过就判失败，避免整个脚本无声挂住。 */
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

const workspace = mkdtempSync(join(tmpdir(), 'ipi-think-ws-'))
const agentDir = mkdtempSync(join(tmpdir(), 'ipi-think-agent-'))

const provider = {
  id: 'think-provider',
  label: 'Think Mock',
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
  log: (line) => logs.push(line)
})
const logs = []

/**
 * 跑一轮，并自动放行审批。
 *
 * 硬超时是刻意的：这一段的失败模式就是「卡住」，而卡住时最没有信息量。
 */
async function runOnce(sessionId, text, thinkingLevel) {
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
      maxSteps: 10,
      ...(thinkingLevel === undefined ? {} : { thinkingLevel })
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
        // ⚠️ sessionId 不能省（见文件头那条坑）。
        runtime.resolveApproval({ sessionId, approvalId: event.approvalId, decision: 'allow-once' })
      } catch (error) {
        console.log(`  NOTE  放行审批失败：${String(error)}`)
      }
    }
    await new Promise((r) => setTimeout(r, 50))
  }

  if (result === undefined) {
    // 不 await 那个可能永不 settle 的 promise —— 直接判这一轮失败并收尾。
    try {
      await runtime.abortSession(sessionId)
    } catch {
      // 已经结束或不存在都无所谓。
    }
    return { stopReason: 'error', error: `这一轮在 ${RUN_TIMEOUT_MS}ms 内没有收尾（脚本主动判失败）` }
  }
  return result
}

try {
  await waitForMock()

  console.log('\n── ① 非法档位必须被明确拒绝（不能静默忽略）──')
  {
    const sink = sinkFor('think-a')
    const result = await runOnce('think-a', '写一个文件', 'bogus')
    check('非法档位不会让这一轮跑起来', result.stopReason === 'error', JSON.stringify(result))
    check(
      '错误信息点名了 thinkingLevel（用户能照着改）',
      String(result.error ?? '').includes('thinkingLevel'),
      String(result.error)
    )
    check(
      '错误信息列出了合法取值',
      String(result.error ?? '').includes('medium') && String(result.error ?? '').includes('xhigh'),
      String(result.error)
    )
    check(
      '被拒绝时不会产生任何工具调用（在发请求之前就挡住了）',
      sink.filter((e) => e.type === 'tool.started').length === 0,
      JSON.stringify(sink.map((e) => e.type))
    )
  }

  console.log('\n── ② 合法档位能真的跑完（档位最终会进 provider 请求）──')
  {
    const sink = sinkFor('think-b')
    const off = await runOnce('think-b', '写一个文件', 'off')
    check('档位 off 能跑完这一轮', off.stopReason === 'end_turn', JSON.stringify(off))
    check('确实发生了工具调用（不是空跑）', sink.some((e) => e.type === 'tool.started'), JSON.stringify(sink.map((e) => e.type)))
  }

  console.log('\n── ③ 中途换档位：重建内核会话，下一条消息仍然能跑 ──')
  {
    const sink = sinkFor('think-b')
    const high = await runOnce('think-b', '再写一个文件', 'high')
    check('换档位后这一轮仍然跑完（没有变成「没反应的会话」）', high.stopReason === 'end_turn', JSON.stringify(high))
    check(
      'runtime 明确记录了「丢弃内核会话以便重建」',
      logs.some((line) => line.includes('思考强度变化') && line.includes('丢弃内核会话')),
      logs.filter((line) => line.includes('思考强度')).join(' | ')
    )
    check('换档之后仍然发生了工具调用', sink.filter((e) => e.type === 'tool.started').length >= 2, JSON.stringify(sink.map((e) => e.type)))
  }

  console.log('\n── ④ 不传档位时按内核默认（不能因此报错）──')
  {
    const fallback = await runOnce('think-c', '写一个文件', undefined)
    check('不传档位也能跑完（交给内核默认）', fallback.stopReason === 'end_turn', JSON.stringify(fallback))
  }

  console.log(`\n（跑了 ${checks} 条断言）`)
  console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
} finally {
  mock.kill()
  rmSync(workspace, { recursive: true, force: true })
  rmSync(agentDir, { recursive: true, force: true })
}

process.exit(failures === 0 ? 0 : 1)
