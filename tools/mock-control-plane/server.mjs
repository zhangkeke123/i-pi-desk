#!/usr/bin/env node
/**
 * Mock 控制面（参考实现 + 测试靶子）。
 *
 * 它有两个用途：
 *  1. **给 Java 侧的参考实现**：`docs/CONTROL-PLANE.md` 里的契约在这里有一个能跑的最小版本，
 *     字段名、状态码、鉴权方式都能照着看。
 *  2. **端到端验证的靶子**：`verify:renderer` 会启动它，然后驱动真实应用完成
 *     登录 → 同步模型 → 同步技能 → 查配额 → 推审计。
 *
 * ⚠️ 它**不是**产品代码：没有数据库、没有密码哈希、令牌只存在内存里、重启即失效。
 * 唯一「额外」的东西是 `GET /__received` 这种调试端点，专供测试断言服务端收到了什么。
 *
 * 用法：node server.mjs --port 8099
 */

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

const portArgIndex = process.argv.indexOf('--port')
const PORT = portArgIndex !== -1 ? Number(process.argv[portArgIndex + 1]) : 8099

/**
 * 下发的模型端点地址。
 *
 * 默认给一个**真实感的内网地址**（参考实现要像真的）。测试会把它覆盖成 mock 自己，
 * 这样就能在不接真模型的前提下跑完「prompt → 失败 → 审计上报」这条链路。
 */
const baseUrlArgIndex = process.argv.indexOf('--models-base-url')
const MODELS_BASE_URL =
  baseUrlArgIndex !== -1 ? process.argv[baseUrlArgIndex + 1] : 'http://10.0.0.10:8000/v1'

/** 演示账号。真实实现里当然是查库 + 校验哈希。 */
const USERS = {
  alice: { password: 'secret', user: { id: 'u-1', name: 'Alice（示例用户）', roles: ['admin', 'member'] } }
}

/** 已签发的令牌。真实实现用 JWT 或 Redis。 */
const tokens = new Map()

/** 收到的审计事件，供测试断言。 */
const receivedAudit = []

/** 假模型端点的脚本：会写一个文件，让测试能从磁盘上确认工具真的执行了。 */
const toolTargetArgIndex = process.argv.indexOf('--tool-target')
const TOOL_TARGET = toolTargetArgIndex !== -1 ? process.argv[toolTargetArgIndex + 1] : 'agent-wrote.txt'
const toolContentArgIndex = process.argv.indexOf('--tool-content')
const TOOL_CONTENT_BASE =
  toolContentArgIndex !== -1 ? process.argv[toolContentArgIndex + 1] : 'written-by-fake-model'

/**
 * 每次写入的内容都带上递增序号。
 *
 * 否则第二次写同一个文件时内容与原先**完全一致** —— 那是一个「没有差异的改动」，
 * 审批卡片因此没有 diff 可显示，界面退回参数视图。真实模型也不会反复写一模一样的内容，
 * 让夹具更像真实行为，测试才验得到该验的东西。
 */
let writeCount = 0
const nextToolContent = () => `${TOOL_CONTENT_BASE} #${++writeCount}`

/**
 * 纯文本模式：不发起工具调用，只回一段带标记的正文。
 *
 * 用途是「只想验对话本身」的场景（例如历史恢复）。带工具调用的模式会引入审批，
 * 把一条本该简单的链路变成需要裁决的流程 —— 验证目标会被噪声淹没。
 */
const TEXT_ONLY = process.argv.includes('--text-only')
/** 循环模式读哪个文件：夹具里一定有 README.md（不像 src/ 会被改名）。 */
const LOOP_READ_PATH = 'README.md'

/**
 * 调插件工具时传的参数。
 *
 * 刻意与「写文件」的参数完全不同，这样断言可以确认**参数也真的到了插件进程**
 * ——只看工具被调用是不够的，参数在转换（厂商函数调用格式 ↔ pi 的 input）里
 * 掉链子是很常见的失效方式。
 */
const FIXTURE_ARG = '模型传过去的参数'

/** 假模型实际走了哪几轮，供测试确认「确实发生了第二轮」。 */
const receivedTurns = []

/**
 * 假模型收到的请求形状（角色序列 + 工具名）。
 *
 * 不记正文（正文可能很大，而且测试断言「审计不含对话内容」时不该有第二份副本），
 * 只记**形状** —— 排查「模型为什么没被调用」「工具集有没有传下去」时，
 * 这两样就够了，而且比猜快得多。
 */
const receivedRequests = []

