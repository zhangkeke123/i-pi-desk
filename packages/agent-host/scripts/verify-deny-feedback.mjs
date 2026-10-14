#!/usr/bin/env node
/**
 * 拒绝之后，**模型看到了什么**。
 *
 * ## 为什么需要它
 *
 * 闸门在 `deny` 时返回的是 \`{ block: true, reason: "用户拒绝执行 write。请换一种方式，或先征得用户同意。" }\`
 * （见 `approval.ts`）。注释里写着「这句会作为工具结果回给模型」—— 但那是**pi 的行为**，
 * 不是我们能决定的：它完全可能只把这次调用标成失败，而把 reason 丢掉。
 *
 * 这件事的后果很具体：
 *
 *  - 模型**看到了拒绝** → 它会换个方式，或者问用户（这正是我们想要的）；
 *  - 模型**没看到**（只看到「工具失败了」或空结果）→ 它很可能**再试一次同样的写入**，
 *    用户就会在几秒内被同一张审批卡连问三次，而且完全不知道 agent 在干什么。
 *
 * 所以这一条必须对着**真实的内核**验，而不是读我们自己的注释。
 *
 * ## 怎么验
 *
 * 假模型在续轮里**把收到的工具结果原样回显**出来。于是「模型看到了什么」变成
 * 一句断言，而不是一句推测。两条路径都验：
 *
 *  1. 用户在审批里点「拒绝」；
 *  2. 只读模式下**不问**直接拦下。
 *
 * 两条各配一个**对照**：放行那一轮的回显里不该出现拒绝字样，且文件真的被写出来 ——
 * 否则「回显里有拒绝字样」可能是因为回显机制本身在说别的东西。
 *
 * 用法：node scripts/verify-deny-feedback.mjs
 */

import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const { AgentRuntime } = await import('../dist/runtime.js')

