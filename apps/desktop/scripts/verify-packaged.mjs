#!/usr/bin/env node
/**
 * 打包产物验证。
 *
 * `electron-builder` 退出码为 0 只说明「包做出来了」，不说明「装完能跑」。
 * 打包后有整整一类问题只在运行时暴露，而且现象与原因离得很远：
 *
 *  1. **sidecar 找不到**：`app.isPackaged` 后入口路径从仓库布局变成
 *     `process.resourcesPath/agent-host/sidecar.js`，路径算错就是「内核启动失败」；
 *  2. **原生模块在 asar 里加载不了**：`node-pty` 必须 `asarUnpack`，否则终端打不开；
 *  3. **插件运行器找不到**：它与 sidecar 主文件**同目录**，bundle 时漏拷就插件全废；
 *  4. **生产档 CSP**：开发档放开了内联脚本，生产档没有 —— 渲染层可能直接白屏。
 *
 * 这四件事都无法靠 `typecheck`/`build` 发现，只能真的把打包产物跑起来。
 *
 * 用法：
 *   node scripts/verify-packaged.mjs                       # 验证 release/win-unpacked（解包目录）
 *   node scripts/verify-packaged.mjs --exe "release/i-pi-desk 0.1.0.exe"
 *                                                          # 验证**便携版产物本身**
 *
 * 后者更接近「交付物验证」：直接跑最终那个 exe，自解压、自定位 resourcesPath 全都真实发生。
 * 代价是每次要解压一百多 MB，所以日常快速迭代用前者即可。
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')
const repoRoot = join(appRoot, '..', '..')

const exeArgIndex = process.argv.indexOf('--exe')
/** 直接跑某个 exe（例如便携版）时为 true，此时跳过「解包目录布局」那一组断言。 */
const directExe = exeArgIndex !== -1 ? resolvePath(process.argv[exeArgIndex + 1]) : null

const dirArgIndex = process.argv.indexOf('--dir')
const unpackedDir =
  dirArgIndex !== -1 ? process.argv[dirArgIndex + 1] : join(appRoot, 'release', 'win-unpacked')

const PORT = 9345
let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

if (directExe) {
  if (!existsSync(directExe)) {
    console.error(`可执行文件不存在：${directExe}`)
    process.exit(1)
  }
} else if (!existsSync(unpackedDir)) {
  console.error(`解包目录不存在：${unpackedDir}\n请先跑：pnpm --filter @i-pi-desk/desktop run pack`)
  process.exit(1)
}

// ───────────────────────── 一、静的布局检查（仅解包目录） ─────────────────────────

