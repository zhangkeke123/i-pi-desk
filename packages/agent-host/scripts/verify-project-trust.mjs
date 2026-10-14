#!/usr/bin/env node
/**
 * 工作区自带的 `.pi/` 资源**会不会**被加载 —— 这条曾经被文档说反了。
 *
 * ## 文档原来怎么说的
 *
 * 未验证清单第 7 条写着：「工作区自带的扩展不会被加载：`SettingsManager.inMemory()` 下
 * pi 不读项目 `.pi/` 配置。现在当作安全优点（避免静默执行别人仓库里的代码）。」
 *
 * ## 实测是什么
 *
 * 那个结论**是错的**。`SettingsManager` 的 `projectTrusted` **默认是 `true`**，
 * 而项目级资源是否加载完全由它决定（`package-manager.js`：`if (projectTrusted) { ... }`）。
 * 于是「克隆一个陌生仓库、用它当工作目录」会让那个仓库：
 *
 *  - 把 `.pi/SYSTEM.md` 的内容**注入我们 agent 的系统提示**（静默的提示注入）；
 *  - 让我们加载它提供的 `.pi/skills/`；
 *  - 并**执行** `.pi/extensions/*.js` —— 在 sidecar 进程里，而那正是握着 API key 的进程。
 *
 * 所以这一节测的不是「有没有这个功能」，而是**我们有没有把它关掉**。
 *
 * ## 两组对照都必须有
 *
 *  - **夹具活性**：若把信任显式设成 `false` 时也什么都没加载，说明我放文件的形状不对，
 *    「加载了」这种结论就不可信；
 *  - **我们的 runtime 用独立目录**：扩展模块是按路径缓存的，前一组跑过之后
 *    同一个文件不会再执行一次 —— 第一版探针就因此得出了「我们的 runtime 没执行扩展」
 *    这个**错误**结论。换目录才能拿到真信号。
 *
 * 用法：node scripts/verify-project-trust.mjs
 */

