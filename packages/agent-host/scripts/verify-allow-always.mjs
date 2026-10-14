#!/usr/bin/env node
/**
 * 「允许并记住」（`allow-always`）的白名单**生命周期**自测。
 *
 * ## 为什么需要它
 *
 * 这个白名单的键是 `工具名 + JSON.stringify(参数)`（`approval.ts` 的 `approvalFingerprint`），
 * 存在每个会话记录上（`runtime.ts` 的 `record.alwaysAllowed`）。也就是说它是
 * **会话级、进程内存里**的一份东西。这三条性质都只是读代码读出来的，端到端从没验过：
 *
 *  1. 同一会话里**参数完全相同**的调用，第二次真的不再问 —— 这是这个功能存在的理由；
 *  2. 它**不跨会话**：在 A 会话里授权，B 会话里同样的调用仍然要问；
 *  3. 它**不跨进程**：新 runtime（= sidecar 重启）后授权失效，会重新问。
 *
 * 第 2、3 条是安全性质：如果哪次重构把白名单挪到了全局、或不小心落了盘，
 * 用户会以为「我只在这一次对话里点过一次」，而实际上别的会话、甚至下次启动都已经被放行。
 * 那种洞不会自己暴露 —— 只会表现为「它怎么没问我？」。
 *
 * ## 为什么不用 E2E 那套夹具
 *
 * E2E 里的假模型每次写入都带递增序号（`#1`、`#2`…），**参数永远不同**，
 * 所以它**验不到**「同参数不再问」这件事。这里自己起一个「参数恒定」的假模型 ——
 * 只有这样才谈得上「记住」。
 *
 * ## 写这个自测时踩的两个坑（都留在注释里）
 *
 *  - **每轮要有时限**：没有上限时，某一轮挂住会让整个自测静静地停在那里，
 *    既没有失败也没有结论。加上 60 秒上限后，它第一次跑就把「等满 5 分钟」
 *    变成了一条 60 秒的失败 + 现场日志。
 *  - **`writeEvent` 绑在 runtime 上，不是每一轮**：第一版给每轮发一个 sink 数组，
 *    结果事件全进了 runtime 创建时那个数组，别的 sink 永远是空的 ——
 *    于是裁决轮询看不见审批，那一轮自然挂住了。
 *
 * 用法：node scripts/verify-allow-always.mjs
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

/** 假模型每次都给**完全相同**的参数 —— 这是这一整个自测的前提。 */
const FIXED_PATH = 'always.txt'
const FIXED_CONTENT = 'identical-content-every-single-time'

