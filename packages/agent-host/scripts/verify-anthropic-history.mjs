#!/usr/bin/env node
/**
 * 重放历史在**真实 Anthropic 请求构建**下是否合法。
 *
 * ## 为什么不能只靠自己写的规则断言
 *
 * 我们原来的断言是「角色严格交替」—— 那是**我自己写的规则**，
 * 拿它去检查**我自己写的代码**，只能证明前后一致，证明不了「Anthropic 会接受」。
 * 而这两件事曾经真的不一致：历史裁剪的切断点落在 assistant 上时，
 * 重放序列会以 assistant 开头，而 Anthropic 的 Messages API 要求首条必须是 `user`。
 *
 * 所以这里换一种证法：**驱动 pi 真实的 Anthropic 请求构建，拦下 fetch，
 * 检查真正会发出去的报文**。这才是厂商会看到的东西。
 *
 * ## 两个断言方向
 *
 *  1. 「pi 不会替我们兜住」—— 把一个以 assistant 开头的序列直接喂进去，
 *     报文里首条依然是 assistant。这条证明了危险是真实的（而不是理论上的）。
 *     将来 pi 若开始自动修正，这条会翻转，提醒我们可以简化自己的防护。
 *  2. 「我们重放出来的序列是合法的」—— 对同一份会话取各种裁剪预算，
 *     每条报文的首条都是 user、角色严格交替、没有空内容块。
 *
 * 用法：node scripts/verify-anthropic-history.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const { normalizeContext } = await import('@earendil-works/pi-ai')
const { ModelRuntime } = await import('@earendil-works/pi-coding-agent')
const { toPiHistory } = await import('../dist/history.js')
const { toPiProviderInput } = await import('../dist/provider.js')

let failures = 0
function check(label, condition, detail = '') {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

// ── 拦下 fetch：把「真正会发出去的报文」抓出来 ──
const captured = []
globalThis.fetch = async (_url, init) => {
  captured.push(init?.body ? JSON.parse(init.body) : null)
  /**
   * 返回一个最小的、结构合法的 Anthropic 流式响应，让 pi 能正常收尾。
   * 内容是假的没关系 —— 我们只关心**请求**长什么样。
   */
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-4-20250514","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    ''
  ].join('\n')
  return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const MODEL_ID = 'claude-sonnet-4-20250514'
const runtime = await ModelRuntime.create({ modelsPath: null })
runtime.registerProvider(
  'verify-anthropic',
  toPiProviderInput(
    {
      id: 'verify-anthropic',
      label: 'Anthropic (verify)',
      apiStyle: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
      models: [{ id: MODEL_ID, label: 'Claude Sonnet 4', supportsTools: true, supportsReasoning: false }],
      enabled: true
    },
    'sk-test',
    MODEL_ID
  )
)
const model = runtime.getModel('verify-anthropic', MODEL_ID)
if (!model) throw new Error('拿不到 anthropic 模型定义')

/** 走一遍真实请求构建，返回发出去的报文。 */
async function send(messages, tools = []) {
  captured.length = 0
  const context = normalizeContext({ messages, tools })
  const streamResult = runtime.stream(model, context, { apiKey: 'sk-test' })
  // 消费掉流：构建请求发生在开始时，但要把流读干净才好断言。
  const events = []
  for await (const event of streamResult) events.push(event)
  void events
  return captured[0] ?? null
}

const user = (text, timestamp) => ({ role: 'user', content: [{ type: 'text', text }], timestamp })
const assistant = (text, timestamp) => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  api: 'anthropic-messages',
  provider: 'verify-anthropic',
  model: MODEL_ID,
  timestamp
})

/** 报文的角色序列 + 是否满足 Anthropic 的硬要求。 */
function inspect(body) {
  const messages = body?.messages ?? []
  const roles = messages.map((m) => m.role)
  const emptyContent = messages.some((m) => {
    if (typeof m.content === 'string') return m.content.length === 0
    if (Array.isArray(m.content)) return m.content.length === 0
    return true
  })
  let alternating = true
  for (let i = 1; i < roles.length; i += 1) if (roles[i] === roles[i - 1]) alternating = false
  return { roles, emptyContent, alternating, startsWithUser: roles.length === 0 || roles[0] === 'user' }
}

