#!/usr/bin/env node
/**
 * 历史恢复（「重启后模型还记得吗」）自测。
 *
 * ## 它要证明的一件事
 *
 * 会话消息由主进程落盘，而内核的 `SessionManager` 是 `inMemory` 的。
 * 所以应用重启后会出现一个很别扭的状态：**界面上历史都在，模型却完全不记得**。
 *
 * 这个自测直接驱动 `AgentRuntime`（不启动 Electron），用「销毁一个 runtime、
 * 再建一个全新的」来模拟应用重启，然后断言：
 *
 *   带上落盘历史 → 内核恢复上下文（假模型收到的消息里能看到之前那几轮）
 *   不带落盘历史 → 只有本轮这一条（对照，证明上一条不是恒真）
 *
 * 后半句是必要的：只验「带历史时有两条」是不够的 —— 万一模型收到的角色序列
 * 本来就有两条，这条断言会永远为真。所以必须有一个**必须失败**的对照组。
 *
 * 用法：node scripts/verify-history.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')

const { AgentRuntime } = await import('../dist/runtime.js')

const MOCK_PORT = 8126
const BASE = `http://127.0.0.1:${MOCK_PORT}`

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

/** 假模型用纯文本模式：本次要验的是对话记忆，不该被工具调用与审批干扰。 */
const mock = spawn(
  process.execPath,
  [join(repoRoot, 'tools', 'mock-control-plane', 'server.mjs'), '--port', String(MOCK_PORT), '--text-only'],
  { stdio: ['ignore', 'pipe', 'pipe'] }
)
let mockLog = ''
mock.stdout.on('data', (c) => {
  mockLog += c.toString()
})
mock.stderr.on('data', (c) => {
  mockLog += c.toString()
})

const workspace = mkdtempSync(join(tmpdir(), 'ipi-history-ws-'))
const agentDir = mkdtempSync(join(tmpdir(), 'ipi-history-agent-'))