/** OpenAI 兼容的流式响应：续轮给正文收尾，其余给一个 write 工具调用。 */
function streamFor(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const lastMessage = messages[messages.length - 1]
  const base = { id: 'chatcmpl-fixed', object: 'chat.completion.chunk', created: 1, model: 'fixed-model' }
  const wrap = (delta, finishReason = null) => ({
    ...base,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  })

  if (lastMessage?.role === 'tool') {
    return [
      wrap({ role: 'assistant', content: '已完成：always.txt' }),
      {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
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
          id: 'call_fixed_1',
          type: 'function',
          function: { name: 'write', arguments: JSON.stringify({ path: FIXED_PATH, content: FIXED_CONTENT }) }
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
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    for (const chunk of streamFor(body)) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`

const workspace = mkdtempSync(join(tmpdir(), 'ipi-always-ws-'))
const agentDir = mkdtempSync(join(tmpdir(), 'ipi-always-agent-'))

const provider = {
  id: 'always-provider',
  label: 'Always Mock',
  apiStyle: 'openai-completions',
  baseUrl,
  models: [{ id: 'fixed-model' }],
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

/** 一个 runtime 一份事件与日志（事件只进 runtime 创建时给的那个数组）。 */
function makeRuntime() {
  const sink = []
  const logs = []
  const runtime = new AgentRuntime({
    writeEvent: (_sessionId, event) => sink.push(event),
    log: (line) => logs.push(line)
  })
  return { runtime, sink, logs }
}

const ROUND_TIMEOUT_MS = 60_000

async function runRound({ runtime, sink, logs, sessionId, decide, label }) {
  const from = sink.length
  const promise = runtime
    .prompt({
      provider,
      apiKey: 'ipi-local-no-auth',
      modelId: 'fixed-model',
      permissionMode: 'ask',
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
    new Promise((resolve) => setTimeout(() => resolve({ stopReason: 'test-timeout' }), ROUND_TIMEOUT_MS))
  ])
  running = false
  await poller

  const mine = sink.slice(from)
  const approvals = mine.filter((e) => e.type === 'approval.requested')
  if (result?.stopReason === 'test-timeout' || result?.stopReason === 'error') {
    console.log(`        [${label}] 事件：${JSON.stringify(mine.map((e) => e.type))}`)
    console.log(`        [${label}] 日志尾部：\n          ${logs.slice(-8).join('\n          ')}`)
  }
  return {
    requested: approvals[0],
    approvals: approvals.length,
    toolFinished: mine.find((e) => e.type === 'tool.finished'),
    result,
    types: mine.map((e) => e.type)
  }
}

try {
  console.log('── 同一个会话：参数完全相同，第二次不该再问 ──')
  const a = makeRuntime()
  const sessionId = 'always-session'

  const round1 = await runRound({
    runtime: a.runtime,
    sink: a.sink,
    logs: a.logs,
    sessionId,
    decide: 'allow-always',
    label: '轮 1'
  })
  check('第一轮弹出了审批（write）', round1.requested?.toolName === 'write', JSON.stringify(round1.requested?.toolName))
  check('第一轮正常收尾', typeof round1.result?.stopReason === 'string', JSON.stringify(round1.result))
  check('第一轮的工具真的执行了', round1.toolFinished?.ok === true, JSON.stringify(round1.toolFinished))
  check('文件真的写出来了', existsSync(join(workspace, FIXED_PATH)), join(workspace, FIXED_PATH))

  const round2 = await runRound({ runtime: a.runtime, sink: a.sink, logs: a.logs, sessionId, label: '轮 2' })
  check('第二轮**没有再问**（这就是「记住」这件事本身）', round2.requested === undefined, JSON.stringify(round2.types))
  check('第二轮正常收尾', typeof round2.result?.stopReason === 'string', JSON.stringify(round2.result))
  check('第二轮的工具仍然成功执行（沉默不等于跳过了工具）', round2.toolFinished?.ok === true, JSON.stringify(round2.toolFinished))

  console.log('\n── 不跨会话：换个会话，同样的调用必须重新问 ──')
  const sessionB = 'another-session'
  const round3 = await runRound({
    runtime: a.runtime,
    sink: a.sink,
    logs: a.logs,
    sessionId: sessionB,
    decide: 'allow-once',
    label: '轮 3'
  })
  check('另一个会话**仍然要问**（白名单没有跨会话泄漏）', round3.requested?.toolName === 'write', JSON.stringify(round3.types))
  /**
   * 对照组：证明这几轮的参数**确实完全一样**。
   * 少了这一条，「第二轮没问」有可能只是参数碰巧不同造成的假象。
   */
  check(
    '两个会话收到的参数逐字相同（否则「没问」可能是参数不同造成的假象）',
    JSON.stringify(round3.requested?.args) === JSON.stringify(round1.requested?.args),
    `${JSON.stringify(round1.requested?.args)} vs ${JSON.stringify(round3.requested?.args)}`
  )

  console.log('\n── 不跨进程：新 runtime（= sidecar 重启）后授权失效 ──')
  const c = makeRuntime()
  const round4 = await runRound({
    runtime: c.runtime,
    sink: c.sink,
    logs: c.logs,
    // 同一个会话 id：模拟「重启应用后重新打开同一个对话」这个最尖锐的情形。
    sessionId,
    decide: 'allow-once',
    label: '轮 4'
  })
  check(
    '同一个会话 id、同样的参数，重启后**重新问**（白名单只在内存里，方向是安全的）',
    round4.requested?.toolName === 'write',
    JSON.stringify(round4.types)
  )
  check('重新问之后这一轮照常跑完', typeof round4.result?.stopReason === 'string', JSON.stringify(round4.result))
  check(
    '写出来的内容就是假模型给的那份（这一条路径本身是通的）',
    existsSync(join(workspace, FIXED_PATH)) && readFileSync(join(workspace, FIXED_PATH), 'utf8') === FIXED_CONTENT,
    existsSync(join(workspace, FIXED_PATH))
      ? readFileSync(join(workspace, FIXED_PATH), 'utf8').slice(0, 60)
      : '(文件不存在)'
  )
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
