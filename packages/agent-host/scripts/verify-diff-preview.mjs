#!/usr/bin/env node
/**
 * 差异预览的**内容**是否正确 —— 走真实的「工具调用 → 审批」链路。
 *
 * ## 这一条原来在「未验证」清单里
 *
 * 原文是：「差异预览只做过单元测试：`approval-preview.ts` 的 20 个用例全绿，
 * 且 `verify:renderer` 已断言审批事件里带 `previewDiff`，但**没有在真实 UI 里
 * 对着一次真实编辑确认过渲染效果**。」
 *
 * 单元测试验的是 `buildApprovalPreview` 这个函数本身。**没验的是接线**：
 * pi 会把工具参数解析成什么形状、我们拿到的路径是相对谁的、
 * 以及真实文件内容下算出来的 diff 是否就是那几行。
 * 形状对不上时不会报错 —— 只会**静默降级**成「只显示参数」的视图，
 * 而那正好是审批从「知情同意」退回「摆设」的形态。
 *
 * 所以这里每一种降级分支都要有一条断言，尤其是两个**必须退化**的情形：
 *  `oldText` 匹配不到、或出现多次 —— 那时**宁可给意图视图，也不要给一个漂亮的假 diff**。
 *
 * 用法：node scripts/verify-diff-preview.mjs
 */

import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

const workspace = mkdtempSync(join(tmpdir(), 'ipi-diff-ws-'))
const agentDir = mkdtempSync(join(tmpdir(), 'ipi-diff-agent-'))

// 夹具：一个已存在的文件、一个内容有重复的文件。
writeFileSync(join(workspace, 'file.txt'), 'alpha\nbeta\n', 'utf8')
writeFileSync(join(workspace, 'dup.txt'), 'dup\nmiddle\ndup\n', 'utf8')

/** 用户消息里的标记 → 假模型这一轮要发起的工具调用。 */
const SCRIPT = {
  '@write-update': { name: 'write', args: { path: 'file.txt', content: 'alpha\ngamma\n' } },
  '@write-new': { name: 'write', args: { path: 'brandnew.txt', content: 'fresh-line\n' } },
  '@edit': { name: 'edit', args: { path: 'file.txt', edits: [{ oldText: 'beta', newText: 'delta' }] } },
  '@edit-missing': { name: 'edit', args: { path: 'file.txt', edits: [{ oldText: 'not-in-file', newText: 'x' }] } },
  '@edit-ambiguous': { name: 'edit', args: { path: 'dup.txt', edits: [{ oldText: 'dup', newText: 'DUP' }] } },
  '@bash': { name: 'bash', args: { command: 'echo hi' } }
}

function lastUserText(messages) {
  const last = [...messages].reverse().find((message) => message?.role === 'user')
  const content = last?.content
  return typeof content === 'string' ? content : JSON.stringify(content ?? '')
}

function streamFor(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const lastMessage = messages[messages.length - 1]
  const base = { id: 'chatcmpl-diff', object: 'chat.completion.chunk', created: 1, model: 'diff-model' }
  const wrap = (delta, finishReason = null) => ({
    ...base,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  })

  if (lastMessage?.role === 'tool') {
    return [
      wrap({ role: 'assistant', content: '好的' }),
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } }
    ]
  }

  const text = lastUserText(messages)
  /**
   * 按**最长匹配**取脚本。
   *
   * 第一版直接用 `find(...includes...)`，于是 `@edit-missing` 命中了 `@edit`
   * （前缀包含），三种 edit 分支全跑成了同一个 —— 表现是「三种情形拿到的预览一模一样」。
   * 那是测试自己的分派错误，不是产品行为。
   */
  const key = Object.keys(SCRIPT)
    .filter((candidate) => text.includes(candidate))
    .sort((a, b) => b.length - a.length)[0]
  const call = key ? SCRIPT[key] : null
  if (!call) {
    return [
      wrap({ role: 'assistant', content: '（没有匹配的脚本）' }),
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } }
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
          function: { name: call.name, arguments: JSON.stringify(call.args) }
        }
      ]
    }),
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }
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

