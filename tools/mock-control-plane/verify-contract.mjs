#!/usr/bin/env node
/**
 * 控制面 HTTP 契约自测。
 *
 * 它**不启动应用**，而是以客户端身份直接打 mock 控制面，逐条验证
 * `docs/CONTROL-PLANE.md` 里的契约。分开验证的理由：
 *
 *  - 应用侧验证的是「我们的客户端代码对不对」；
 *  - 契约验证的是「两边对同一份约定的理解是否一致」。
 *
 * Java 侧实现完之后，把这里的 baseUrl 换掉就能当**对接验收脚本**用。
 *
 * 用法：node tools/mock-control-plane/verify-contract.mjs
 */

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PORT = 8123
const BASE = `http://127.0.0.1:${PORT}`

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

const server = spawn(process.execPath, [join(here, 'server.mjs'), '--port', String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe']
})
let serverLog = ''
server.stdout.on('data', (c) => {
  serverLog += c.toString()
})
server.stderr.on('data', (c) => {
  serverLog += c.toString()
})

async function waitForHealth(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/__health`)
      if (response.ok) return await response.json()
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`mock 控制面启动超时。日志：\n${serverLog}`)
}

/** 带超时的请求，避免契约测试因为对端不响应而永久挂住。 */
const call = (path, init = {}) =>
  fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(5000) })

try {
  await waitForHealth()
  console.log('── 认证 ──')

  const wrong = await call('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'nope' })
  })
  check('密码错误返回 401', wrong.status === 401, `实际 ${wrong.status}`)

  const unknown = await call('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'nobody', password: 'x' })
  })
  check('用户不存在也返回 401（不泄露用户是否存在）', unknown.status === 401, `实际 ${unknown.status}`)

  const login = await call('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'secret' })
  })
  const session = await login.json()
  check('登录成功返回 token', login.status === 200 && typeof session.token === 'string', JSON.stringify(session))
  check('登录成功返回 user 与 roles', session.user?.name === 'Alice（示例用户）' && Array.isArray(session.user.roles), JSON.stringify(session.user))

  const auth = { Authorization: `Bearer ${session.token}` }

  console.log('\n── 鉴权 ──')
  for (const path of ['/api/config/models', '/api/skills', '/api/quota']) {
    const response = await call(path)
    check(`${path} 无令牌返回 401`, response.status === 401, `实际 ${response.status}`)
  }
  const badToken = await call('/api/config/models', { headers: { Authorization: 'Bearer not-a-real-token' } })
  check('伪造令牌返回 401', badToken.status === 401, `实际 ${badToken.status}`)

  console.log('\n── 模型配置下发 ──')
  const modelConfig = await (await call('/api/config/models', { headers: auth })).json()
  check('返回 providers 数组', Array.isArray(modelConfig.providers) && modelConfig.providers.length > 0)
  const provider = modelConfig.providers[0]
  check(
    'provider 含客户端必需字段（id / label / apiStyle / baseUrl / models）',
    Boolean(provider.id && provider.label && provider.apiStyle && provider.baseUrl && Array.isArray(provider.models)),
    JSON.stringify(provider)
  )
  check(
    '模型项含 id 与 label',
    provider.models.every((m) => typeof m.id === 'string' && typeof m.label === 'string'),
    JSON.stringify(provider.models)
  )
  check('带默认 provider/model', Boolean(modelConfig.defaultProviderId && modelConfig.defaultModelId), JSON.stringify(modelConfig.defaultProviderId))

  console.log('\n── 技能下发 ──')
  const skills = await (await call('/api/skills', { headers: auth })).json()
  check('返回 skills 数组', Array.isArray(skills.skills) && skills.skills.length === 2, JSON.stringify(skills.skills?.length))
  check(
    '技能含 name 与 content',
    skills.skills.every((s) => typeof s.name === 'string' && typeof s.content === 'string')
  )
  check(
    'contract 里保留了一个不合规技能名（供客户端验证 skipped 行为）',
    skills.skills.some((s) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s.name)),
    JSON.stringify(skills.skills.map((s) => s.name))
  )

  console.log('\n── 配额 ──')
  const quota = await (await call('/api/quota', { headers: auth })).json()
  check(
    '返回 usedTokens / limitTokens 数值',
    typeof quota.usedTokens === 'number' && typeof quota.limitTokens === 'number',
    JSON.stringify(quota)
  )

  console.log('\n── 审计上报 ──')
  const events = [
    { type: 'run.completed', sessionId: 's-1', model: 'cp/internal', inputTokens: 120, outputTokens: 40, at: new Date().toISOString() },
    { type: 'tool.denied', sessionId: 's-1', toolName: 'bash', at: new Date().toISOString() }
  ]
  const pushed = await call('/api/audit/events', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ events })
  })
  const pushedBody = await pushed.json()
  check('批量上报被接收', pushed.status === 200 && pushedBody.accepted === 2, JSON.stringify(pushedBody))

  const received = await (await call('/__received')).json()
  check('服务端确实记录到了这两条', received.auditEvents.length === 2, JSON.stringify(received.auditEvents))
  check(
    '事件载荷完整（类型 / 会话 / 用量或工具名）',
    received.auditEvents[0].sessionId === 's-1' && received.auditEvents[0].inputTokens === 120,
    JSON.stringify(received.auditEvents[0])
  )
  check(
    '审计载荷里不含对话内容字段',
    received.auditEvents.every((e) => !('messages' in e) && !('content' in e) && !('prompt' in e)),
    JSON.stringify(received.auditEvents[0])
  )

  const unauthPush = await call('/api/audit/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: [] })
  })
  check('未鉴权的审计上报返回 401', unauthPush.status === 401, `实际 ${unauthPush.status}`)
} catch (error) {
  failures += 1
  console.log(`  FAIL  契约自测自身出错: ${String(error)}`)
} finally {
  server.kill()
}

console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
