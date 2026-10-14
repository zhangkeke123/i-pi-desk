#!/usr/bin/env node
/**
 * 内核侧**没有**会话持久化 —— 这条是「只有一份历史」的前提。
 *
 * ## 为什么值得单独验
 *
 * 我们的架构里，**主进程是会话持久化的唯一权威**，内核（pi 的 `SessionManager`）
 * 是 `inMemory` 的；重启后的上下文由主进程把落盘消息随 prompt 附上、让内核重放（§5.3）。
 *
 * 这个设计有一个**不会自己暴露**的失效方式：**内核哪天开始自己写会话文件**。
 * 那会变成两份历史 —— 两份会各自增长、互相覆盖，而表现只是「有时候历史对不上」。
 * 更麻烦的是它会悄悄让「重放」变成重复：一边内核自己记得，一边我们又喂一遍。
 *
 * 所以这里要钉住两条：
 *
 *  1. **一次 run 不会把对话写到内核的数据目录里**（用一句独一无二的暗号去搜整棵目录）；
 *  2. **新建一个 runtime（= sidecar 重启）后，同一个会话 id 完全失忆** ——
 *     如果它「记得」，说明有我们不知道的持久化，那整套「主进程回灌」的假设就不成立了。
 *
 * 对照不能少：同一轮里必须证明**那句暗号真的经过了内核**（假模型收到了它）。
 * 少了这条，「目录里搜不到」可能只是因为这轮压根没跑起来。
 *
 * 用法：node scripts/verify-kernel-no-persistence.mjs
 */

import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
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

/** 独一无二的暗号：只要它出现在磁盘上，就说明有人把对话写下来了。 */
const MARKER = `KERNEL-MUST-NOT-PERSIST-${Date.now()}`

const received = []

function streamFor(body) {
  received.push(body)
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const roles = messages.map((message) => message.role ?? '?')
  const base = { id: 'chatcmpl-nopersist', object: 'chat.completion.chunk', created: 1, model: 'nopersist-model' }
  const wrap = (delta, finishReason = null) => ({
    ...base,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  })
  // 把「我这一轮看到的历史角色序列」回显出来 —— 失忆与否于是可断言。
  return [
    wrap({ role: 'assistant', content: `我看到的角色序列：${roles.join(',')}` }),
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
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

const agentDir = mkdtempSync(join(tmpdir(), 'ipi-nopersist-agent-'))
const workspace = mkdtempSync(join(tmpdir(), 'ipi-nopersist-ws-'))

const provider = {
  id: 'nopersist-provider',
  label: 'NoPersist Mock',
  apiStyle: 'openai-completions',
  baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
  models: [{ id: 'nopersist-model' }],
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

function makeRuntime() {
  const events = []
  return {
    events,
    runtime: new AgentRuntime({ writeEvent: (_sessionId, event) => events.push(event), log: () => undefined })
  }
}

function runPrompt(runtime, sessionId, text) {
  return runtime
    .prompt({
      provider,
      apiKey: 'ipi-local-no-auth',
      modelId: 'nopersist-model',
      permissionMode: 'auto',
      cwd: workspace,
      agentDir,
      sessionId,
      text,
      maxSteps: 10
    })
    .catch((error) => ({ stopReason: 'error', error: String(error) }))
}

/** 递归列出目录里的所有文件（含符号链接目标判断），用于「有没有被写下来」。 */
function walkFiles(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    let isDir = entry.isDirectory()
    if (!isDir && entry.isSymbolicLink()) {
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        isDir = false
      }
    }
    if (isDir) walkFiles(full, out)
    else out.push(full)
  }
  return out
}

/** 整棵目录里有没有出现暗号（比「猜它写在哪个文件」可靠得多）。 */
function findMarker(dir) {
  return walkFiles(dir).filter((file) => {
    try {
      return readFileSync(file, 'utf8').includes(MARKER)
    } catch {
      return false
    }
  })
}

try {
  console.log('── 一轮真实 run：内核有没有把对话写下来 ──')
  const a = makeRuntime()
  const sessionId = 'nopersist-session'
  const result = await runPrompt(a.runtime, sessionId, `请记住这个暗号：${MARKER}`)

  check('这一轮正常收尾', result?.stopReason === 'end_turn', JSON.stringify(result))
  check('假模型确实收到了这句暗号（对照：暗号真的经过了内核）', JSON.stringify(received).includes(MARKER), `请求数=${received.length}`)

  const sessionsDir = join(agentDir, 'sessions')
  check(
    '内核的 sessions 目录里没有会话文件',
    !existsSync(sessionsDir) || readdirSync(sessionsDir).length === 0,
    existsSync(sessionsDir) ? JSON.stringify(readdirSync(sessionsDir)) : '(目录不存在)'
  )
  const markerFiles = findMarker(agentDir)
  check(
    '**整棵内核数据目录里都搜不到那句暗号**（没有任何隐藏的第二份历史）',
    markerFiles.length === 0,
    JSON.stringify(markerFiles)
  )

  console.log('\n── 进程内视图：内存里是有的 ──')
  const inMemorySessions = a.runtime.listSessions()
  check(
    '同一个 runtime 里 listSessions 能看到它（说明它确实活在内存里）',
    inMemorySessions.some((session) => session.id === sessionId),
    JSON.stringify(inMemorySessions.map((session) => session.id))
  )
  const snapshot = a.runtime.loadSession(sessionId)
  check(
    'loadSession 能读回这一轮的消息（进程内视图）',
    Array.isArray(snapshot?.messages) && snapshot.messages.length >= 2,
    JSON.stringify(snapshot?.messages?.length)
  )

  console.log('\n── 新 runtime（= sidecar 重启）：应当完全失忆 ──')
  const b = makeRuntime()
  check(
    '新 runtime 的 listSessions 里没有它（没有持久化，所以也没有「凭空回来」的会话）',
    !b.runtime.listSessions().some((session) => session.id === sessionId),
    JSON.stringify(b.runtime.listSessions().map((session) => session.id))
  )

  const receivedBefore = received.length
  const secondRun = await runPrompt(b.runtime, sessionId, '我刚才让你记的暗号是什么？')
  check('重启后的这一轮也正常收尾', secondRun?.stopReason === 'end_turn', JSON.stringify(secondRun))
  const secondRequest = received[receivedBefore]
  const secondRoles = (secondRequest?.messages ?? []).map((message) => message.role)
  check(
    '重启后内核**不记得**之前的对话（模型只看到这一句新提问）',
    secondRoles.filter((role) => role === 'user').length === 1 && !JSON.stringify(secondRequest).includes(MARKER),
    JSON.stringify(secondRoles)
  )
  check(
    '而且上下文里**没有任何 assistant 消息**（上一轮的痕迹一点都没留下）',
    !secondRoles.includes('assistant'),
    JSON.stringify(secondRoles)
  )

  console.log('\n── 收尾：dispose 之后内存里也没了 ──')
  const disposed = await a.runtime.disposeSession(sessionId)
  check('disposeSession 报告已回收', disposed?.disposed === true, JSON.stringify(disposed))
  check(
    'dispose 之后 listSessions 里就没有它了（内存视图，不是删除磁盘文件）',
    !a.runtime.listSessions().some((session) => session.id === sessionId),
    JSON.stringify(a.runtime.listSessions().map((session) => session.id))
  )
  check('dispose 之后整棵目录里依然搜不到暗号', findMarker(agentDir).length === 0, JSON.stringify(findMarker(agentDir)))
} catch (error) {
  failures += 1
  console.log(`  FAIL  自测自身出错: ${String(error)}`)
} finally {
  server.close()
  rmSync(agentDir, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