const provider = {
  id: 'history-provider',
  label: 'History Mock',
  apiStyle: 'openai-completions',
  baseUrl: `${BASE}/v1`,
  models: [{ id: 'mock-model' }],
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

const basePrompt = {
  provider,
  // 回环地址 → 客户端会注入占位 key（见 docs/ARCHITECTURE.md §6.4）。
  apiKey: 'ipi-local-no-auth',
  modelId: 'mock-model',
  permissionMode: 'auto',
  cwd: workspace,
  agentDir,
  maxSteps: 20
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

/**
 * 造一个 runtime。
 *
 * 事件是**构造时注入的推送出口**（`writeEvent`），不是订阅式 API ——
 * 这与 sidecar 的形态一致：它要把事件写进 stdout 协议流，而不是让别人来订阅。
 * 所以这里用一个可替换的 sink 来按轮收集。
 */
function makeRuntime() {
  const state = { sink: [] }
  const runtime = new AgentRuntime({
    writeEvent: (_sessionId, event) => state.sink.push(event),
    log: () => undefined
  })
  return { runtime, state }
}

/**
 * 跑一轮，并把「主进程会落盘的那些消息」收集出来。
 *
 * 刻意用**事件流**而不是自己编造历史：主进程落盘的正是 `message.committed`，
 * 这样自测走的就是真实链路，而不是我手写一份「我以为的历史」。
 */
async function runTurn(entry, sessionId, text, history) {
  entry.state.sink = []
  const result = await entry.runtime.prompt({ ...basePrompt, sessionId, text, history })
  return {
    result,
    collected: entry.state.sink.filter((event) => event.type === 'message.committed').map((event) => event.message)
  }
}

try {
  await waitForMock()
  console.log('── 第一轮：全新会话 ──')

  const entryA = makeRuntime()
  const sessionId = 'history-session'
  const first = await runTurn(entryA, sessionId, '我叫小明，请记住这个名字', undefined)

  check('第一轮正常结束', first.result?.stopReason === 'end_turn', JSON.stringify(first.result))
  check('收到了定稿消息（主进程会把它落盘）', first.collected.length >= 1, JSON.stringify(first.collected.length))

  const firstText = first.collected
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => m.parts.filter((p) => p.kind === 'text').map((p) => p.text))
    .join('')
  check('假模型回显了第一轮的输入（说明请求确实发出去了）', firstText.includes('我叫小明'), firstText)

  const afterFirst = await (await fetch(`${BASE}/__received`)).json()
  check('第一轮模型只看到一条 user 消息', (afterFirst.requests?.[0]?.roles ?? []).filter((r) => r === 'user').length === 1, JSON.stringify(afterFirst.requests?.[0]))

  // 模拟应用退出：整个 runtime 销毁（内核会话随之消失）。
  await entryA.runtime.shutdown()
  console.log('\n── 模拟重启：全新的 runtime（内核会话已不存在）──')

  console.log('\n[对照] 不带历史 → 模型应当「不记得」')
  const entryB = makeRuntime()
  const noHistory = await runTurn(entryB, sessionId, '我叫什么名字？', undefined)
  check('不带历史时本轮正常结束', noHistory.result?.stopReason === 'end_turn', JSON.stringify(noHistory.result))

  const afterNoHistory = await (await fetch(`${BASE}/__received`)).json()
  const noHistoryRequest = afterNoHistory.requests?.[afterNoHistory.requests.length - 1]
  check(
    '[对照] 模型只收到本轮这一条 user（确实失忆）',
    (noHistoryRequest?.roles ?? []).filter((r) => r === 'user').length === 1 &&
      !(noHistoryRequest?.roles ?? []).includes('assistant'),
    JSON.stringify(noHistoryRequest)
  )

  console.log('\n[本次修复] 带历史 → 模型应当「记得」')
  // 再销毁一次，确保下一个 runtime 是干净的内核会话。
  await entryB.runtime.shutdown()

  const history = first.collected
  check('待重放的历史非空', history.length > 0, JSON.stringify(history.length))

  const entryC = makeRuntime()
  const withHistory = await runTurn(entryC, sessionId, '我叫什么名字？', history)
  check('带历史时本轮正常结束', withHistory.result?.stopReason === 'end_turn', JSON.stringify(withHistory.result))

  const afterHistory = await (await fetch(`${BASE}/__received`)).json()
  const historyRequest = afterHistory.requests?.[afterHistory.requests.length - 1]
  const roles = historyRequest?.roles ?? []

  check(
    '模型收到了带历史的上下文（出现了上一轮的 user）',
    roles.filter((r) => r === 'user').length >= 2,
    JSON.stringify(roles)
  )
  check('上下文中出现了上一轮的 assistant 回复', roles.includes('assistant'), JSON.stringify(roles))
  check(
    '历史排在当前问题之前（顺序正确）',
    roles.lastIndexOf('user') === roles.length - 1,
    JSON.stringify(roles)
  )

  console.log('\n── 历史裁剪（避免冷启动第一轮就非常贵）──')
  const { toPiHistory, DEFAULT_MAX_HISTORY_MESSAGES } = await import('../dist/history.js')
  const many = Array.from({ length: 200 }, (_, index) => ({
    id: `m-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    createdAt: new Date(2026, 0, 1, 0, 0, index).toISOString(),
    parts: [{ kind: 'text', text: `消息 ${index}` }]
  }))

  const capped = toPiHistory(many, { providerId: 'p', api: 'openai-completions', model: 'm' })
  check(
    `条数被裁到上限（${DEFAULT_MAX_HISTORY_MESSAGES}）`,
    capped.length === DEFAULT_MAX_HISTORY_MESSAGES,
    String(capped.length)
  )
  check(
    '保留的是最近的消息（不是最早的）',
    JSON.stringify(capped[capped.length - 1]).includes('消息 199'),
    JSON.stringify(capped[capped.length - 1]?.content)
  )

  /**
   * 字符预算。
   *
   * 断言的是「总量不超预算」而不是「条数小于某个数」—— 后者要求断言者自己
   * 算出每条消息多长，算错一次就会误报（第一次写这条时就犯了这个错：
   * `消息 199` 是 6 个字符，30 的预算正好装 5 条）。
   * 直接量总量才是这条不变式本身。
   */
  const budget = 30
  const tinyBudget = toPiHistory(many, { providerId: 'p', api: 'openai-completions', model: 'm', maxChars: budget })
  const usedChars = tinyBudget.reduce((sum, message) => {
    const content = message.content
    const text = typeof content === 'string' ? content : content.map((part) => part.text ?? '').join('')
    return sum + text.length
  }, 0)

  check(`字符预算生效（实际 ${usedChars} ≤ ${budget}）`, usedChars <= budget, String(usedChars))
  check('字符预算确实裁掉了内容（比上限条数少得多）', tinyBudget.length < 10, String(tinyBudget.length))
  check('字符预算下至少保留最后一条（否则历史会完全为空）', tinyBudget.length >= 1, String(tinyBudget.length))

  const toolOnly = toPiHistory(
    [{ id: 'x', role: 'assistant', createdAt: new Date().toISOString(), parts: [{ kind: 'tool-call', toolName: 'write' }] }],
    { providerId: 'p', api: 'openai-completions', model: 'm' }
  )
  check('只有工具调用、没有正文的消息被丢弃（避免工具调用与结果配对断裂）', toolOnly.length === 0, JSON.stringify(toolOnly))

  const noParts = toPiHistory(
    [{ id: 'y', role: 'user', createdAt: new Date().toISOString(), parts: [{ kind: 'reasoning', text: '想想' }] }],
    { providerId: 'p', api: 'openai-completions', model: 'm' }
  )
  check('只有思考片段的消息被丢弃（重放思考没有意义）', noParts.length === 0, JSON.stringify(noParts))

  console.log('\n── 角色交替（Anthropic 类接口的硬要求）──')
  /**
   * 丢掉「只有工具调用」的 assistant 消息后，原本的回合边界会消失，
   * 于是出现相邻同角色。Anthropic 的 Messages API 明确要求交替，会直接 400 ——
   * 所以转换时必须合并，否则「重放历史」会变成「整个会话再也发不出请求」。
   */
  const alternating = toPiHistory(
    [
      { id: 'a', role: 'user', createdAt: new Date().toISOString(), parts: [{ kind: 'text', text: '第一句' }] },
      // 只有工具调用 → 会被丢弃 → 如果不合并就会出现 user,user
      { id: 'b', role: 'assistant', createdAt: new Date().toISOString(), parts: [{ kind: 'tool-call', toolName: 'read' }] },
      { id: 'c', role: 'user', createdAt: new Date().toISOString(), parts: [{ kind: 'text', text: '第二句' }] },
      { id: 'd', role: 'assistant', createdAt: new Date().toISOString(), parts: [{ kind: 'text', text: '回一句' }] }
    ],
    { providerId: 'p', api: 'openai-completions', model: 'm' }
  )
  // 输入 4 条 → 丢掉「只有工具调用」的那条 → 剩下两条 user 合并 → 2 条。
  check('相邻同角色被合并', alternating.length === 2, JSON.stringify(alternating.map((m) => m.role)))
  check(
    '角色严格交替',
    alternating.every((message, index) => index === 0 || message.role !== alternating[index - 1].role),
    JSON.stringify(alternating.map((m) => m.role))
  )
  check(
    '被合并的两条 user 文本都保留了',
    JSON.stringify(alternating[0].content).includes('第一句') && JSON.stringify(alternating[0].content).includes('第二句'),
    JSON.stringify(alternating[0].content)
  )

  console.log('\n── 悬挂的提问（问了但没得到回复）──')
  /**
   * 落盘历史里出现「没有回复的 user 消息」是常态：用户提问后关掉应用、
   * 或者那一轮因为模型端不可达而失败。留着它就会与本次提问形成 `user, user`，
   * 而 Anthropic 会因此直接 400。
   */
  const dangling = toPiHistory(
    [
      { id: 'a', role: 'user', createdAt: new Date().toISOString(), parts: [{ kind: 'text', text: '有回复的问题' }] },
      { id: 'b', role: 'assistant', createdAt: new Date().toISOString(), parts: [{ kind: 'text', text: '回复' }] },
      { id: 'c', role: 'user', createdAt: new Date().toISOString(), parts: [{ kind: 'text', text: '没得到回复的问题' }] }
    ],
    { providerId: 'p', api: 'openai-completions', model: 'm' }
  )
  check('尾部悬挂的 user 被丢掉', dangling.length === 2, JSON.stringify(dangling.map((m) => m.role)))
  check('结尾是 assistant（不会与本次提问撞成 user,user）', dangling[dangling.length - 1]?.role === 'assistant', JSON.stringify(dangling.map((m) => m.role)))

  const allDangling = toPiHistory(
    [{ id: 'a', role: 'user', createdAt: new Date().toISOString(), parts: [{ kind: 'text', text: '只有提问' }] }],
    { providerId: 'p', api: 'openai-completions', model: 'm' }
  )
  check('全是悬挂提问时结果为空（没什么可记的）', allDangling.length === 0, JSON.stringify(allDangling))

  console.log('\n── 裁剪切断点落在 assistant 上（Anthropic 会因为首条不是 user 而 400）──')
  /**
   * 裁剪是「从最近往前取」，切断点落在哪条上是随机的。落在 assistant 上时，
   * 重放序列就有了一个**没有对应提问的回答**打头。
   *
   * Anthropic 的 Messages API 要求首条必须是 `user`，而 pi **不会**替我们修正
   * （实测：把这种序列喂进真实请求构建，它原样发出）。
   * 更完整的证据在 `verify-anthropic-history.mjs`：那边是拦下 fetch 看真实报文。
   */
  const sixTurns = []
  for (let turn = 1; turn <= 4; turn += 1) {
    sixTurns.push({ id: `u${turn}`, role: 'user', createdAt: new Date().toISOString(), parts: [{ kind: 'text', text: `问题${turn}` }] })
    sixTurns.push({ id: `a${turn}`, role: 'assistant', createdAt: new Date().toISOString(), parts: [{ kind: 'text', text: `回答${turn}` }] })
  }
  const oddBudget = toPiHistory(sixTurns, { providerId: 'p', api: 'anthropic-messages', model: 'm', maxMessages: 3 })
  check(
    '预算为奇数时不再以 assistant 开头',
    oddBudget.length === 0 || oddBudget[0].role === 'user',
    JSON.stringify(oddBudget.map((m) => m.role))
  )
  check('丢掉首条 assistant 之后仍有内容', oddBudget.length >= 2, JSON.stringify(oddBudget.map((m) => m.role)))

  const onlyAssistant = toPiHistory(
    [{ id: 'a', role: 'assistant', createdAt: new Date().toISOString(), parts: [{ kind: 'text', text: '孤零零的回答' }] }],
    { providerId: 'p', api: 'anthropic-messages', model: 'm' }
  )
  check('整段历史只有 assistant 时结果为空（没有可以单独重放的内容）', onlyAssistant.length === 0, JSON.stringify(onlyAssistant))

  /** 每个预算都必须满足两条硬要求：非空时以 user 开头、角色严格交替。 */
  let allCutsOk = true
  const cutShapes = []
  for (let budget = 1; budget <= 8; budget += 1) {
    const replay = toPiHistory(sixTurns, { providerId: 'p', api: 'anthropic-messages', model: 'm', maxMessages: budget })
    const roles = replay.map((m) => m.role)
    cutShapes.push(`${budget}:${roles.join(',') || '(空)'}`)
    if (roles.length > 0 && roles[0] !== 'user') allCutsOk = false
    for (let i = 1; i < roles.length; i += 1) if (roles[i] === roles[i - 1]) allCutsOk = false
  }
  check('所有裁剪预算下都满足「非空则以 user 开头 + 严格交替」', allCutsOk, cutShapes.join(' | '))

  await entryC.runtime.shutdown()
} catch (error) {
  failures += 1
  console.log(`  FAIL  自测自身出错: ${String(error)}`)
  console.log(`        假模型日志：${mockLog.slice(-800)}`)
} finally {
  mock.kill()
  await new Promise((r) => setTimeout(r, 400))
  for (const dir of [workspace, agentDir]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // 清理失败不影响结论
    }
  }
}

console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