if (directExe) {
  console.log('── 打包布局 ──')
  console.log(`  SKIP  直接验证 exe（${directExe}）；布局检查只对解包目录有意义`)
} else {
  console.log('── 打包布局 ──')
  const resources = join(unpackedDir, 'resources')
  check('app.asar 存在', existsSync(join(resources, 'app.asar')))
  check(
    'sidecar 随 extraResources 落到了 resources/agent-host/',
    existsSync(join(resources, 'agent-host', 'sidecar.js'))
  )
  check(
    '插件运行器与 sidecar 同目录（bundle 时漏拷就插件全废）',
    existsSync(join(resources, 'agent-host', 'plugin-runner.mjs'))
  )
  check(
    'node-pty 被 asarUnpack 外置（否则终端在打包后加载不了）',
    existsSync(join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty'))
  )
  /**
   * 第三方声明必须**真的在产物里**，不只是写在配置里。
   *
   * MIT 的义务是「随分发保留声明」——拿到安装包的人看不到仓库，
   * 所以声明必须落在 `resources/` 下（配置里写了、构建时路径算错，是两回事）。
   */
  {
    const noticePath = join(resources, 'THIRD-PARTY.md')
    const present = existsSync(noticePath)
    const text = present ? readFileSync(noticePath, 'utf8') : ''
    check('第三方声明落到了 resources/THIRD-PARTY.md', present, noticePath)
    check(
      '声明内容完整（含 MIT 正文与内核包名）',
      /Copyright \(c\) \d{4} Mario Zechner/.test(text) && text.includes('@earendil-works/pi-coding-agent'),
      present ? `前 80 字：${text.slice(0, 80)}` : '(文件不存在)'
    )
  }

  const hostFiles = existsSync(join(resources, 'agent-host')) ? readdirSync(join(resources, 'agent-host')) : []
  check('agent-host 目录里有内容', hostFiles.length >= 2, JSON.stringify(hostFiles))
}

// ───────────────────────── 二、运行起来验证 ─────────────────────────

const userData = mkdtempSync(join(tmpdir(), 'ipi-packaged-'))
const workspaceRoot = mkdtempSync(join(tmpdir(), 'ipi-packaged-ws-'))
mkdirSync(join(workspaceRoot, 'src'), { recursive: true })
writeFileSync(join(workspaceRoot, 'src', 'hello.ts'), 'export const hello = "packaged"\n', 'utf8')

const workspaceId = 'packaged-workspace'
writeFileSync(
  join(userData, 'workspaces.json'),
  JSON.stringify(
    [
      {
        id: workspaceId,
        name: 'packaged-fixture',
        path: workspaceRoot,
        createdAt: new Date().toISOString(),
        lastOpenedAt: new Date().toISOString()
      }
    ],
    null,
    2
  ),
  'utf8'
)

// 假 provider：让 inspect 能建会话（不发请求）。
writeFileSync(
  join(userData, 'settings.json'),
  JSON.stringify(
    {
      app: {
        theme: 'dark',
        locale: 'zh-CN',
        permissionMode: 'ask',
        maxSteps: 40,
        defaultProviderId: 'packaged-provider',
        defaultModelId: 'fake-model'
      },
      providers: [
        {
          id: 'packaged-provider',
          label: 'Packaged Fake',
          apiStyle: 'openai-completions',
          baseUrl: 'http://127.0.0.1:9/v1',
          models: [{ id: 'fake-model' }],
          enabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ]
    },
    null,
    2
  ),
  'utf8'
)

// 预置一个已安装的插件：验证打包后的 sidecar 能找到并拉起插件运行器。
const FIXTURE_PLUGIN_ID = 'ipi.fixture-plugin'
cpSync(join(repoRoot, 'tools', 'fixture-plugin'), join(userData, 'plugins', FIXTURE_PLUGIN_ID), {
  recursive: true
})

const exePath = directExe ?? join(unpackedDir, 'i-pi-desk.exe')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

/**
 * 开跑前确认调试端口是空的。
 *
 * 少了这一步，一次「上一次没杀干净」会变成一次**神秘的挂起**：
 * 脚本连上的是上一个残留实例（它的 userData 可能已被删），
 * 于是断言在等一个永远不会来的响应。端口检查把这种问题变成一条清晰的错误。
 */
async function assertPortFree() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
    if (response.ok) {
      throw new Error(
        `端口 ${PORT} 上已有调试目标在响应 —— 很可能是上一次运行残留的应用实例。` +
          '请先结束 i-pi-desk 进程再重跑。'
      )
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('已有调试目标')) throw error
    // 连不上 = 端口是空的 = 正常
  }
}

await assertPortFree()

