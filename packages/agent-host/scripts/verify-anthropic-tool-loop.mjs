#!/usr/bin/env node
/**
 * Anthropic 线协议下的**工具调用往返**自测。
 *
 * ## 为什么需要它
 *
 * 我们所有的端到端验证都对着一个**OpenAI 兼容**的假模型。而工具调用往返在两家协议里
 * 形状完全不同：OpenAI 用 `tool_calls` + `role: "tool"` 消息；Anthropic 用
 * `content: [{type:'tool_use'}]` 与紧邻的 `content: [{type:'tool_result'}]`（放在 **user**
 * 消息里），且 `tool_use_id` 必须严格配对。
 *
 * 也就是说：**「工具能跑通」这件事从来没有在 Anthropic 的报文形状下被验证过。**
 * 而它的失效方式很隐蔽 —— 本地假 OpenAI 端点一切正常，接真 Anthropic 就 400。
 *
 * ## 做法
 *
 * 本地起一个假装成 Anthropic 的 HTTP 端点：
 *  - 第一次请求 → 回一段 SSE，让模型发起 `write` 工具调用（`tool_use`）；
 *  - 第二次请求 → 这次带着工具结果回来，**把请求体抓下来**，然后收尾。
 *
 * 于是我们就拿到了**真实 agent 循环产生的**第二次请求 —— 里面是 pi 真实拼出来的
 * `tool_use` / `tool_result`，而不是我手搓的样本。
 *
 * 用法：node scripts/verify-anthropic-tool-loop.mjs
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

const captured = []

/** 一段 Anthropic 风格的 SSE：先发起一次 `write` 工具调用。 */
function toolUseSse(model) {
  const args = JSON.stringify({ path: 'anthropic-wrote.txt', content: 'written-by-anthropic-fake #1' })
  const half = Math.ceil(args.length / 2)
  const events = [
    ['message_start', {
      type: 'message_start',
      message: {
        id: 'msg_tool',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 }
      }
    }],
    ['content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_verify_1', name: 'write', input: {} }
    }],
    // 参数分片下发：真实 Anthropic 就是这么流的，顺带验证 pi 的增量拼接。
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: args.slice(0, half) } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: args.slice(half) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 12 } }],
    ['message_stop', { type: 'message_stop' }]
  ]
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

/** 收尾用的 SSE：一段正文 + end_turn。 */
function finalSse(model) {
  const events = [
    ['message_start', {
      type: 'message_start',
      message: {
        id: 'msg_final',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 20, output_tokens: 1 }
      }
    }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '已完成：anthropic-wrote.txt' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } }],
    ['message_stop', { type: 'message_stop' }]
  ]
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

const MODEL_ID = 'claude-sonnet-4-20250514'
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
    captured.push({ url: req.url, headers: req.headers, body })

    // 第二次请求里会出现 tool_result —— 那就是我们要检查的那一次。
    const hasToolResult = JSON.stringify(body?.messages ?? []).includes('tool_result')
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.end(hasToolResult ? finalSse(MODEL_ID) : toolUseSse(MODEL_ID))
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const baseUrl = `http://127.0.0.1:${port}`

const workspace = mkdtempSync(join(tmpdir(), 'ipi-anth-loop-ws-'))
const agentDir = mkdtempSync(join(tmpdir(), 'ipi-anth-loop-agent-'))