try {
  console.log('── 一、先证明危险是真的：pi 不会替我们兜住 ──')
  const raw = await send([assistant('回答一', 1), user('问题二', 2), assistant('回答二', 3)])
  const rawShape = inspect(raw)
  check(
    '以 assistant 开头的序列会被**原样发出**（首条仍是 assistant）',
    rawShape.roles[0] === 'assistant',
    JSON.stringify(rawShape.roles)
  )
  check('也就是说这类序列不满足 Anthropic 的「首条必须是 user」', rawShape.startsWithUser === false, JSON.stringify(rawShape.roles))

  console.log('\n── 二、我们重放出来的序列必须合法 ──')

  /** 造一份会话：多轮问答，且交替（真实落盘的形状）。 */
  const transcript = []
  for (let turn = 1; turn <= 6; turn += 1) {
    transcript.push({
      id: `u${turn}`,
      role: 'user',
      createdAt: '2026-01-01T00:00:00.000Z',
      parts: [{ kind: 'text', text: `第 ${turn} 个问题` }]
    })
    transcript.push({
      id: `a${turn}`,
      role: 'assistant',
      createdAt: '2026-01-01T00:00:01.000Z',
      parts: [{ kind: 'text', text: `第 ${turn} 个回答` }]
    })
  }

  const options = { providerId: 'verify-anthropic', api: 'anthropic-messages', model: MODEL_ID }

  /**
   * 模拟**修复前**的序列（只做裁剪 + 丢尾部 user，不丢首条 assistant）。
   *
   * 为什么要在这里重写一遍选择逻辑：为了证明「这些预算确实会制造出病态输入」。
   * 否则上面那些「首条是 user」的断言可能只是**没碰到问题**，而不是解决了问题。
   * 这段代码描述的是**旧行为**，因此不会随修复漂移 —— 它就该一直这么短。
   */
  function preFixSequence(budget) {
    const picked = []
    for (let index = transcript.length - 1; index >= 0 && picked.length < budget; index -= 1) {
      const message = transcript[index]
      const text = (message.parts ?? []).filter((p) => p.kind === 'text').map((p) => p.text).join('')
      if (!text) continue
      picked.push({ role: message.role, text })
    }
    picked.reverse()
    // 合并相邻同角色（旧逻辑也有这一步）
    const merged = []
    for (const item of picked) {
      if (merged.length > 0 && merged[merged.length - 1].role === item.role) {
        merged[merged.length - 1].text += `\n\n${item.text}`
      } else merged.push({ ...item })
    }
    // 丢尾部悬挂 user（旧逻辑也有这一步）
    while (merged.length > 0 && merged[merged.length - 1].role === 'user') merged.pop()
    return merged.map((m) => m.role)
  }

  const budgets = [1, 2, 3, 4, 5, 7, 8, 11, 12]
  const results = []
  for (const budget of budgets) {
    const replay = toPiHistory(transcript, { ...options, maxMessages: budget })
    const body = await send(replay, [])
    const shape = inspect(body)
    results.push({ budget, preFixRoles: preFixSequence(budget), replayRoles: replay.map((m) => m.role), ...shape })
  }

  for (const result of results) {
    check(
      `预算 ${result.budget}：报文中首条是 user`,
      result.startsWithUser,
      `重放序列=${JSON.stringify(result.replayRoles)} → 报文=${JSON.stringify(result.roles)}`
    )
    check(`预算 ${result.budget}：角色严格交替`, result.alternating, JSON.stringify(result.roles))
    check(`预算 ${result.budget}：没有空内容块`, !result.emptyContent, JSON.stringify(result.roles))
  }

  /**
   * 覆盖性证据：必须**真的有**预算会让修复前的序列以 assistant 开头。
   * 没有这一条，整个第二节都可能是空转。
   */
  const buggy = results.filter((result) => result.preFixRoles[0] === 'assistant')
  check(
    '有预算确实会制造出「以 assistant 开头」的病态序列（否则第二节是空转）',
    buggy.length > 0,
    `各预算的修复前序列：${JSON.stringify(results.map((r) => ({ b: r.budget, roles: r.preFixRoles })))}`
  )
  check(
    '而那些预算下，我们交给 pi 的序列首条都是 user',
    buggy.every((result) => result.replayRoles.length === 0 || result.replayRoles[0] === 'user'),
    JSON.stringify(buggy.map((r) => ({ b: r.budget, roles: r.replayRoles })))
  )
  /** 丢掉首条 assistant 之后不该把整段历史也弄没：非空预算应当仍有内容可重放。 */
  check(
    '丢掉首条 assistant 之后历史没有整体变空',
    results.filter((r) => r.budget >= 2).every((r) => r.replayRoles.length > 0),
    JSON.stringify(results.map((r) => ({ b: r.budget, len: r.replayRoles.length })))
  )

  /**
   * 直接构造那个病态输入：手工造一份「以 assistant 开头」的重放结果，
   * 走一遍真实请求，确认它**会**发出 assistant 开头（对照组）。
   * 与第二节合起来说明：问题真实存在，且我们的转换把它挡住了。
   */
  console.log('\n── 三、把病态序列直接喂进 pi（对照，必须失败）──')
  const badShape = inspect(await send([assistant('残片回答', 1)], []))
  check(
    '单独一条 assistant 也会被原样发出',
    badShape.roles.length === 0 || badShape.roles[0] === 'assistant',
    JSON.stringify(badShape.roles)
  )

  const workspace = mkdtempSync(join(tmpdir(), 'ipi-anth-'))
  rmSync(workspace, { recursive: true, force: true })
} catch (error) {
  failures += 1
  console.log(`  FAIL  自测自身出错: ${String(error)}`)
}

console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