/**
 * 下发的模型配置。
 *
 * 注意 `id` 是稳定的 —— 客户端按 id 做 upsert 与「替换控制面来源」的清理，
 * 每次登录都换 id 会导致本地堆积一堆旧 provider。
 */
const MODEL_CONFIG = {
  providers: [
    {
      id: 'cp-internal-vllm',
      label: '内网 vLLM（控制面下发）',
      apiStyle: 'openai-completions',
      baseUrl: MODELS_BASE_URL,
      models: [{ id: 'Qwen3-Coder-30B', label: 'Qwen3 Coder 30B' }],
      enabled: true,
      source: 'control-plane',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
  ],
  defaultProviderId: 'cp-internal-vllm',
  defaultModelId: 'Qwen3-Coder-30B'
}

/**
 * 下发的技能。第二个的**名字是大写**，会被客户端按 Agent Skills 规范拒绝 ——
 * 这是故意放的：用来验证客户端不会静默丢弃不合规的技能，而是报进 `skipped`。
 */
const SKILLS = {
  skills: [
    {
      name: 'cp-review-checklist',
      description: '控制面下发的代码评审清单。提交 PR 前使用。',
      version: '1.2.0',
      content: [
        '---',
        'name: cp-review-checklist',
        'description: 控制面下发的代码评审清单。提交 PR 前使用。',
        '---',
        '',
        '# 评审清单',
        '',
        '- 每个改动都要有对应测试',
        '- 提交信息使用中文',
        ''
      ].join('\n')
    },
    {
      name: 'Invalid_Name',
      description: '名字不合规，客户端应当跳过并报出来。',
      content: '---\nname: Invalid_Name\ndescription: x\n---\n\n正文\n'
    }
  ]
}

/** 从消息的 content 里取出文本（可能是字符串，也可能是内容块数组）。 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('')
  }
  return ''
}

function send(res, status, body) {  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      // 拒绝异常大的请求体：参考实现也不该给测试机留一个内存炸弹。
      if (data.length > 2_000_000) reject(new Error('请求体过大'))
    })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** 校验 Bearer 令牌。返回 true 表示已处理（发了 401）。 */
function requireAuth(req, res) {
  const header = req.headers.authorization ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header)
  if (!match || !tokens.has(match[1])) {
    send(res, 401, { error: 'unauthorized' })
    return true
  }
  return false
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const path = url.pathname

  try {
    if (req.method === 'POST' && path === '/api/auth/login') {
      const body = await readBody(req)
      const record = USERS[body.username]
      if (!record || record.password !== body.password) {
        // 不区分「用户不存在」与「密码错」：区分开等于给攻击者一个枚举用户的接口。
        send(res, 401, { error: 'invalid_credentials' })
        return
      }
      const token = randomUUID()
      tokens.set(token, record.user)
      send(res, 200, { token, user: record.user })
      return
    }

    if (path === '/__health') {
      send(res, 200, { ok: true, users: Object.keys(USERS), tokens: tokens.size })
      return
    }

    // 调试端点：测试用它断言「服务端到底收到了什么」。
    if (path === '/__received') {
      send(res, 200, { auditEvents: receivedAudit, turns: receivedTurns, requests: receivedRequests })
      return
    }

    /**
     * 假模型端点与 `/api/*` 是**两个不同的面，鉴权方式也不同**：
     *
     *   - 控制面 API：用登录换来的 Bearer 令牌；
     *   - 模型端点：用「用户 provider 上配的 key」—— 本地/内网端点就是那个占位 key。
     *
     * 所以模型端点必须在控制面的鉴权门**之前**放行。之前假端点只返回 400，
     * 被这道门拦掉也看不出来；一旦它要真的产出对话，就会变成
     * 「应用收到 401 → 本轮空转」这种和真实原因毫无关系的现象。
     */
    const isModelEndpoint =
      req.method === 'POST' && (path === '/v1/chat/completions' || path === '/v1/responses')

    if (!isModelEndpoint && requireAuth(req, res)) return

    if (req.method === 'GET' && path === '/api/config/models') {
      send(res, 200, MODEL_CONFIG)
      return
    }

    if (req.method === 'GET' && path === '/api/skills') {
      send(res, 200, SKILLS)
      return
    }

    if (req.method === 'GET' && path === '/api/quota') {
      send(res, 200, { usedTokens: 128_400, limitTokens: 500_000, resetAt: '2026-11-01T00:00:00.000Z' })
      return
    }

    if (req.method === 'POST' && path === '/api/audit/events') {
      const body = await readBody(req)
      const events = Array.isArray(body?.events) ? body.events : []
      receivedAudit.push(...events)
      send(res, 200, { accepted: events.length })
      return
    }

    /**
     * 假的模型端点（OpenAI 兼容，流式）。
     *
     * 它不是「返回 400 让 run 失败」，而是**走两轮的脚本化对话**：
     *
     *   第 1 轮（没有 tool 角色的消息）→ 先吐一段正文，再发起一次 `write` 工具调用
     *   第 2 轮（消息里出现 tool 结果）→ 返回一句收尾正文 + usage
     *
     * 这样一条不接真模型的路径就覆盖了：流式正文、工具调用、审批闸门、
     * 工具真实执行（真的落盘一个文件）、结果回传模型、第二轮收尾、用量统计。
     *
     * 只在该工具确实出现在请求的 `tools` 里时才发起调用 —— 否则说明工具集没暴露，
     * 这时应当让测试失败，而不是让 mock 硬造一个模型不可能发出的调用。
     */
    if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/v1/responses')) {
      const body = await readBody(req).catch(() => ({}))
      const messages = Array.isArray(body?.messages) ? body.messages : []
      /**
       * 判断「这是第一轮还是工具执行后的续轮」。
       *
       * 必须看**最后一条**消息是不是工具结果，而不是「历史里有没有工具结果」——
       * 同一个会话里用户会连续发多轮，历史里当然会有旧的工具结果。
       * 用历史判断的话，第二次提问会被当成续轮直接收尾，于是「模型不再调用工具」，
       * 排查时看起来像是工具集失效了。（这个坑正是被 verify:renderer 抓出来的。）
       */
      const lastMessage = messages[messages.length - 1]
      const awaitingToolResult = lastMessage?.role === 'tool'
      const toolNames = (Array.isArray(body?.tools) ? body.tools : []).map(
        (tool) => tool?.function?.name ?? tool?.name
      )
      const canWrite = toolNames.includes('write') && !TEXT_ONLY
      const lastUserText = textOf([...messages].reverse().find((message) => message?.role === 'user')?.content)
      /**
       * 插件工具模式：用户消息里带 `@fixture` 时，改为调用**插件提供的**工具。
       *
       * 为什么需要它：此前只验过「插件工具出现在生效工具列表里」——
       * 那是「注册成功」，不是「模型能调它、宿主真的转发到插件进程、结果回到模型」。
       * 中间每一段都可能断（schema 转不成厂商的函数调用格式、调用没路由到插件子进程、
       * 结果没回传），而它们失效时界面看起来只是「模型没调工具」。
       *
       * 用消息内容而不是命令行开关来决定：同一个 mock 进程在一次 E2E 里要同时服务
       * 「写文件」与「调插件」两条路径，重启 mock 会打断前面所有断言。
       */
      const canCallFixture = !TEXT_ONLY && toolNames.includes('fixture_echo') && /@fixture/.test(lastUserText)
      /**
       * 连续工具调用模式（用户消息里带 `@loop4`）。
       *
       * 为什么需要它：界面有一条「本次运行已用 N/M 步，接近上限」的预警（阈值 80%），
       * 但**用原来的假模型永远触发不到** —— 它一轮最多产生 2 次工具调用，
       * 而 2 次要落进 [80%, 100%) 需要 maxSteps ∈ (2, 2.5]，没有这样的整数。
       * 于是这条预警长期只有单测覆盖，端到端一直是缺口。
       *
       * 用 `read` 而不是 `write` 做循环：read 不需要审批，所以这一段不必去点四次
       * 「仅允许这一次」，也就不会把审批路径的时序混进来。
       */
      const loopMatch = /@loop(\d+)/.exec(lastUserText)
      const loopTarget = loopMatch ? Math.min(Number(loopMatch[1]) || 0, 12) : 0
      receivedRequests.push({
        roles: messages.map((message) => message?.role ?? '?'),
        toolNames: toolNames.filter(Boolean),
        // 附加字段（不影响既有断言）：自测要能看出「这条用户消息到底有没有带 @loop」。
        lastUserText: lastUserText.slice(0, 40)
      })

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })

      const chunk = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
      const base = { id: `chatcmpl-${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body?.model ?? 'mock' }
      const wrap = (delta, finishReason = null) => ({
        ...base,
        choices: [{ index: 0, delta, finish_reason: finishReason }]
      })

      if (awaitingToolResult) {
        if (loopTarget > 0) {
          // 数「这条用户消息之后」已经有多少条工具结果（不能用全历史：同一会话有多轮）。
          const lastUserIndex = messages.map((message) => message?.role).lastIndexOf('user')
          const toolResults = messages
            .slice(lastUserIndex + 1)
            .filter((message) => message?.role === 'tool').length
          if (toolResults < loopTarget) {
            // 刻意慢一点：预警只在**运行中**显示，太快的话自测可能一次都没看到它。
            await new Promise((resolve) => setTimeout(resolve, 400))
            receivedTurns.push('loop-tool-call')
            const loopCall = { id: `call_loop_${toolResults + 1}`, name: 'read', args: JSON.stringify({ path: LOOP_READ_PATH }) }
            chunk(wrap({ tool_calls: [{ index: 0, id: loopCall.id, type: 'function', function: { name: loopCall.name, arguments: '' } }] }))
            chunk(wrap({ tool_calls: [{ index: 0, function: { arguments: loopCall.args.slice(0, 12) } }] }))
            chunk(wrap({ tool_calls: [{ index: 0, function: { arguments: loopCall.args.slice(12) } }] }))
            chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
            res.write('data: [DONE]\n\n')
            res.end()
            return
          }
        }
        receivedTurns.push('final')
        /**
         * 把**工具回传的内容**摘一段放进收尾正文里。
         *
         * 这样「结果回到模型了吗」变成一条可读的断言（收尾文本里出现工具输出），
         * 而不是只能靠「事件顺序看起来对」。对插件工具尤其有用：
         * 夹具的输出里有几个只有插件进程才能产生的字段。
         */
        const snippet = textOf(lastMessage?.content).slice(0, 160)
        const pluginCall = String(lastMessage?.tool_call_id ?? '').includes('plugin')
        chunk(
          wrap({
            role: 'assistant',
            content: `${pluginCall ? '已完成：插件工具' : `已完成：${TOOL_TARGET}`}；工具回传=${snippet}`
          })
        )
        chunk({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 128, completion_tokens: 24, total_tokens: 152 }
        })
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      if (loopTarget > 0) {
        receivedTurns.push('loop-tool-call')
        const firstCall = { id: 'call_loop_1', name: 'read', args: JSON.stringify({ path: LOOP_READ_PATH }) }
        chunk(wrap({ role: 'assistant', content: '好的，我一次一次读。' }))
        chunk(wrap({ tool_calls: [{ index: 0, id: firstCall.id, type: 'function', function: { name: firstCall.name, arguments: '' } }] }))
        chunk(wrap({ tool_calls: [{ index: 0, function: { arguments: firstCall.args.slice(0, 12) } }] }))
        chunk(wrap({ tool_calls: [{ index: 0, function: { arguments: firstCall.args.slice(12) } }] }))
        chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      receivedTurns.push(canCallFixture || canWrite ? 'tool-call' : 'text-only')
      chunk(wrap({ role: 'assistant', content: canCallFixture ? '好的，我调用一下插件工具。' : '好的，我先写一个文件。' }))

      if (!canCallFixture && !canWrite) {
        // 纯文本模式，或工具没暴露：不硬造工具调用，直接收尾。
        //
        // 回显最后一条用户消息：这样断言可以「对话内容」为准，读起来一眼能看懂，
        // 而不是只能比对模型收到的角色序列。（工具没暴露时也一样 —— 测试会因此
        // 看到「文件没被创建」而失败，失败原因指向真正的问题。）
        receivedTurns.push('text-only')
        const lastUser = [...messages].reverse().find((message) => message?.role === 'user')
        chunk(wrap({ role: 'assistant', content: `收到：${textOf(lastUser?.content)}` }))
        chunk({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 64, completion_tokens: 12, total_tokens: 76 }
        })
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      const call = canCallFixture
        ? {
            id: 'call_mock_plugin',
            name: 'fixture_echo',
            args: JSON.stringify({ text: FIXTURE_ARG })
          }
        : {
            id: 'call_mock_1',
            name: 'write',
            args: JSON.stringify({ path: TOOL_TARGET, content: nextToolContent() })
          }

      chunk(
        wrap({
          tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }]
        })
      )
      // 参数分片下发：真实厂商就是这么流的，顺带验证 pi 的增量拼接。
      chunk(wrap({ tool_calls: [{ index: 0, function: { arguments: call.args.slice(0, 12) } }] }))
      chunk(wrap({ tool_calls: [{ index: 0, function: { arguments: call.args.slice(12) } }] }))
      chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    send(res, 404, { error: 'not_found', path })
  } catch (error) {
    send(res, 400, { error: error instanceof Error ? error.message : String(error) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  // 只监听回环地址：参考实现不该在开发机上对外暴露一个无鉴权的登录接口。
  process.stdout.write(`mock-control-plane listening on http://127.0.0.1:${PORT}\n`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