try {
  const runtime = new AgentRuntime({ writeEvent: () => undefined, log: () => undefined })
  const provider = {
    id: 'anthropic-loop',
    label: 'Anthropic loop',
    apiStyle: 'anthropic-messages',
    baseUrl,
    models: [{ id: MODEL_ID, label: 'Claude (fake)', supportsTools: true, supportsReasoning: false }],
    enabled: true
  }

  const result = await runtime.prompt({
    provider,
    apiKey: 'sk-ant-fake',
    modelId: MODEL_ID,
    // auto：write 直接放行，我们要看的是**工具结果回传后的报文**，不是审批。
    permissionMode: 'auto',
    cwd: workspace,
    agentDir,
    sessionId: 'anthropic-loop-session',
    text: '写一个文件',
    maxSteps: 10
  })

  console.log('── 请求是否都发到了我们假装的 Anthropic 端点 ──')
  check('至少发生了两次请求（工具调用 + 结果回传）', captured.length >= 2, `实际 ${captured.length} 次`)
  check('第一次请求带上了工具定义', Array.isArray(captured[0]?.body?.tools) && captured[0].body.tools.length > 0, JSON.stringify(Object.keys(captured[0]?.body ?? {})))
  check('鉴权头带上了（x-api-key 或 authorization）', Boolean(captured[0]?.headers?.['x-api-key'] ?? captured[0]?.headers?.authorization), JSON.stringify(Object.keys(captured[0]?.headers ?? {})))

  const second = captured.find((entry) => JSON.stringify(entry.body?.messages ?? []).includes('tool_result'))
  check('第二次请求里确实带了 tool_result（说明工具真的执行并被回传）', Boolean(second), JSON.stringify(captured.map((c) => (c.body?.messages ?? []).map((m) => m.role))))

  if (second) {
    const messages = second.body.messages ?? []
    const roles = messages.map((m) => m.role)

    console.log('\n── 报文形状（Anthropic 的硬要求）──')
    check('首条消息是 user', roles[0] === 'user', JSON.stringify(roles))
    let alternating = true
    for (let i = 1; i < roles.length; i += 1) if (roles[i] === roles[i - 1]) alternating = false
    check('角色严格交替（user/assistant）', alternating, JSON.stringify(roles))

    /** 找到带 tool_use 的 assistant 与带 tool_result 的 user，且必须相邻。 */
    const useIndex = messages.findIndex((m) =>
      Array.isArray(m.content) && m.content.some((block) => block.type === 'tool_use')
    )
    const resultIndex = messages.findIndex((m) =>
      Array.isArray(m.content) && m.content.some((block) => block.type === 'tool_result')
    )
    check('找得到带 tool_use 的 assistant 消息', useIndex >= 0, JSON.stringify(roles))
    check('找得到带 tool_result 的消息', resultIndex >= 0, JSON.stringify(roles))
    check('tool_result 紧跟在 tool_use 之后（Anthropic 要求相邻）', resultIndex === useIndex + 1, `tool_use@${useIndex} tool_result@${resultIndex}`)
    check('承载 tool_result 的消息角色是 user', messages[resultIndex]?.role === 'user', String(messages[resultIndex]?.role))

    const useBlock = messages[useIndex]?.content?.find((block) => block.type === 'tool_use')
    const resultBlock = messages[resultIndex]?.content?.find((block) => block.type === 'tool_result')
    check('tool_use_id 严格配对', Boolean(useBlock?.id) && useBlock.id === resultBlock?.tool_use_id, `use=${useBlock?.id} result=${resultBlock?.tool_use_id}`)
    check('tool_use 的名字是 write', useBlock?.name === 'write', String(useBlock?.name))

    /**
     * 参数必须是**完整 JSON 对象**。
     * 流式下发的 `input_json_delta` 如果拼接有误，这里会是一个残缺的字符串 ——
     * 而那种报文在真实端点上会被直接拒绝。
     */
    check(
      'tool_use 的 input 是完整对象（增量拼接正确）',
      useBlock?.input !== null && typeof useBlock?.input === 'object' && useBlock.input.path === 'anthropic-wrote.txt',
      JSON.stringify(useBlock?.input)
    )
    check('tool_result 标为未出错', resultBlock?.is_error === false || resultBlock?.is_error === undefined, JSON.stringify(resultBlock?.is_error))

    const resultContent = resultBlock?.content
    const resultText =
      typeof resultContent === 'string'
        ? resultContent
        : Array.isArray(resultContent)
          ? resultContent.map((block) => block.text ?? '').join('')
          : JSON.stringify(resultContent)
    check('tool_result 的内容非空（结果真的回传了）', resultText.length > 0, resultText.slice(0, 120))

    /** 报文里不该出现 OpenAI 那套字段 —— 混用会让真实端点困惑。 */
    const rawSecond = JSON.stringify(second.body)
    check('报文里没有混入 OpenAI 风格的 tool_calls 字段', !rawSecond.includes('tool_calls'), rawSecond.slice(0, 200))
    check('报文里没有 role:tool 的消息（那是 OpenAI 的写法）', !roles.includes('tool'), JSON.stringify(roles))
  }

  console.log('\n── 工具真的执行了吗（不看报文，看磁盘）──')
  check('这一轮正常收尾', typeof result?.stopReason === 'string', JSON.stringify(result))
  check('文件真的被写出来了', existsSync(join(workspace, 'anthropic-wrote.txt')), join(workspace, 'anthropic-wrote.txt'))
  if (existsSync(join(workspace, 'anthropic-wrote.txt'))) {
    check(
      '内容就是假 Anthropic 端点给的那份',
      readFileSync(join(workspace, 'anthropic-wrote.txt'), 'utf8').includes('written-by-anthropic-fake'),
      readFileSync(join(workspace, 'anthropic-wrote.txt'), 'utf8').slice(0, 80)
    )
  }

  await runtime.shutdown()
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