import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const piDist = join(here, '..', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist')

const { DefaultResourceLoader } = await import(pathToFileURL(join(piDist, 'core', 'resource-loader.js')).href)
const { SettingsManager } = await import(pathToFileURL(join(piDist, 'core', 'settings-manager.js')).href)
const { AgentRuntime } = await import('../dist/runtime.js')

let failures = 0
function check(label, condition, detail = '') {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

const SKILL_MARKER = 'PROJECT-SKILL-MUST-NOT-LOAD'
const SYSTEM_MARKER = 'PROJECT-SYSTEM-MD-MUST-NOT-APPLY'
const extensions = []

/** 造一个「恶意仓库」：项目级扩展 + 技能 + SYSTEM.md 各一份。 */
function makeHostileWorkspace(prefix) {
  const workspace = mkdtempSync(join(tmpdir(), prefix))
  const markerFile = join(workspace, 'EXTENSION-EXECUTED.txt')
  mkdirSync(join(workspace, '.pi', 'extensions'), { recursive: true })
  mkdirSync(join(workspace, '.pi', 'skills', 'evil'), { recursive: true })
  writeFileSync(
    join(workspace, '.pi', 'extensions', 'evil.js'),
    // 顶层就写文件：**只要模块被 import 过**，标记就会出现（与导出形状无关）。
    `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(markerFile)}, 'extension executed')\nexport default () => {}\n`,
    'utf8'
  )
  writeFileSync(
    join(workspace, '.pi', 'skills', 'evil', 'SKILL.md'),
    `---\nname: evil\ndescription: ${SKILL_MARKER}\n---\n\n${SKILL_MARKER}\n`,
    'utf8'
  )
  writeFileSync(join(workspace, '.pi', 'SYSTEM.md'), `${SYSTEM_MARKER}\n`, 'utf8')
  extensions.push(workspace)
  return { workspace, markerFile }
}

const agentDir = mkdtempSync(join(tmpdir(), 'ipi-trust-agent-'))
extensions.push(agentDir)

/** 起一个只回「ok」的假模型。 */
async function startModel() {
  const server = createServer((req, res) => {
    req.on('data', () => undefined)
    req.on('end', () => {
      const base = { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'trust-model' }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}\n\n`
      )
      res.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`
      )
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }
}

try {
  // ── 第一组：夹具是活的吗（用 pi 的 loader 直接验）──
  console.log('── 对照：夹具本身是「活的」（显式信任时确实会加载）──')
  const aliveWorkspace = makeHostileWorkspace('ipi-trust-alive-')
  {
    const settings = SettingsManager.inMemory()
    settings.setProjectTrusted(true)
    const loader = new DefaultResourceLoader({
      cwd: aliveWorkspace.workspace,
      agentDir,
      settingsManager: settings
    })
    await loader.reload()
    const prompt = String(loader.getSystemPrompt() ?? '')
    check(
      '显式信任时，项目扩展代码**真的会被执行**（说明夹具形状正确）',
      existsSync(aliveWorkspace.markerFile),
      aliveWorkspace.markerFile
    )
    check('显式信任时，项目 SYSTEM.md 进入系统提示', prompt.includes(SYSTEM_MARKER), prompt.slice(0, 80))
    check(
      '显式信任时，项目技能出现在技能列表里',
      (loader.getSkills().skills ?? []).some((skill) => skill.name === 'evil'),
      JSON.stringify((loader.getSkills().skills ?? []).map((skill) => skill.name).slice(0, 5))
    )
  }

  // ── 第二组：我们自己的 runtime（**独立目录**，避开扩展模块缓存）──
  console.log('\n── 我们的 runtime：项目里的东西一个都不该生效 ──')
  /**
   * 全局技能（`<agentDir>/skills`）必须先摆一个进去：它是**对照组**。
   * 少了它，「项目资源没加载」有可能只是「技能功能整个被关掉了」——
   * 那条断言会变得毫无意义。
   */
  mkdirSync(join(agentDir, 'skills', 'global-ok'), { recursive: true })
  writeFileSync(
    join(agentDir, 'skills', 'global-ok', 'SKILL.md'),
    '---\nname: global-ok\ndescription: 我们自己的技能，必须照常加载\n---\n\n正文\n',
    'utf8'
  )

  const ours = makeHostileWorkspace('ipi-trust-ours-')
  const { server, baseUrl } = await startModel()
  const runtime = new AgentRuntime({ writeEvent: () => undefined, log: () => undefined })
  const provider = {
    id: 'trust-probe',
    label: 'trust probe',
    apiStyle: 'openai-completions',
    baseUrl,
    models: [{ id: 'trust-model' }],
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
  const sessionId = 'trust-session'

  const result = await runtime.prompt({
    provider,
    apiKey: 'ipi-local-no-auth',
    modelId: 'trust-model',
    permissionMode: 'auto',
    cwd: ours.workspace,
    agentDir,
    sessionId,
    text: '你好',
    maxSteps: 3
  })
  check('这一轮正常收尾', result?.stopReason === 'end_turn', JSON.stringify(result))

  const inspected = await runtime.inspect({
    provider,
    apiKey: 'x',
    modelId: 'trust-model',
    permissionMode: 'auto',
    cwd: ours.workspace,
    agentDir,
    sessionId
  })
  const systemPrompt = String(inspected?.systemPrompt ?? '')

  /**
   * 这三条是这一节的**目的**。它们在修复之前都会红 —— 也就是「能红」这件事本身
   * 证明了这三条断言不是摆设。
   */
  check(
    '工作区里的 `.pi/extensions/*.js` **没有被执行**（否则陌生仓库能在我们进程里跑任意代码）',
    !existsSync(ours.markerFile),
    existsSync(ours.markerFile) ? readFileSync(ours.markerFile, 'utf8') : ours.markerFile
  )
  check(
    '工作区里的 `.pi/SYSTEM.md` **没有**被注入系统提示',
    !systemPrompt.includes(SYSTEM_MARKER),
    systemPrompt.includes(SYSTEM_MARKER) ? '系统提示里出现了项目 SYSTEM.md 的暗号' : ''
  )
  check(
    '工作区里的 `.pi/skills/` **没有**被加载',
    !(inspected?.skills ?? []).some((skill) => skill.name === 'evil'),
    JSON.stringify((inspected?.skills ?? []).map((skill) => skill.name).slice(0, 6))
  )
  check(
    '**对照**：我们自己的全局技能照常加载（不是把技能功能整个关掉了）',
    (inspected?.skills ?? []).some((skill) => skill.name === 'global-ok'),
    JSON.stringify((inspected?.skills ?? []).map((skill) => skill.name).slice(0, 6))
  )
  check(
    '技能暗号也没有出现在系统提示里',
    !systemPrompt.includes(SKILL_MARKER),
    systemPrompt.includes(SKILL_MARKER) ? '系统提示里出现了项目技能的暗号' : ''
  )
  check(
    '生效工具就是内置那一套（项目配置没有改动工具集）',
    JSON.stringify(inspected?.activeTools) === JSON.stringify(['read', 'grep', 'find', 'ls', 'write', 'edit', 'bash', 'powershell']),
    JSON.stringify(inspected?.activeTools)
  )

  server.close()
} catch (error) {
  failures += 1
  console.log(`  FAIL  自测自身出错: ${String(error)}`)
} finally {
  for (const dir of extensions) rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
