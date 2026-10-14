#!/usr/bin/env node
/**
 * `grep` / `find` 依赖的 rg/fd 是怎么找、怎么下载、失败时怎么办。
 *
 * ## 这一条原来在「未验证」清单里
 *
 * 原文是：「pi 在 PATH 里没有 rg/fd 时会下载二进制。落点是 import 期固化的 `TOOLS_DIR`
 * （现已指向 `<userData>/pi-agent`），但**没在干净环境实测过下载行为**。」
 *
 * 对一个桌面客户端来说这不是小事：**全新机器上大概率没有 ripgrep**，
 * 而 `grep` 是 agent 最常用的工具之一。所以要知道三件事：
 *
 *  1. 它先找哪里？（本地 bin 目录 → PATH）
 *  2. 找不到会怎样？（下载 → 这是**联网行为**，用户应当知情）
 *  3. 下载不了会怎样？（离线 / 公司代理 / 没网 —— 工具报错还是整轮崩掉？）
 *
 * ## 怎么在离线环境里确定地验「下载失败」
 *
 * 不靠「拔网线」，而是把 `globalThis.fetch` 换成一个必抛的桩，并**断言桩确实被调用了** ——
 * 否则「失败信息是我们造的」还是「网络本来就不可达」就分不清了
 * （实测时机器是联网的，真去 GitHub 下载反而会让结论不确定）。
 *
 * ## 环境必须在 import 之前设好
 *
 * `tools-manager.js` 里的 `TOOLS_DIR = getBinDir()` 是**模块加载时**求值的，
 * 所以 agentDir 指向哪里，取决于 import 那一刻的环境变量。
 * 这也正是我们的 sidecar 必须先设 `PI_CODING_AGENT_DIR` 再启动的原因。
 *
 * 用法：node scripts/verify-tools-download.mjs
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const piRoot = join(here, '..', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist')

let failures = 0
function check(label, condition, detail = '') {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

// ── 先把环境摆好，再 import（TOOLS_DIR 在 import 期固化）──
const agentDir = mkdtempSync(join(tmpdir(), 'ipi-tools-agent-'))
const emptyPath = mkdtempSync(join(tmpdir(), 'ipi-tools-path-'))
const realRgDir = 'C:\\Program Files\\ZCode\\resources\\tools\\ripgrep'
const realRg = join(realRgDir, 'rg.exe')

const originalPath = process.env.PATH
process.env.PI_CODING_AGENT_DIR = agentDir
process.env.PATH = emptyPath
delete process.env.PI_OFFLINE

/** 统计桩被调用了几次 —— 「失败是我们造的」这件事必须可证。 */
let fetchCalls = 0
const realFetch = globalThis.fetch
globalThis.fetch = async () => {
  fetchCalls += 1
  throw new Error('verify-tools-download 的离线桩：不访问网络')
}

const tools = await import(pathToFileURL(join(piRoot, 'utils', 'tools-manager.js')).href)
const config = await import(pathToFileURL(join(piRoot, 'config.js')).href)

const binDir = join(agentDir, 'bin')
const binEntries = () => (existsSync(binDir) ? readdirSync(binDir) : [])
/** 只有状态回调能告诉我们「它打算干什么」。 */
const collectStatus = () => {
  const seen = []
  return { seen, onStatus: (status) => seen.push(status) }
}

