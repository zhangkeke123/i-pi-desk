#!/usr/bin/env node
/**
 * 每一种**用户可配置的线协议**下，我们都必须能构建出合法的请求。
 *
 * ## 为什么需要它
 *
 * 用户可以在设置里选 4 种协议族：`openai-completions` / `openai-responses` /
 * `anthropic-messages` / `google-generative-ai`。而我们的端到端验证**全都对着一个
 * OpenAI 兼容的假模型** —— 另外三种协议从来没有被碰过。
 *
 * 它们的报文形状差别很大（`messages` vs `input` vs `contents`；工具定义的字段名、
 * schema 所在的位置都不一样）。任何一种构建失败或形状错乱，用户选了那个协议就会直接
 * 用不了，而我们的测试全绿。
 *
 * ## 做法
 *
 * 拦下 `fetch`：请求体在收到响应之前就已经发出去了，所以**响应一律返回 400**
 * 就够了 —— 不必为四种协议各写一份假的成功响应。我们要的是**请求**。
 *
 * ## 它在守什么
 *
 *  - 四种协议都构建得出来（升级 pi 后某个协议构建抛错会立刻红）；
 *  - 重放序列在四种协议下都满足「首条 user + 严格交替」；
 *  - 工具定义按各自的原生格式发出（`function.parameters` / `parameters` /
 *    `input_schema` / `parametersJsonSchema`），且 schema 被完整保留；
 *  - 请求打到各自的正确路径上（baseUrl 处理错了会在这里露出来）。
 *
 * 用法：node scripts/verify-api-matrix.mjs
 */

import { normalizeContext } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const { toPiProviderInput } = await import('../dist/provider.js')
const { toPiHistory } = await import('../dist/history.js')

let failures = 0
function check(label, condition, detail = '') {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

const captured = []
globalThis.fetch = async (url, init) => {
  captured.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null })
  return new Response(JSON.stringify({ error: { message: 'verify-api-matrix：只关心请求' } }), {
    status: 400,
    headers: { 'content-type': 'application/json' }
  })
}

const timestamp = Date.now()
const transcript = [
  { id: 'u1', role: 'user', createdAt: new Date(timestamp).toISOString(), parts: [{ kind: 'text', text: '问题一' }] },
  { id: 'a1', role: 'assistant', createdAt: new Date(timestamp).toISOString(), parts: [{ kind: 'text', text: '回答一' }] },
  { id: 'u2', role: 'user', createdAt: new Date(timestamp).toISOString(), parts: [{ kind: 'text', text: '问题二' }] },
  { id: 'a2', role: 'assistant', createdAt: new Date(timestamp).toISOString(), parts: [{ kind: 'text', text: '回答二' }] }
]

const probeTool = {
  name: 'fixture_echo',
  description: '回显文本',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: '要回显的文本' } },
    required: ['text'],
    additionalProperties: false
  }
}

/**
 * 每种协议的期望。`path` 用来验证 baseUrl 与端点拼装没被搞错；
 * `extract` 把该协议的工具定义取出来，好统一检查「名字与 schema 都在」。
 */
const APIS = [
  {
    api: 'openai-completions',
    baseUrl: 'https://probe.invalid/v1',
    pathIncludes: '/chat/completions',
    messagesKey: 'messages',
    extractTool: (tool) => ({ name: tool?.function?.name, schema: tool?.function?.parameters })
  },
  {
    api: 'openai-responses',
    baseUrl: 'https://probe.invalid/v1',
    pathIncludes: '/responses',
    messagesKey: 'input',
    extractTool: (tool) => ({ name: tool?.name, schema: tool?.parameters })
  },
  {
    api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    pathIncludes: '/v1/messages',
    messagesKey: 'messages',
    extractTool: (tool) => ({ name: tool?.name, schema: tool?.input_schema })
  },
  {
    api: 'google-generative-ai',
    baseUrl: 'https://probe.invalid/v1',
    pathIncludes: ':streamGenerateContent',
    messagesKey: 'contents',
    extractTool: (tool) => {
      const declaration = tool?.functionDeclarations?.[0]
      return { name: declaration?.name, schema: declaration?.parametersJsonSchema }
    }
  }
]

/** 从报文里取角色序列（各协议的形状不同）。 */
function rolesOf(body, messagesKey) {
  const list = body?.[messagesKey]
  if (!Array.isArray(list)) return null
  return list.map((item) => item.role ?? item.author ?? '?')
}

for (const spec of APIS) {
  console.log(`\n── ${spec.api} ──`)
  const runtime = await ModelRuntime.create({ modelsPath: null })
  const modelId = 'matrix-model'

  try {
    runtime.registerProvider(
      'matrix',
      toPiProviderInput(
        {
          id: 'matrix',
          label: `Matrix ${spec.api}`,
          apiStyle: spec.api,
          baseUrl: spec.baseUrl,
          models: [{ id: modelId, label: modelId, supportsTools: true, supportsReasoning: false }],
          enabled: true
        },
        'matrix-key',
        modelId
      )
    )
  } catch (error) {
    check(`${spec.api}：能注册 provider`, false, error.message)
    continue
  }

  const model = runtime.getModel('matrix', modelId)
  if (!model) {
    check(`${spec.api}：能拿到模型定义`, false)
    continue
  }

  const replay = toPiHistory(transcript, { providerId: 'matrix', api: spec.api, model: modelId })
  const live = [...replay, { role: 'user', content: [{ type: 'text', text: '现在帮我做点事' }], timestamp }]

  captured.length = 0
  let buildError = null
  try {
    const streamResult = runtime.stream(model, normalizeContext({ messages: live, tools: [probeTool] }), {
      apiKey: 'matrix-key'
    })
    for await (const _event of streamResult) void _event
  } catch (error) {
    buildError = error.message
  }

  const request = captured[0]
  check(`${spec.api}：带工具的请求构建得出来（不抛错）`, buildError === null, String(buildError))
  check(`${spec.api}：确实发出了网络请求`, Boolean(request), JSON.stringify(captured.length))

  if (!request) continue

  check(
    `${spec.api}：打到正确的端点路径`,
    request.url.includes(spec.pathIncludes),
    `期望包含 ${spec.pathIncludes}，实际 ${request.url}`
  )

  const roles = rolesOf(request.body, spec.messagesKey)
  check(`${spec.api}：报文里有消息列表（${spec.messagesKey}）`, Array.isArray(roles) && roles.length > 0, JSON.stringify(Object.keys(request.body ?? {})))
  if (Array.isArray(roles)) {
    check(`${spec.api}：首条是 user`, roles[0] === 'user', JSON.stringify(roles))
    let alternating = true
    for (let i = 1; i < roles.length; i += 1) if (roles[i] === roles[i - 1]) alternating = false
    check(`${spec.api}：角色严格交替`, alternating, JSON.stringify(roles))
  }

  const tools = request.body?.tools
  check(`${spec.api}：工具定义发出去了`, Array.isArray(tools) && tools.length === 1, JSON.stringify(tools)?.slice(0, 120))
  if (Array.isArray(tools) && tools.length === 1) {
    const { name, schema } = spec.extractTool(tools[0])
    check(`${spec.api}：工具名正确`, name === 'fixture_echo', String(name))
    check(
      `${spec.api}：schema 完整保留（properties 与 required 都在）`,
      schema?.properties?.text !== undefined && Array.isArray(schema?.required) && schema.required.includes('text'),
      JSON.stringify(schema)?.slice(0, 200)
    )
  }
}

console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