const child = spawn(exePath, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`], {
  cwd: directExe ? dirname(directExe) : unpackedDir,
  env,
  stdio: ['ignore', 'pipe', 'pipe']
})
let childErr = ''
child.stderr.on('data', (c) => {
  childErr += c.toString('utf8')
})

/**
 * 杀掉整棵进程树。
 *
 * `child.kill()` 在 Windows 上只终止直接子进程 —— 对打包产物来说那只是**启动器**，
 * 真正跑着的是它拉起的 Electron 进程树。只杀启动器的后果是：
 * 应用继续运行、继续占着调试端口、继续占着 userData 里的文件句柄，
 * 下一次运行就会连到一个「上一个实例」（而且它的数据目录已经被删了）。
 */
function killTree(process_) {
  if (process_.pid === undefined) return
  try {
    if (process.platform === 'win32') {
      // /T = 整棵树，/F = 强制。build 产物是独立进程树，PowerShell 的 Stop-Process 抓不全。
      spawnSync('taskkill', ['/PID', String(process_.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      process_.kill('SIGKILL')
    }
  } catch {
    try {
      process_.kill()
    } catch {
      // 已经退出了
    }
  }
}

async function waitForTarget(timeoutMs = 30_000) {  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await response.json()
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`等待打包应用启动超时。stderr:\n${childErr.slice(-2000)}`)
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    let nextId = 0
    const pending = new Map()
    const consoleErrors = []
    socket.on('open', () =>
      resolve({
        send(method, params) {
          const id = ++nextId
          socket.send(JSON.stringify({ id, method, params }))
          return new Promise((res, rej) => pending.set(id, { res, rej }))
        },
        consoleErrors,
        close: () => socket.close()
      })
    )
    socket.on('error', reject)
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString())
      if (message.id && pending.has(message.id)) {
        const { res, rej } = pending.get(message.id)
        pending.delete(message.id)
        if (message.error) rej(new Error(JSON.stringify(message.error)))
        else res(message.result)
        return
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
        consoleErrors.push((message.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '))
      }
    })
  })
}

try {
  const target = await waitForTarget()
  const client = await connect(target.webSocketDebuggerUrl)
  await client.send('Runtime.enable', {})
  await new Promise((r) => setTimeout(r, 3000))

  const evaluate = async (expression) => {
    const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate 失败')
    return result.result.value
  }

  console.log('\n── 打包后的运行时 ──')

  check('preload 注入正常（生产档 CSP 没把脚本拦掉）', await evaluate('typeof window.desk === "object"'))

  const bodyText = await evaluate('document.body.innerText')
  check('渲染层真的渲染出了内容（不是白屏）', typeof bodyText === 'string' && bodyText.length > 10, JSON.stringify(String(bodyText).slice(0, 120)))
  check('React 已挂载', (await evaluate('document.getElementById("root").childElementCount')) > 0)

  const info = await evaluate('window.desk.app.info().then(r => r.ok ? r.data : r.error)')
  check('appInfo 可用', info?.name === 'i-pi-desk', JSON.stringify(info))

  // sidecar：打包后入口路径变了（resourcesPath/agent-host），这是最容易出错的一环。
  // 用**主动查询**而不是等推送 —— 推送只覆盖状态变化，脚本连上来时
  // sidecar 早就就绪了，那一次事件已经过去了。
  const status = await evaluate('window.desk.agent.status().then(r => r.ok ? r.data : r.error)')
  check('sidecar 已就绪（打包后仍能找到内核入口）', status?.state === 'ready', JSON.stringify(status))

  // 原生模块：只在打包后才会暴露 asar 解包问题。
  const probe = await evaluate('window.desk.terminal.probe().then(r => r.ok ? r.data : r.error)')
  check('终端可用（node-pty 从 asar.unpacked 加载成功）', probe?.available === true, JSON.stringify(probe))

  if (probe?.available) {
    await evaluate('window.__data = []; window.desk.events.onTerminalData((p) => window.__data.push(p)); true')
    const term = await evaluate(
      `window.desk.terminal.create({ cols: 80, rows: 24, cwd: ${JSON.stringify(workspaceRoot)} }).then(r => r.ok ? r.data : r.error)`
    )
    const marker = `PKG_${Date.now()}`
    await evaluate(`window.desk.terminal.write(${JSON.stringify(term?.id)}, "echo ${marker}\\r").then(r => r.ok)`)
    const echoed = await evaluate(`
      new Promise((resolve) => {
        const started = Date.now()
        const tick = () => {
          const joined = (window.__data || []).map((p) => p.data).join('')
          if (joined.includes(${JSON.stringify(marker)})) return resolve('FOUND')
          if (Date.now() - started > 15000) return resolve('TIMEOUT:' + joined.slice(-150))
          setTimeout(tick, 200)
        }
        tick()
      })
    `)
    check('打包后 PTY 仍能起 shell 并回显', echoed === 'FOUND', String(echoed))
    await evaluate(`window.desk.terminal.dispose(${JSON.stringify(term?.id)}).then(r => r.ok)`)
  }

  // 插件运行器：sidecar 与它必须同目录，bundle 漏拷就全废。
  const pluginList = await evaluate('window.desk.plugins.list().then(r => r.ok ? r.data : r.error)')
  check(
    '打包后能看到预置插件',
    Array.isArray(pluginList) && pluginList.some((p) => p.id === FIXTURE_PLUGIN_ID),
    JSON.stringify(pluginList)
  )

  await evaluate(`window.desk.plugins.setEnabled(${JSON.stringify(FIXTURE_PLUGIN_ID)}, true).then(r => r.ok)`)
  const sessionId = await evaluate(
    `window.desk.session.create({ workspaceId: ${JSON.stringify(workspaceId)} }).then(r => r.ok ? r.data.id : r.error)`
  )
  const inspect = await evaluate(
    `window.desk.agent.inspect(${JSON.stringify(sessionId)}).then(r => r.ok ? r.data : r.error)`
  )
  const pluginRuntime = (inspect?.plugins ?? []).find((p) => p.id === FIXTURE_PLUGIN_ID)
  check('打包后插件能被激活（运行器已随包分发）', pluginRuntime?.state === 'active', JSON.stringify(inspect?.plugins))
  check(
    '打包后插件工具仍注册给了内核',
    Array.isArray(inspect?.activeTools) && inspect.activeTools.includes('fixture_echo'),
    JSON.stringify(inspect?.activeTools)
  )

  // 文件读写也要过一遍：打包后工作区路径解析与权限校验走的是同一套代码，
  // 但 cwd / resourcesPath 的差异有可能影响它。
  const preview = await evaluate(
    `window.desk.fs.read(${JSON.stringify(workspaceId)}, 'src/hello.ts').then(r => r.ok ? r.data : r.error)`
  )
  check('打包后能读工作区文件', typeof preview?.text === 'string' && preview.text.includes('packaged'), JSON.stringify(preview?.text))

  const escaped = await evaluate(
    `window.desk.fs.read(${JSON.stringify(workspaceId)}, '../../etc/passwd').then(r => r.ok ? 'ALLOWED' : r.error.code)`
  )
  check('打包后越界读取仍被拒', escaped === 'FORBIDDEN', String(escaped))

  /**
   * 代码编辑器在生产档 CSP 下能否工作。
   *
   * CodeMirror 会往页面里注入动态样式（StyleModule），而生产档 CSP 比开发档严 ——
   * 这是「开发能用、打包后没样式/没高亮」这一类问题的典型来源。
   * 所以不能只断言「页面渲染出来了」，要真的把编辑器打开看它挂没挂上。
   */
  const editorOpened = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const toggle = document.querySelector('button[title^="工作区文件"]')
      if (!toggle) return 'no-panel-toggle'
      toggle.click()
      await wait(700)
      const clickByText = async (text) => {
        for (let i = 0; i < 25; i += 1) {
          const button = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === text)
          if (button) { button.click(); return true }
          await wait(200)
        }
        return false
      }
      if (!(await clickByText('src'))) return 'no-src-dir'
      await wait(400)
      if (!(await clickByText('hello.ts'))) return 'no-file-row'
      /*
        等编辑器挂上要**轮询**，不能只等一次。

        编辑器是按需加载的：chunk 有 762 KB，从 asar 里冷加载 + CodeMirror 初始化
        合起来经常超过 1 秒。原来这里是「等 900ms → 查一次」，机器一忙就以 no-editor 失败 ——
        现象看起来像「打包后编辑器坏了」，其实只是没等够（我用一个独立探针跑同一个
        win-unpacked 产物，等 9 秒，一次就过、而且没有任何 console 报错）。
        现在改成有上限的轮询（最多 10 秒）：仍然**要求它真的挂上**，只是给它足够的时间。
      */
      let editorReady = false
      for (let i = 0; i < 40; i += 1) {
        if (document.querySelector('.cm-editor')) {
          editorReady = true
          break
        }
        await wait(250)
      }
      if (!editorReady) return 'no-editor'
      const content = document.querySelector('.cm-content')
      const token = document.querySelector('.cm-content .cm-line span')
      return {
        highlighted: document.querySelectorAll('.cm-content .cm-line span').length,
        hasGutter: Boolean(document.querySelector('.cm-gutters')),
        gutterWidth: document.querySelector('.cm-gutters')
          ? Math.round(document.querySelector('.cm-gutters').getBoundingClientRect().width)
          : 0,
        // 高亮色与正文色。两者必须不同 —— 相同就说明高亮样式没生效，
        // 或者 CSS 变量没解析出来（那样取到的是继承值）。
        tokenColor: token ? getComputedStyle(token).color : null,
        contentColor: content ? getComputedStyle(content).color : null
      }
    })()
  `)
  check('打包后能打开代码编辑器', typeof editorOpened === 'object' && editorOpened !== null, JSON.stringify(editorOpened))
  check(
    '打包后语法高亮生效（生产档 CSP 没有拦掉 CodeMirror 注入的样式）',
    typeof editorOpened?.highlighted === 'number' && editorOpened.highlighted > 0,
    JSON.stringify(editorOpened)
  )
  check('打包后行号槽有实际宽度（布局与样式都生效了）', editorOpened?.gutterWidth > 0, JSON.stringify(editorOpened?.gutterWidth))
  check(
    '打包后高亮颜色来自主题变量（不是继承正文色）',
    Boolean(editorOpened?.tokenColor) && editorOpened.tokenColor !== editorOpened.contentColor,
    `token=${editorOpened?.tokenColor} content=${editorOpened?.contentColor}`
  )

  console.log('\n── 渲染层错误 ──')
  check('无 console.error', client.consoleErrors.length === 0, client.consoleErrors.join('\n        '))

  if (failures > 0) {
    const logPath = join(userData, 'logs', 'main.log')
    if (existsSync(logPath)) {
      const { readFileSync } = await import('node:fs')
      console.log('\n── 主进程日志（尾部） ──')
      for (const line of readFileSync(logPath, 'utf8').split('\n').slice(-15)) console.log(`  ${line}`)
    }
  }

  client.close()
} catch (error) {
  failures += 1
  console.log(`  FAIL  自测自身出错: ${String(error)}`)
  if (childErr) console.log(`  --- 应用 stderr ---\n${childErr.slice(-2000)}`)
} finally {
  killTree(child)
  await new Promise((r) => setTimeout(r, 1500))
  // 清理失败不该让自测变红：退出中的进程可能还占着 userData 里的文件句柄
  // （便携版还多一层自解压目录）。重试几次，仍失败就留个提示。
  try {
    rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    rmSync(workspaceRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  } catch (error) {
    console.log(`  NOTE  临时目录未清理干净（不影响结论）：${String(error)}`)
  }
}

console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