let failures = 0
function check(label, condition, detail = '') {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

const TARGET = 'deny-feedback.txt'
/** 每次写入的内容不同，免得「内容一样 → 没有差异」干扰审批预览。 */
let writeCount = 0
const nextContent = () => `deny-feedback-content-${++writeCount}`

/** 记录每一次请求体，好检查模型到底收到了什么。 */
const received = []

function streamFor(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const lastMessage = messages[messages.length - 1]
  const base = { id: 'chatcmpl-deny', object: 'chat.completion.chunk', created: 1, model: 'deny-model' }
  const wrap = (delta, finishReason = null) => ({
    ...base,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  })

  if (lastMessage?.role === 'tool') {
    // 把工具结果**原样回显**进收尾正文 —— 「模型看到了什么」于是可断言。
    const echoed = typeof lastMessage.content === 'string' ? lastMessage.content : JSON.stringify(lastMessage.content)
    return [
      wrap({ role: 'assistant', content: `工具回传说：${echoed.slice(0, 400)}` }),
      {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 }
      }
    ]
  }

  return [
    wrap({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          index: 0,
          id: `call_${Date.now()}`,
          type: 'function',
          function: { name: 'write', arguments: JSON.stringify({ path: TARGET, content: nextContent() }) }
        }
      ]
    }),
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 }
    }
  ]
}

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk.toString()
  })
  req.on('end', () => {
    let body = null
    try {
      body = JSON.parse(raw)
    } catch {
      body = null
    }
    received.push(body)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    for (const chunk of streamFor(body)) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`

const workspace = mkdtempSync(join(tmpdir(), 'ipi-deny-ws-'))
const agentDir = mkdtempSync(join(tmpdir(), 'ipi-deny-agent-'))

const provider = {
  id: 'deny-provider',
  label: 'Deny Mock',
  apiStyle: 'openai-completions',
  baseUrl,
  models: [{ id: 'deny-model' }],
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

const sink = []
const logs = []
const runtime = new AgentRuntime({
  writeEvent: (_sessionId, event) => sink.push(event),
  log: (line) => logs.push(line)
})

/** 跑一轮；`decide` 为 null 表示不裁决（只读模式那种不问就拦的情况）。 */
async function runRound({ sessionId, permissionMode, decide, label }) {
  const from = sink.length
  const fromRequests = received.length
  const promise = runtime
    .prompt({
      provider,
      apiKey: 'ipi-local-no-auth',
      modelId: 'deny-model',
      permissionMode,
      cwd: workspace,
      agentDir,
      sessionId,
      text: '写一个文件',
      maxSteps: 10
    })
    .catch((error) => ({ stopReason: 'error', error: String(error) }))

  const resolved = new Set()
  let running = true
  const poller = (async () => {
    while (running) {
      for (const event of sink.slice(from)) {
        if (event.type !== 'approval.requested') continue
        if (resolved.has(event.approvalId)) continue
        resolved.add(event.approvalId)
        if (decide) runtime.resolveApproval({ sessionId, approvalId: event.approvalId, decision: decide })
      }
      await new Promise((r) => setTimeout(r, 50))
    }
  })()

  const result = await Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ stopReason: 'test-timeout' }), 60_000))
  ])
  running = false
  await poller

  const mine = sink.slice(from)
  const requests = received.slice(fromRequests)
  /** 第二次请求（带着工具结果的那次）——里面就是「模型看到了什么」。 */
  const followUp = requests.find((body) => (body?.messages ?? []).some((message) => message.role === 'tool'))
  const toolMessage = (followUp?.messages ?? []).find((message) => message.role === 'tool')
  /** 模型这一轮被允许调用哪些工具（请求体里的 tools 就是它的「可见世界」）。 */
  const offeredTools = (requests[0]?.tools ?? []).map((tool) => tool?.function?.name ?? tool?.name).filter(Boolean)
  if (result?.stopReason === 'test-timeout' || result?.stopReason === 'error') {
    console.log(`        [${label}] 事件：${JSON.stringify(mine.map((e) => e.type))}`)
    console.log(`        [${label}] 日志尾部：\n          ${logs.slice(-8).join('\n          ')}`)
  }
  return {
    result,
    approvals: mine.filter((e) => e.type === 'approval.requested').length,
    toolFinished: mine.find((e) => e.type === 'tool.finished'),
    toolContent: typeof toolMessage?.content === 'string' ? toolMessage.content : null,
    offeredTools
  }
}

try {
  console.log('── 路径一：用户在审批里点「拒绝」 ──')
  const denied = await runRound({ sessionId: 'deny-session', permissionMode: 'ask', decide: 'deny', label: '拒绝' })
  check('审批确实弹出来过', denied.approvals === 1, String(denied.approvals))
  check('这一轮正常收尾（拒绝不是崩溃）', typeof denied.result?.stopReason === 'string', JSON.stringify(denied.result))
  check('工具被明确标为未成功', denied.toolFinished?.ok === false, JSON.stringify(denied.toolFinished))
  check('文件没有被写出来', !existsSync(join(workspace, TARGET)), join(workspace, TARGET))
  check('模型**确实收到了**一条工具结果（不是空的历史）', typeof denied.toolContent === 'string', JSON.stringify(denied.toolContent))
  check(
    '那条工具结果里写的是「被拒绝」而不是「成功」',
    typeof denied.toolContent === 'string' && /拒绝/.test(denied.toolContent) && !/已写入|成功/.test(denied.toolContent),
    JSON.stringify(denied.toolContent)
  )
  check(
    '而且它是一句**给模型看的行动建议**（不是只给用户看的「已拒绝」）',
    typeof denied.toolContent === 'string' && /换一种方式|征得/.test(denied.toolContent),
    JSON.stringify(denied.toolContent)
  )

  console.log('\n── 路径二：只读模式 ──')
  /**
   * 只读模式的**主要边界不是闸门，而是工具清单**：`#applyToolPolicy` 在只读模式下
   * 只激活 `read/grep/find/ls`（并且不激活插件工具），所以模型**根本看不到** write。
   * 闸门里那条 `mode === 'readonly'` 分支是第二道 —— 万一工具清单没更新成功，
   * 它还能兜住。
   *
   * 第一版这里断言的是「模型收到的理由里写着只读模式」，结果拿到的是
   * `Tool write not found` —— 因为假模型无视工具清单照样调 `write`。
   * 那不是缺陷，而是我**把边界认错了**。现在按真实结构验两件事：
   * 清单里没有 write，以及「即使硬调也执行不了、也不会被当成成功」。
   */
  const readonly = await runRound({ sessionId: 'readonly-session', permissionMode: 'readonly', decide: null, label: '只读' })
  check('只读模式**不问**（直接拦）', readonly.approvals === 0, String(readonly.approvals))
  check(
    '只读模式**不把 write 提供给模型**（清单本身就是边界）',
    !readonly.offeredTools.includes('write') && !readonly.offeredTools.includes('bash'),
    JSON.stringify(readonly.offeredTools)
  )
  check('只读模式仍然提供读类工具', readonly.offeredTools.includes('read'), JSON.stringify(readonly.offeredTools))
  check('只读模式这一轮正常收尾', typeof readonly.result?.stopReason === 'string', JSON.stringify(readonly.result))
  check('文件没有被写出来', !existsSync(join(workspace, TARGET)), join(workspace, TARGET))
  check(
    '硬调一个不在清单里的工具时，模型得到的是「没有这个工具」而不是成功',
    typeof readonly.toolContent === 'string' && /not found|不存在/i.test(readonly.toolContent),
    JSON.stringify(readonly.toolContent)
  )

  console.log('\n── 对照组：放行那一轮看到的不该是拒绝 ──')
  const allowed = await runRound({ sessionId: 'allow-session', permissionMode: 'ask', decide: 'allow-once', label: '放行' })
  check('放行那一轮也弹了审批', allowed.approvals === 1, String(allowed.approvals))
  check(
    'ask 模式下 write **在清单里**（与只读模式形成对照）',
    allowed.offeredTools.includes('write'),
    JSON.stringify(allowed.offeredTools)
  )
  check('放行之后文件真的写出来了', existsSync(join(workspace, TARGET)), join(workspace, TARGET))
  check(
    '放行那一轮的工具结果里**不含**拒绝字样（证明上面那条断言不是恒真的）',
    typeof allowed.toolContent === 'string' && !/拒绝/.test(allowed.toolContent),
    JSON.stringify(allowed.toolContent)
  )
  const written = existsSync(join(workspace, TARGET)) ? readFileSync(join(workspace, TARGET), 'utf8') : ''
  check('写出来的内容是假模型给的那份', written.startsWith('deny-feedback-content-'), JSON.stringify(written))
} catch (error) {
  failures += 1
  console.log(`  FAIL  自测自身出错: ${String(error)}`)
} finally {
  server.close()
  rmSync(workspace, { recursive: true, force: true })
  rmSync(agentDir, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