const provider = {
  id: 'diff-provider',
  label: 'Diff Mock',
  apiStyle: 'openai-completions',
  baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
  models: [{ id: 'diff-model' }],
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

const events = []
const runtime = new AgentRuntime({
  writeEvent: (_sessionId, event) => events.push(event),
  log: () => undefined
})

/** 跑一轮，拿到这一轮审批事件里的 `previewDiff`（预览在裁决**之前**就算好了）。 */
async function previewFor(marker, sessionId) {
  const from = events.length
  const promise = runtime
    .prompt({
      provider,
      apiKey: 'ipi-local-no-auth',
      modelId: 'diff-model',
      // ask：write / edit / bash 都要过审批闸门 —— 预览正是闸门算的。
      permissionMode: 'ask',
      cwd: workspace,
      agentDir,
      sessionId,
      text: marker,
      maxSteps: 6
    })
    .catch((error) => ({ stopReason: 'error', error: String(error) }))

  // 等审批出现（最多 20 秒），出现就拒绝 —— 这一节只看预览，不需要真的执行。
  const deadline = Date.now() + 20_000
  let requested
  while (Date.now() < deadline && !requested) {
    requested = events.slice(from).find((event) => event.type === 'approval.requested')
    if (!requested) await new Promise((r) => setTimeout(r, 50))
  }
  if (requested) runtime.resolveApproval({ sessionId, approvalId: requested.approvalId, decision: 'deny' })
  await promise
  return requested
}

/**
 * pi 的展示用 diff 每一行长这样：`-2 beta` / `+2 delta` / ` 1 alpha`
 * —— **标记在前、行号在后、然后才是内容**。
 *
 * 第一版按「标记紧挨内容」（`-beta`）去断言，全部假红。
 * 这里用容忍行号的正则，把断言绑在「这一行被删了/加了」这个性质上，而不是具体排版。
 */
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const hasAdded = (preview, text) => new RegExp(`\\+[0-9]*\\s*${escapeRegExp(text)}`).test(preview)
const hasRemoved = (preview, text) => new RegExp(`-[0-9]*\\s*${escapeRegExp(text)}`).test(preview)
/** 删除行的判据：某一行的第一个非空白字符是 `-`。 */
const hasRemovalLine = (text) => /(^|\n)[^\S\n]*-[0-9]*\s/.test(text)

try {
  console.log('── write：整文件覆盖（有旧内容） ──')
  const update = await previewFor('@write-update', 'diff-write-update')
  const updatePreview = update?.previewDiff ?? ''
  check('审批事件带了预览', typeof update?.previewDiff === 'string' && updatePreview.length > 0, JSON.stringify(updatePreview.slice(0, 80)))
  check('预览说清了是整文件覆盖', updatePreview.includes('整文件覆盖'), JSON.stringify(updatePreview.slice(0, 60)))
  check('预览里出现了**被删掉的那一行**', hasRemoved(updatePreview, 'beta'), JSON.stringify(updatePreview))
  check('预览里出现了**新增的那一行**', hasAdded(updatePreview, 'gamma'), JSON.stringify(updatePreview))
  check('路径就是工具参数里那个（相对 cwd 解析）', updatePreview.includes('file.txt'), JSON.stringify(updatePreview.slice(0, 60)))

  console.log('\n── write：新建文件（没有旧内容） ──')
  const created = await previewFor('@write-new', 'diff-write-new')
  const createdPreview = created?.previewDiff ?? ''
  check('预览说明了将写入几行', /将写入 \d+ 行/.test(createdPreview), JSON.stringify(createdPreview.slice(0, 60)))
  check('新增行在预览里', hasAdded(createdPreview, 'fresh-line'), JSON.stringify(createdPreview))
  check(
    '新建文件的预览里**没有删除行**（无中生有地画一条「删掉」是误导）',
    !hasRemovalLine(createdPreview.replace(/^[^\n]*\n\n/, '')),
    JSON.stringify(createdPreview)
  )

  console.log('\n── edit：pi 的参数是 { path, edits: [{oldText,newText}] } ──')
  const edited = await previewFor('@edit', 'diff-edit')
  const editPreview = edited?.previewDiff ?? ''
  check('预览里出现了被替换掉的那段', hasRemoved(editPreview, 'beta'), JSON.stringify(editPreview))
  check('预览里出现了替换成的那段', hasAdded(editPreview, 'delta'), JSON.stringify(editPreview))
  check('预览头部说明了改动处数', /（1 处改动）/.test(editPreview), JSON.stringify(editPreview.slice(0, 60)))

  console.log('\n── 必须退化的情形：oldText 匹配不到 ──')
  const missing = await previewFor('@edit-missing', 'diff-edit-missing')
  const missingPreview = missing?.previewDiff ?? ''
  check('明确说明「未精确匹配到」，而不是假装知道改哪里', missingPreview.includes('未在文件中精确匹配到'), JSON.stringify(missingPreview.slice(0, 120)))
  check('退回到「按意图列出改动」的视图', missingPreview.includes('── 改动 1 ──'), JSON.stringify(missingPreview.slice(0, 200)))

  console.log('\n── 必须标注的情形：oldText 出现多次 ──')
  const ambiguous = await previewFor('@edit-ambiguous', 'diff-edit-ambiguous')
  const ambiguousPreview = ambiguous?.previewDiff ?? ''
  check('标注了「出现多次、实际位置可能不同」', ambiguousPreview.includes('出现多次'), JSON.stringify(ambiguousPreview.slice(0, 160)))
  check('同时也给出了它推断出的 diff', hasAdded(ambiguousPreview, 'DUP'), JSON.stringify(ambiguousPreview))

  console.log('\n── 对照：bash 没有可预览的文件改动 ──')
  const bash = await previewFor('@bash', 'diff-bash')
  check('bash 的审批仍然弹出（命令本身才是要审的东西）', bash?.toolName === 'bash', JSON.stringify(bash?.toolName))
  check('bash 的审批**不带** previewDiff（没有文件改动可看）', bash?.previewDiff === undefined, JSON.stringify(bash?.previewDiff))
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