try {
  console.log('── 落点：下载会写到哪里 ──')
  check(
    '工具目录跟着 agentDir 走（我们的 sidecar 就是靠 PI_CODING_AGENT_DIR 把它钉在 <userData>/pi-agent）',
    config.getBinDir() === binDir,
    `${config.getBinDir()} vs ${binDir}`
  )

  console.log('\n── 先找哪里：本地 bin 目录优先于 PATH ──')
  check('PATH 里没有 rg 时，本地又没装 → 找不到', tools.getToolPath('rg') === null, String(tools.getToolPath('rg')))

  mkdirSync(binDir, { recursive: true })
  const fakeLocal = join(binDir, 'rg.exe')
  writeFileSync(fakeLocal, 'not-a-real-binary')
  check(
    '本地 bin 目录里有一个时，**优先用本地的**（而不是 PATH）',
    tools.getToolPath('rg') === fakeLocal,
    String(tools.getToolPath('rg'))
  )
  rmSync(fakeLocal, { force: true })

  console.log('\n── 离线模式：明确跳过下载 ──')
  process.env.PI_OFFLINE = '1'
  const offline = collectStatus()
  const offlineResult = await tools.ensureTool('rg', offline.onStatus)
  check('离线模式下不返回路径（= 没得用）', offlineResult === undefined, String(offlineResult))
  check(
    '给出一条说明「因为离线所以跳过下载」的状态',
    offline.seen.some((status) => /[Oo]ffline mode/.test(status.message)),
    JSON.stringify(offline.seen)
  )
  check('离线模式下**没有联网**', fetchCalls === 0, String(fetchCalls))
  check('离线模式下 bin 目录里没有留下任何东西', binEntries().length === 0, JSON.stringify(binEntries()))

  console.log('\n── 下载失败：错误信息可读，且不留下半截文件 ──')
  delete process.env.PI_OFFLINE
  const beforeFailedDownload = fetchCalls
  const failed = collectStatus()
  const failedResult = await tools.ensureTool('rg', failed.onStatus)
  check('下载失败时不返回路径', failedResult === undefined, String(failedResult))
  check(
    '**桩确实被调用了**（证明这次失败是我们造的，而不是网络本来就不可达）',
    fetchCalls > beforeFailedDownload,
    `${beforeFailedDownload} → ${fetchCalls}`
  )
  check(
    '状态里说明了正在尝试下载',
    failed.seen.some((status) => /Downloading/.test(status.message)),
    JSON.stringify(failed.seen)
  )
  /**
   * 这一条最要紧：**半截二进制比没有更糟**。
   * 下一次 `getToolPath` 只做 `existsSync` 检查 —— 一个损坏的 rg.exe 会被当成「已安装」，
   * 于是每次 grep 都失败，而用户完全不知道该删哪个文件。
   */
  check('失败后 bin 目录里**没有留下半截文件**', binEntries().length === 0, JSON.stringify(binEntries()))

  console.log('\n── 对照：PATH 里有 rg 时，一次网络都不碰 ──')
  if (existsSync(realRg)) {
    // 用真的 rg（本机 PATH 上那个），而不是造一个 shim ——
    // `commandExists` 会去跑 `rg --version`，假的 .cmd 在 spawn 下行为不确定。
    copyFileSync(realRg, join(emptyPath, 'rg.exe'))
    const fetchesBefore = fetchCalls
    const pathHit = tools.getToolPath('rg')
    const ensured = await tools.ensureTool('rg', collectStatus().onStatus)
    check('PATH 里能找到时返回命令名（而不是绝对路径）', pathHit === 'rg', String(pathHit))
    check('ensureTool 直接返回，不再下载', ensured === 'rg', String(ensured))
    check('整个过程没有联网', fetchCalls === fetchesBefore, String(fetchCalls - fetchesBefore))
    rmSync(join(emptyPath, 'rg.exe'), { force: true })
  } else {
    console.log(`  NOTE  本机 ${realRg} 不存在，跳过「PATH 命中」的对照`)
  }

  /**
   * 上面验的都是「查找 / 下载」这一层。用户真正在意的是**模型最后看到了什么** ——
   * 所以再走一遍真实的工具调用：假模型调 `grep`，而本机没有可用的 rg。
   *
   * 这里只用得起「离线模式」这条路：联网时真去 GitHub 下载会让结论不确定
   * （而且我们也不该在自测里下载二进制）。
   */
  console.log('\n── 用户可见的结果：模型收到的工具结果 ──')
  /**
   * ⚠️ 先把 `globalThis.fetch` 的桩**卸掉**。
   *
   * 第一版忘了这一步，于是这一轮的所有模型请求都被自己的桩打掉 ——
   * 表现成 `PROVIDER_ERROR: Connection error.`、假模型被请求 0 次，
   * 而事件里那几次 `run.started` 是 provider 的重试。
   * 一句话：**桩装上了就要在本段结束、下一段开始之前卸掉**，否则它会伪造出一个
   * 看起来像产品缺陷的现象。
   */
  globalThis.fetch = realFetch
  process.env.PI_OFFLINE = '1'
  process.env.PATH = emptyPath

  const { AgentRuntime } = await import('../dist/runtime.js')
  const { createServer } = await import('node:http')

  const received = []
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
      const messages = Array.isArray(body?.messages) ? body.messages : []
      const lastMessage = messages[messages.length - 1]
      const base = { id: 'chatcmpl-tools', object: 'chat.completion.chunk', created: 1, model: 'tools-model' }
      const wrap = (delta, finishReason = null) => ({
        ...base,
        choices: [{ index: 0, delta, finish_reason: finishReason }]
      })
      const chunks =
        lastMessage?.role === 'tool'
          ? [
              // 把工具结果回显，于是「模型看到了什么」可断言。
              wrap({
                role: 'assistant',
                content: `工具回传说：${String(lastMessage.content ?? '').slice(0, 300)}`
              }),
              { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } }
            ]
          : [
              wrap({
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_grep_1',
                    type: 'function',
                    function: { name: 'grep', arguments: JSON.stringify({ pattern: 'needle' }) }
                  }
                ]
              }),
              { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 15, completion_tokens: 6, total_tokens: 21 } }
            ]
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  const workspace = mkdtempSync(join(tmpdir(), 'ipi-tools-ws-'))
  const events = []
  const runtime = new AgentRuntime({
    writeEvent: (_sessionId, event) => events.push(event),
    log: () => undefined
  })

  try {
    const result = await runtime
      .prompt({
        provider: {
          id: 'tools-provider',
          label: 'Tools Mock',
          apiStyle: 'openai-completions',
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          models: [{ id: 'tools-model' }],
          enabled: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        },
        apiKey: 'ipi-local-no-auth',
        modelId: 'tools-model',
        // auto：grep 是只读工具，不该被审批挡住 —— 这一节要验的是「没有 rg」而不是审批。
        permissionMode: 'auto',
        cwd: workspace,
        agentDir,
        sessionId: 'tools-session',
        text: '搜一下 needle',
        maxSteps: 10
      })
      .catch((error) => ({ stopReason: 'error', error: String(error) }))

    check('没有 rg 时这一轮**正常收尾**（工具报错不等于整轮崩掉）', typeof result?.stopReason === 'string', JSON.stringify(result))
    if (result?.stopReason === 'error') {
      // 工具抛错把整轮判成失败时，用户看到的原因是什么？这一条必须能读。
      const failed = events.find((event) => event.type === 'run.failed')
      console.log(`        [诊断] 事件：${JSON.stringify(events.map((event) => event.type))}`)
      console.log(`        [诊断] run.failed：${JSON.stringify(failed?.error)}`)
      console.log(`        [诊断] 假模型被请求 ${received.length} 次`)
      for (const [index, body] of received.entries()) {
        const roles = (body?.messages ?? []).map((message) => message.role ?? '?')
        console.log(`        [诊断]   第 ${index + 1} 次：roles=${JSON.stringify(roles)}`)
      }
    }
    check('这一轮没有被判成失败', result?.stopReason !== 'error', JSON.stringify(result))

    const toolFinished = events.find((event) => event.type === 'tool.finished')
    check('工具调用被明确标为未成功', toolFinished?.ok === false, JSON.stringify(toolFinished))

    const followUp = received.find((body) => (body?.messages ?? []).some((message) => message.role === 'tool'))
    const toolMessage = (followUp?.messages ?? []).find((message) => message.role === 'tool')
    const toolText = typeof toolMessage?.content === 'string' ? toolMessage.content : null
    check('模型**收到了一条工具结果**（不是静默失败）', typeof toolText === 'string', JSON.stringify(toolText))
    check(
      '那条结果里点名了是 ripgrep 不可用（而不是一句无信息的「失败」）',
      typeof toolText === 'string' && /ripgrep|rg/.test(toolText),
      JSON.stringify(toolText)
    )
    check(
      '工具报错之后 bin 目录里仍然没有下到东西',
      binEntries().length === 0,
      JSON.stringify(binEntries())
    )
  } finally {
    server.close()
    rmSync(workspace, { recursive: true, force: true })
  }
} catch (error) {
  failures += 1
  console.log(`  FAIL  自测自身出错: ${String(error)}`)
} finally {
  globalThis.fetch = realFetch
  process.env.PATH = originalPath
  delete process.env.PI_CODING_AGENT_DIR
  delete process.env.PI_OFFLINE
  rmSync(agentDir, { recursive: true, force: true })
  rmSync(emptyPath, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
