/**
 * 渲染层端到端自测（CDP）。
 *
 * 为什么需要它：`typecheck` 与 `build` 只能证明代码「编译得过」，
 * 证明不了「窗口里真的渲染出了东西、没抛异常」。而渲染层恰恰是最容易
 * 「编译没问题、一跑就白屏」的地方（preload 没注入、CSP 拦了脚本、
 * store 初始化抛错……）。这类问题在没有自动化时只能靠人肉点开看。
 *
 * 做法：用 `--remote-debugging-port` 起打包产物，通过 CDP 连上渲染层，
 * 收集 console 错误与未捕获异常，并在页面里真实调用 IPC。
 *
 * 用法：node scripts/verify-renderer.mjs
 */

import { spawn, spawnSync, execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import net from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')
const repoRoot = join(appRoot, '..', '..')

const PORT = 9333
let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

// ── 准备一个隔离的运行环境：临时 userData + 预置的工作区与设置 ──
const userData = mkdtempSync(join(tmpdir(), 'ipi-e2e-'))
const workspaceRoot = mkdtempSync(join(tmpdir(), 'ipi-e2e-ws-'))
/** 末尾「切工作区」那一段用的第二个工作区（在 try 里赋值，finally 里清理）。 */
let secondWorkspaceDir = ''
mkdirSync(join(workspaceRoot, 'src'), { recursive: true })
writeFileSync(join(workspaceRoot, 'src', 'hello.ts'), 'export const hello = "world"\n', 'utf8')
writeFileSync(join(workspaceRoot, 'README.md'), '# fixture\n', 'utf8')
// 二进制夹具：用于验证「二进制不可编辑」（保存会损坏字节序列）。
writeFileSync(join(workspaceRoot, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]))

const workspaceId = 'e2e-workspace'
writeFileSync(
  join(userData, 'workspaces.json'),
  JSON.stringify(
    [
      {
        id: workspaceId,
        name: 'e2e-fixture',
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

/**
 * 预置一个假 provider。
 *
 * baseUrl 指向一个必然连不上的端口，这是**刻意的**：inspect 只建立会话、
 * 读系统提示与技能清单，不发任何请求。如果它意外联网，这个测试会失败而不是
 * 悄悄变成「需要真实模型才能跑」。apiStyle 用 openai-completions 走最短路径。
 */
writeFileSync(
  join(userData, 'settings.json'),
  JSON.stringify(
    {
      app: {
        theme: 'dark',
        locale: 'zh-CN',
        permissionMode: 'ask',
        maxSteps: 40,
        defaultProviderId: 'e2e-provider',
        defaultModelId: 'fake-model'
      },
      providers: [
        {
          id: 'e2e-provider',
          label: 'E2E Fake Provider',
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

/**
 * 预置一个技能。这是本轮验证的核心：
 * 它必须被内核真正加载，并出现在 agent 收到的系统提示里。
 */
const SKILL_NAME = 'team-conventions'
const SKILL_MARKER = '所有提交信息必须用中文'
const skillDir = join(userData, 'pi-agent', 'skills', SKILL_NAME)
mkdirSync(skillDir, { recursive: true })
writeFileSync(
  join(skillDir, 'SKILL.md'),
  `---
name: ${SKILL_NAME}
description: 本仓库的提交与代码风格约定。写代码或提交前使用。
---

# 团队规范

- ${SKILL_MARKER}
`,
  'utf8'
)

const electronBin = join(appRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
const electronBinPosix = join(appRoot, 'node_modules', 'electron', 'dist', 'electron')
const binary = process.platform === 'win32' ? electronBin : electronBinPosix

/**
 * 启动 mock 控制面。
 *
 * `--models-base-url` 指向它自己：这样控制面下发的模型端点会打回 mock 的假端点，
 * 于是「prompt → run 失败 → 审计上报」这条链路能在不接真模型的前提下跑完。
 */
const CP_PORT = 8124

/**
 * 起假模型之前先确认端口是空的。
 *
 * ⚠️ 这条守卫是被一次**很难查**的失败逼出来的：上一次运行留下的 mock 进程还在
 * 监听 8124，新起的那个绑定失败**安静地退出**了，于是整套自测一路在跟**旧进程**说话。
 * 现象是「新加的行为完全没生效」（例如 @loop4 不循环）、而日志里看不出任何异常 ——
 * 排查时先后怀疑了假模型代码、界面、设置同步，都不是。
 *
 * 所以这里宁可**直接失败并说清原因**，也不要带着一个来路不明的 mock 继续跑。
 */
{
  /**
   * 用**连接**探测而不是 bind：刚被杀掉的进程会让端口停在 TIME_WAIT，
   * 那时 bind 会报 EADDRINUSE，但并没有人在监听 —— 守卫会误报，
   * 整套自测在开跑前就退出（0 PASS 0 FAIL）。TIME_WAIT 不会接受连接，
   * 所以「连得上」才是「真的有人占着」。
   */
  const occupied = await new Promise((resolve) => {
    const probe = net.connect({ port: CP_PORT, host: '127.0.0.1' })
    probe.setTimeout(800)
    probe.once('connect', () => {
      probe.destroy()
      resolve(true)
    })
    probe.once('timeout', () => {
      probe.destroy()
      resolve(false)
    })
    probe.once('error', () => resolve(false))
  })
  if (occupied) {
    console.log(`\n  FAIL  自测自身出错: 端口 ${CP_PORT} 已被占用（多半是上一次运行留下的假模型进程）`)
    console.log('        请先结束占用该端口的进程再跑：' + `Get-NetTCPConnection -LocalPort ${CP_PORT} -State Listen`)
    process.exit(1)
  }
}

const mockControlPlane = spawn(
  process.execPath,
  [
    join(repoRoot, 'tools', 'mock-control-plane', 'server.mjs'),
    '--port',
    String(CP_PORT),
    '--models-base-url',
    `http://127.0.0.1:${CP_PORT}/v1`
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] }
)
let mockLog = ''
mockControlPlane.stdout.on('data', (c) => {
  mockLog += c.toString()
})
mockControlPlane.stderr.on('data', (c) => {
  mockLog += c.toString()
})

/**
 * 预置一个已安装的插件。
 *
 * 为什么不走 `plugins.install()`：它要弹**目录选择对话框**，无法自动化 ——
 * 而那个设计是刻意的（不让渲染层传任意路径进来，路径必须由用户在主进程的对话框里亲手选）。
 * 所以这里直接模拟「已经装好」的状态，把可自动化的部分（列表 / 启用 / 加载）留给断言。
 */
const FIXTURE_PLUGIN_ID = 'ipi.fixture-plugin'
cpSync(join(repoRoot, 'tools', 'fixture-plugin'), join(userData, 'plugins', FIXTURE_PLUGIN_ID), {
  recursive: true
})

async function waitForMockControlPlane(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${CP_PORT}/__health`)
      if (response.ok) return
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`mock 控制面启动超时：${mockLog}`)
}

const env = { ...process.env }
// DSH 自身会注入这个变量；不清掉的话 electron 会以纯 Node 模式启动，根本不开窗口。
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(binary, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`], {
  cwd: appRoot,
  env,
  stdio: ['ignore', 'pipe', 'pipe']
})

/**
 * 「重启应用」阶段额外拉起的进程，交给 finally 一起收掉。
 *
 * 单独放一个数组而不是复用 `child`：重启阶段的进程生命周期与主流程不同，
 * 混在一起很容易在某个分支上漏杀，留下一个占着调试端口的残留实例 ——
 * 那会让下一次运行连到「上一个自己」，现象是莫名其妙的挂起。
 */
const extraChildren = []

function spawnApp() {
  const proc = spawn(binary, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`], {
    cwd: appRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  proc.stderr.on('data', (c) => {
    childErr += c.toString('utf8')
  })
  extraChildren.push(proc)
  return proc
}

/** 杀掉整棵进程树（打包/未打包的 Electron 都会拉起子进程）。 */
function killTree(proc) {
  if (!proc?.pid) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      proc.kill('SIGKILL')
    }
  } catch {
    try {
      proc.kill()
    } catch {
      // 已经退出了
    }
  }
}

/**
 * 等应用退出并且**调试端口真的释放**。
 *
 * 只等进程退出是不够的：端口释放有延迟，抢跑会连到旧实例。
 */
async function waitForPortFree(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      if (!response.ok) return true
    } catch {
      return true
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

let childErr = ''
child.stderr.on('data', (c) => {
  childErr += c.toString('utf8')
})

async function waitForTarget(timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await response.json()
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      // 端口还没起来，继续等。
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('等待渲染层调试目标超时')
}

const consoleErrors = []
const exceptions = []
/**
 * 渲染层真正请求过的资源 URL。
 *
 * 用 CDP 的 Network 域而不是 `performance.getEntriesByType('resource')`：
 * 产物是 `file://` 加载的，resource timing 在这种情况下拿不到条目（实测为 0），
 * 协议级事件不受这个限制。
 */
const networkRequests = []

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    let nextId = 0
    const pending = new Map()

    socket.on('open', () =>
      resolve({
        send(method, params) {
          const id = ++nextId
          socket.send(JSON.stringify({ id, method, params }))
          return new Promise((res, rej) => pending.set(id, { res, rej }))
        },
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
      if (message.method === 'Runtime.exceptionThrown') {
        exceptions.push(message.params?.exceptionDetails?.exception?.description ?? 'unknown exception')
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
        consoleErrors.push(
          (message.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')
        )
      }
      if (message.method === 'Network.requestWillBeSent') {
        networkRequests.push(message.params?.request?.url ?? '')
      }
    })
  })
}

try {
  await waitForMockControlPlane()
  const target = await waitForTarget()
  const client = await connect(target.webSocketDebuggerUrl)

  await client.send('Runtime.enable', {})
  // 从最开头就收集网络请求：编辑器的按需 chunk 是在「点开文件」时才请求的，
  // 要证明这一点，必须在那之前就开始记录。
  await client.send('Network.enable', {})
  // 等 React 挂载 + store 初始化（它要发几个 IPC）走完。
  await new Promise((r) => setTimeout(r, 2500))

  const evaluate = async (expression) => {
    const result = await client.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate 失败')
    }
    return result.result.value
  }

  console.log('── 断言 ──')

  check('preload 注入了 window.desk', await evaluate('typeof window.desk === "object"'))
  check(
    '渲染层暴露了 fs 域',
    await evaluate('typeof window.desk.fs.list === "function" && typeof window.desk.fs.read === "function"')
  )

  const info = await evaluate('window.desk.app.info().then(r => r.ok ? r.data : r.error)')
  check('appInfo 能通过 IPC 取到', info?.name === 'i-pi-desk', JSON.stringify(info))

  const listed = await evaluate(
    `window.desk.fs.list(${JSON.stringify(workspaceId)}, '').then(r => r.ok ? r.data.map(e => e.kind + ':' + e.name) : r.error)`
  )
  check('文件树 IPC 返回真实目录内容', Array.isArray(listed) && listed.includes('directory:src'), JSON.stringify(listed))

  const read = await evaluate(
    `window.desk.fs.read(${JSON.stringify(workspaceId)}, 'src/hello.ts').then(r => r.ok ? r.data.text : r.error)`
  )
  check('文件预览 IPC 返回文件内容', typeof read === 'string' && read.includes('hello'), String(read))

  const escaped = await evaluate(
    `window.desk.fs.read(${JSON.stringify(workspaceId)}, '../../etc/passwd').then(r => r.ok ? 'ALLOWED' : r.error.code)`
  )
  check('越界读取被拒绝（端到端）', escaped === 'FORBIDDEN', String(escaped))

  // ───────────────────────── 编辑器（写入） ─────────────────────────

  console.log('\n── 编辑器（写入） ──')

  const EDIT_TARGET = 'src/hello.ts'
  const editBefore = await evaluate(
    `window.desk.fs.read(${JSON.stringify(workspaceId)}, ${JSON.stringify(EDIT_TARGET)}).then(r => r.ok ? r.data : r.error)`
  )
  check('可编辑文件带 revision', typeof editBefore?.revision === 'string', JSON.stringify(editBefore))
  check('可编辑文件无 readOnlyReason', editBefore?.readOnlyReason === undefined, String(editBefore?.readOnlyReason))

  const NEW_TEXT = 'export const hello = "edited by e2e"\n'
  const writeResult = await evaluate(
    `window.desk.fs.write({ workspaceId: ${JSON.stringify(workspaceId)}, path: ${JSON.stringify(EDIT_TARGET)},
        text: ${JSON.stringify(NEW_TEXT)}, expectedRevision: ${JSON.stringify(editBefore?.revision)} })
       .then(r => r.ok ? r.data : r.error)`
  )
  check('写入返回新 revision', typeof writeResult?.revision === 'string', JSON.stringify(writeResult))
  // 从测试进程直接读磁盘 —— 这一步才真正证明「文件被改了」，而不是「IPC 返回成功」。
  check(
    '磁盘上的文件内容真的变了',
    readFileSync(join(workspaceRoot, 'src', 'hello.ts'), 'utf8') === NEW_TEXT,
    JSON.stringify(readFileSync(join(workspaceRoot, 'src', 'hello.ts'), 'utf8'))
  )

  const staleWrite = await evaluate(
    `window.desk.fs.write({ workspaceId: ${JSON.stringify(workspaceId)}, path: ${JSON.stringify(EDIT_TARGET)},
        text: 'stale', expectedRevision: ${JSON.stringify(editBefore?.revision)} })
       .then(r => r.ok ? 'ALLOWED' : r.error.code)`
  )
  check('用过期 revision 保存被拒（防止覆盖 agent 的改动）', staleWrite === 'STALE_WRITE', String(staleWrite))
  check(
    '被拒后磁盘内容保持第一次写入的结果',
    readFileSync(join(workspaceRoot, 'src', 'hello.ts'), 'utf8') === NEW_TEXT
  )

  const missingRevision = await evaluate(
    `window.desk.fs.write({ workspaceId: ${JSON.stringify(workspaceId)}, path: ${JSON.stringify(EDIT_TARGET)}, text: 'x' })
       .then(r => r.ok ? 'ALLOWED' : r.error.code)`
  )
  check('漏传 expectedRevision 被拒（不能退化成无保护覆盖）', missingRevision === 'BAD_REQUEST', String(missingRevision))

  const createNew = await evaluate(
    `window.desk.fs.write({ workspaceId: ${JSON.stringify(workspaceId)}, path: 'src/created.ts',
        text: 'export const created = 1\\n', expectedRevision: null })
       .then(r => r.ok ? r.data.path : r.error.code)`
  )
  check('能以「新建」语义创建文件', createNew === 'src/created.ts', String(createNew))
  check('新建的文件落到了磁盘上', existsSync(join(workspaceRoot, 'src', 'created.ts')))

  const binaryPreview = await evaluate(
    `window.desk.fs.read(${JSON.stringify(workspaceId)}, 'binary.bin').then(r => r.ok ? r.data : r.error)`
  )
  check('二进制文件是只读的', typeof binaryPreview?.readOnlyReason === 'string', JSON.stringify(binaryPreview?.readOnlyReason))

  // UI 真的渲染了：空状态应当出现标题与两个入口按钮。
  const bodyText = await evaluate('document.body.innerText')
  check('界面渲染出了内容', typeof bodyText === 'string' && bodyText.length > 10, JSON.stringify(String(bodyText).slice(0, 120)))
  check('显示应用名', String(bodyText).includes('i-pi-desk'), String(bodyText).slice(0, 200))
  check('展示了当前工作区路径', String(bodyText).includes('e2e-fixture') || String(bodyText).includes(workspaceRoot), String(bodyText).slice(0, 300))

  /**
   * 起手任务必须是**这个目录的**起手任务（设计稿 §8-B2-9 与「按工作区生成」那一项）。
   *
   * 夹具里只有 src/hello.ts 与 README.md（没有 package.json），所以确定的预期是：
   * 提到 src/、提到「1 个源文件」、提到 README，而**不再**出现写死的那句
   * 「先带我过一遍这个项目的结构」。最后一条正是这个改动要修掉的东西 ——
   * 因此它同时也是这条断言的反面守卫。
   *
   * 事实是异步取回来的（一次 IPC），所以这里轮询等它出现。
   */
  let starters = { cards: [], title: '', generic: false }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    starters = await evaluate(`(() => {
      const cards = [...document.querySelectorAll('[data-testid="starter"]')].map((el) => el.innerText.replace(/\\s+/g, ' ').trim())
      const heading = document.querySelector('h1')
      return {
        cards,
        title: heading ? heading.innerText.replace(/\\s+/g, ' ').trim() : '',
        generic: document.body.innerText.includes('这个项目的结构')
      }
    })()`)
    if (Array.isArray(starters?.cards) && starters.cards.length > 0) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  check(
    '空状态用工作区名打招呼（而不是通用标题）',
    /今天想在 .+ 里做点什么/.test(String(starters?.title)) && String(starters?.title).includes('e2e-fixture'),
    JSON.stringify(starters?.title)
  )
  check(
    '起手任务是按这个目录生成的（提到了真实的 src/）',
    (starters?.cards ?? []).some((card) => card.includes('src/')),
    JSON.stringify(starters?.cards)
  )
  check(
    '起手任务带「为什么给你这条」的真实数字',
    (starters?.cards ?? []).some((card) => card.includes('1 个源文件')),
    JSON.stringify(starters?.cards)
  )
  check(
    '起手任务看得到 README',
    (starters?.cards ?? []).some((card) => card.includes('README')),
    JSON.stringify(starters?.cards)
  )
  check(
    '不再出现写死的通用建议（这个改动要修掉的正是它）',
    starters?.generic === false,
    JSON.stringify(starters?.cards)
  )

  const rootChildCount = await evaluate('document.getElementById("root").childElementCount')
  check('React 已挂载到 #root', rootChildCount > 0, `childElementCount=${rootChildCount}`)

  // ───────────────────────── 代码编辑器（CodeMirror） ─────────────────────────

  console.log('\n── 代码编辑器（CodeMirror） ──')

  /**
   * 走真实交互路径：点开文件树里的文件 → 编辑器挂载 → 敲键盘 → Ctrl+S → 落盘。
   *
   * 上面那段「编辑器（写入）」验的是 IPC 契约（带 revision 的保存、过期拒绝）；
   * 这一段验的是**界面真的把这套能力接上了**。两者缺一不可 ——
   * 接口全对但界面没接，用户依然用不了。
   */
  const opened = await evaluate(`
    (async () => {
      const texts = () => [...document.querySelectorAll('button')].map((b) => b.textContent.trim())
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      /** 等某个按钮出现再点：文件树是异步加载的，点太快会扑空。 */
      const clickByText = async (text, timeoutMs = 6000) => {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          const button = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === text)
          if (button) {
            button.click()
            return true
          }
          await wait(200)
        }
        return false
      }

      // 文件面板默认收起（它按需使用，不该一直占着聊天区宽度），所以要先展开。
      const toggle = document.querySelector('button[title^="工作区文件"]')
      if (!toggle) return 'no-panel-toggle: ' + JSON.stringify(texts())
      toggle.click()
      await wait(600)
      if (!document.querySelector('button[title^="工作区文件"]')) return 'panel-toggle-lost'

      if (!(await clickByText('src'))) {
        return 'no-src-dir: ' + JSON.stringify(texts())
      }
      await wait(500)
      if (!(await clickByText('hello.ts'))) return 'no-file-row: ' + JSON.stringify(texts())

      /**
       * 轮询等编辑器挂载，而不是固定等 900ms。
       *
       * 编辑器内核现在**按需加载**：点开文件会去取那个 chunk，耗时取决于磁盘与负载。
       * 固定等待在快机器上够用，在慢机器/刚做完构建时会变成一条随机失败 ——
       * 而它想验的其实只是「编辑器最终会出来」。
       */
      const deadline = Date.now() + 8000
      while (Date.now() < deadline) {
        if (document.querySelector('.cm-editor')) return 'ok'
        await wait(200)
      }
      return 'no-editor: ' + JSON.stringify(texts())
    })()
  `)
  check('点击文件树能在 CodeMirror 中打开文件', opened === 'ok', String(opened))

  /**
   * 运行时证据：编辑器内核**确实是按需取的**，而不是打包时说说而已。
   *
   * 这条和 `verify:bundle` 里那条是两种不同的证据：那边证明产物里有独立的 chunk，
   * 这边证明它真的在「打开文件」这一刻才被请求。少了任何一边，
   * 都可能出现「拆了但没人用」或「用了但其实在主 chunk 里」。
   */
  const editorChunkLoaded = {
    matched: networkRequests.filter((url) => /CodeEditor-/.test(url)).length,
    scriptCount: networkRequests.length,
    sample: networkRequests.slice(-4).map((url) => url.split('/').pop())
  }
  if (editorChunkLoaded.scriptCount === 0) {
    console.log(`  SKIP  运行时资源清单（本次没抓到 Network 事件）`)
  } else {
    check(
      '打开文件时才去取编辑器 chunk（运行时证据）',
      editorChunkLoaded.matched >= 1,
      JSON.stringify(editorChunkLoaded)
    )
  }

  const editorState = await evaluate(`
    (() => {
      const content = document.querySelector('.cm-content')
      return {
        text: content ? content.innerText : null,
        highlighted: document.querySelectorAll('.cm-content .cm-line span').length,
        hasGutter: Boolean(document.querySelector('.cm-gutters')),
        editable: content ? content.getAttribute('contenteditable') : null
      }
    })()
  `)
  check(
    '编辑器里显示的是文件内容',
    String(editorState?.text ?? '').includes('edited by e2e'),
    JSON.stringify(editorState?.text)
  )
  check('有行号槽', editorState?.hasGutter === true, JSON.stringify(editorState))
  check(
    '语法高亮生效（关键字/字符串被包进了带样式的 span）',
    typeof editorState?.highlighted === 'number' && editorState.highlighted > 0,
    JSON.stringify(editorState?.highlighted)
  )
  check('文本文件可编辑', editorState?.editable === 'true', JSON.stringify(editorState?.editable))

  // 真的敲键盘：聚焦编辑器后由 CDP 注入文本，走的是浏览器真实的输入事件链路。
  await evaluate(`document.querySelector('.cm-content').focus(); true`)
  await client.send('Input.insertText', { text: '// 由 e2e 输入\\n' })
  await new Promise((r) => setTimeout(r, 500))

  const afterTyping = await evaluate(`
    (() => ({
      dirtyBadge: document.body.innerText.includes('未保存'),
      text: document.querySelector('.cm-content') ? document.querySelector('.cm-content').innerText : ''
    }))()
  `)
  check('输入后出现「未保存」标记', afterTyping?.dirtyBadge === true, JSON.stringify(afterTyping?.dirtyBadge))
  check('输入的内容出现在编辑器里', String(afterTyping?.text ?? '').includes('由 e2e 输入'), JSON.stringify(afterTyping?.text))

  /**
   * Ctrl+S 走**真实按键**。
   *
   * 这一条同时在守一个设计决定：快捷键只由对话框的 window 监听处理，
   * CodeEditor 刻意不绑定它。如果哪天有人给编辑器也加上 Mod-s，
   * 一次按键会触发两次保存 —— 第二次带着过期的 revision，必然失败并弹错。
   */
  await client.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    modifiers: 2,
    windowsVirtualKeyCode: 83,
    key: 's',
    code: 'KeyS'
  })
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    modifiers: 2,
    windowsVirtualKeyCode: 83,
    key: 's',
    code: 'KeyS'
  })
  await new Promise((r) => setTimeout(r, 1500))

  const savedOnDisk = readFileSync(join(workspaceRoot, 'src', 'hello.ts'), 'utf8')
  check('Ctrl+S 后磁盘上的文件真的多了那行内容', savedOnDisk.includes('由 e2e 输入'), JSON.stringify(savedOnDisk))
  const savedBadge = await evaluate(`document.body.innerText.includes('未保存')`)
  check('保存后「未保存」标记消失', savedBadge === false, String(savedBadge))

  console.log('\n── 代码编辑器 · 只读边界 ──')
  await evaluate(`
    (() => {
      const close = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '关闭')
      if (close) close.click()
      return true
    })()
  `)
  await new Promise((r) => setTimeout(r, 500))

  const binaryPrompt = await evaluate(`
    (async () => {
      const button = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'binary.bin')
      if (!button) return 'no-row'
      button.click()
      await new Promise((r) => setTimeout(r, 600))
      return {
        message: document.body.innerText.includes('二进制文件'),
        // 只读打开时不该出现「保存」按钮。
        hasSaveButton: [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '保存')
      }
    })()
  `)
  check('二进制文件明确提示不支持预览', binaryPrompt?.message === true, JSON.stringify(binaryPrompt))
  check('二进制文件不提供保存按钮', binaryPrompt?.hasSaveButton === false, JSON.stringify(binaryPrompt))
  await evaluate(`
    (() => {
      const close = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '关闭')
      if (close) close.click()
      return true
    })()
  `)

  // ───────────────────────── 迟到元素预留空间 ─────────────────────────

  console.log('\n── 迟到元素预留空间（流式时不该把已读内容挤动）──')

  /**
   * 设计稿 §3.3 那条「为迟到元素预留空间」。
   *
   * 「不跳」没法直接断言，所以断言它的三个**机械原因**：
   *  ① 滚动条槽位固定 —— 否则流式到某一行时整块内容横向缩一下；
   *  ② 关掉浏览器滚动锚定 —— 否则与「贴底才跟随」的策略互相打架；
   *  ③ 代码块/表格有最小高度 —— 否则「空 pre」到「两行的 pre」之间会把下面全挤动。
   *
   * ③ 的验法：往一个**带生产类名**的容器里塞一个空 pre/table，量它的高度。
   * - 不用「读 document.styleSheets」：包是 file:// 加载的，Chromium 把它的
   *   cssRules 当成跨源，读出来是空的（第一版就是这么红的 —— 断言观察错了地方）。
   * - 也不用「找现成的 markdown 消息」：那要求这一轮正好有 assistant 文本，
   *   假模型的回复里没有代码围栏，测量会时有时无。
   */
  const lateSpace = await evaluate(`(() => {
    const stream = document.querySelector('[data-testid="message-stream"]')
    if (!stream) return { stream: false }
    const style = getComputedStyle(stream)

    const host = document.createElement('div')
    host.className = '[&_pre]:min-h-[3.25rem] [&_table]:min-h-[2.5rem]'
    host.style.position = 'absolute'
    host.style.left = '-9999px'
    const pre = document.createElement('pre')
    const table = document.createElement('table')
    host.appendChild(pre)
    host.appendChild(table)
    document.body.appendChild(host)

    const preHeight = Math.round(pre.getBoundingClientRect().height)
    const tableHeight = Math.round(table.getBoundingClientRect().height)
    host.remove()

    return { stream: true, gutter: style.scrollbarGutter, anchor: style.overflowAnchor, preHeight, tableHeight }
  })()`)

  check('滚动条槽位固定（流式时不会横向缩一下）', lateSpace?.gutter === 'stable', JSON.stringify(lateSpace))
  check('关掉浏览器滚动锚定（与「贴底才跟随」的策略不打架）', lateSpace?.anchor === 'none', JSON.stringify(lateSpace))
  check(
    '空代码块就占住约两行的高度（迟到元素不会把下面挤动）',
    (lateSpace?.preHeight ?? 0) >= 40,
    JSON.stringify({ preHeight: lateSpace?.preHeight })
  )
  check(
    '空表格也占住高度（表头先到、行随后到）',
    (lateSpace?.tableHeight ?? 0) >= 30,
    JSON.stringify({ tableHeight: lateSpace?.tableHeight })
  )

  // ───────────────────────── 限额：正常轮次不该出现撞墙通知 ─────────────────────────

  /**
   * 限额的**正面**覆盖放在 host 层（packages/agent-host/scripts/verify-max-steps.mjs）：
   * 那边能程序化放行审批、能直接读到 stopReason，而这里不行 ——
   * 试过用界面驱动（maxSteps=1 + 自动模式），结果是那一轮**挂在审批上**：
   * 按设计，危险操作即使自动模式也会问，而 write 正是危险操作。
   * 失败现象是「通知没出现」，但真因在审批闸门 —— 又一个「失败信息指不到真因」的例子。
   *
   * 这里只守反面：一轮正常（上限没到）时**不该**出现撞墙通知。
   */
  const noLimitNotice = await evaluate(
    "Boolean(document.querySelector('[data-testid=\"max-steps-notice\"]'))"
  )
  check('上限没到时不会出现撞墙通知（不能常驻）', noLimitNotice === false, String(noLimitNotice))

  // ───────────────────────── 思考强度 ─────────────────────────

  console.log('\n── 思考强度（发送前可见、可改）──')

  /**
   * 这一项的可见部分：输入区有一个「思考 [中 ▾]」。
   *
   * 内核侧的完整行为（非法值被拒、合法值能跑完、中途换档会重建会话）由
   * packages/agent-host/scripts/verify-thinking-level.mjs 覆盖 ——
   * 那边能直接驱动 runtime，这里只验界面到设置这条线。
   */
  const thinkingInitial = await evaluate(`(() => {
    const select = document.querySelector('[data-testid="thinking-level"]')
    if (!select) return { found: false }
    const label = select.closest('label')
    return {
      found: true,
      value: select.value,
      options: [...select.options].map((option) => option.value),
      surrounding: label ? label.innerText.replace(/\\s+/g, ' ').trim() : '',
      title: label ? label.getAttribute('title') : null
    }
  })()`)
  check('输入区有思考强度控件', thinkingInitial?.found === true, JSON.stringify(thinkingInitial))
  check(
    '默认档位是 medium（与内核默认一致）',
    thinkingInitial?.value === 'medium',
    JSON.stringify({ value: thinkingInitial?.value })
  )
  check(
    '输入区只给常用档位（不把七个全摊出来）',
    Array.isArray(thinkingInitial?.options) && thinkingInitial.options.length === 4 && thinkingInitial.options.includes('medium'),
    JSON.stringify(thinkingInitial?.options)
  )
  check(
    '控件旁边写着「思考」两个字（不是光秃秃一个下拉）',
    String(thinkingInitial?.surrounding ?? '').includes('思考'),
    String(thinkingInitial?.surrounding)
  )
  check(
    '悬停提示说清了这一档是什么意思（档位名 + 说明）',
    // 实际形态是「思考强度：中 · 默认档位」—— 断言里要把分隔符与空格写对，
    // 第一版漏了空格，于是它红在**断言**上而不是产品上。
    /思考强度：.+ · .+/.test(String(thinkingInitial?.title ?? '')),
    String(thinkingInitial?.title)
  )

  // 改档位 → 设置里要落盘（不是只改了个 DOM）
  const changedToHigh = await evaluate(`(async () => {
    const select = document.querySelector('[data-testid="thinking-level"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
    setter.call(select, 'high')
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 600))
    const stored = await window.desk.settings.get()
    const select2 = document.querySelector('[data-testid="thinking-level"]')
    return {
      stored: stored.ok ? stored.data.thinkingLevel : String(stored.error),
      shown: select2 ? select2.value : null
    }
  })()`)
  check('改档位会落到设置里（不是只改了界面）', changedToHigh?.stored === 'high', JSON.stringify(changedToHigh))
  check('界面同步显示新档位', changedToHigh?.shown === 'high', JSON.stringify(changedToHigh))

  // 改回去：这一节不留副作用（后面的段落共用同一个应用实例）
  const restored = await evaluate(`(async () => {
    const select = document.querySelector('[data-testid="thinking-level"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
    setter.call(select, 'medium')
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 600))
    const stored = await window.desk.settings.get()
    return stored.ok ? stored.data.thinkingLevel : String(stored.error)
  })()`)
  check('改回 medium 也落盘（这一段不留副作用）', restored === 'medium', String(restored))

  // ───────────────────────── 快捷键与快速启动面板 ─────────────────────────

  console.log('\n── 快捷键与快速启动面板 ──')

  /**
   * 这一段全部用**真的按键**验证（Input.dispatchKeyEvent），不是直接调函数 ——
   * 「快捷键」这个功能的全部价值就在于按下去有没有反应，调函数等于没验。
   *
   * 面板的开合一律断言**状态翻转**而不是「现在是开的」：前面若干段可能已经把
   * 终端或文件面板留在某种状态里，断言绝对值会把别处的状态当成这里的失败。
   */
  const CTRL = process.platform === 'darwin' ? 4 : 2
  const pressCombo = async (key, code, keyCode, modifiers = 0) => {
    await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers })
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers })
    await new Promise((resolve) => setTimeout(resolve, 350))
  }
  const headerButtonState = async (labelPrefix) =>
    evaluate(`(() => {
      const button = [...document.querySelectorAll('header button')].find((el) => (el.getAttribute('title') || '').startsWith(${JSON.stringify(labelPrefix)}))
      if (!button) return null
      return { title: button.getAttribute('title'), active: button.getAttribute('data-active') === 'true' }
    })()`)

  /**
   * 让文件树里某个文件**真的可见**（按名字展开所在目录，而不是随便点一个）。
   *
   * 为什么需要它：文件面板一关就卸载，重开时展开状态回到根部 ——
   * 而这一节之后还有两段要靠「文件树里有 hello.ts 这一行」。
   * 与其让它们依赖「前面某段导航到过那里」（失败信息只会是 no-row，指不到原因），
   * 不如让它们自己把前提摆好。这里刻意按**目录名**点，避免点错到别的文件夹。
   */
  const revealTreeFile = async (fileName, folderName) => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const state = await evaluate(`(() => {
        const toggle = document.querySelector('button[title^="工作区文件"]')
        return toggle ? toggle.getAttribute('data-active') === 'true' : null
      })()`)
      if (state === true) break
      await evaluate("document.querySelector('button[title^=\"工作区文件\"]')?.click(); true")
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    // 等树加载出来（关掉重开会重新异步取目录）
    for (let attempt = 0; attempt < 12; attempt += 1) {
      // 树里的行就是按钮本身（目录行的 title 就是目录名），没有单独的「进入」按钮。
      const rows = await evaluate("[...document.querySelectorAll('button')].filter((b) => { const t = b.textContent.trim(); return t.length > 1 && t.length < 40 && !t.includes(' ') }).length")
      if ((rows ?? 0) > 0) break
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    if (folderName) {
      /**
       * 展开目录 = 点那一行本身。
       *
       * 现场证据（revealTreeFile 打印出来的 titles）显示：目录行的 title 就是目录名
       * （例如 "src"），并没有单独的「进入 src」按钮 —— 那是**旧界面**的写法。
       * 按文本匹配作为兜底，两种写法都能点中。
       */
      const expanded = await evaluate(`(() => {
        const target = [...document.querySelectorAll('button')].find((b) => {
          const title = b.getAttribute('title') || ''
          return title === ${JSON.stringify(folderName)} || b.textContent.trim() === ${JSON.stringify(folderName)}
        })
        if (target) target.click()
        return Boolean(target)
      })()`)
      await new Promise((resolve) => setTimeout(resolve, 800))
      if (!expanded) console.log('  NOTE  没能点到目录行：' + folderName)
    }
    const found = await evaluate(`Boolean([...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(fileName)}))`)
    if (found) return true
    // 失败时把现场带回去（失败信息必须能指出原因，否则等于没有信息）。
    const scene = await evaluate(`(() => {
      const toggle = document.querySelector('button[title^="工作区文件"]')
      const buttons = [...document.querySelectorAll('button')]
      return {
        toggle: toggle ? toggle.getAttribute('data-active') : 'no-toggle',
        titles: buttons.map((b) => b.getAttribute('title') || '').filter((t) => t.length > 0).slice(0, 25),
        texts: buttons.map((b) => b.textContent.trim()).filter((t) => t.length > 1 && t.length < 30).slice(0, 25)
      }
    })()`)
    console.log('  NOTE  revealTreeFile 现场：' + JSON.stringify(scene))
    return false
  }

  // ① 提示里要露出快捷键（否则用户永远不知道有这个键）
  const terminalTip = await headerButtonState('终端')
  const filesTip = await headerButtonState('工作区文件')
  check('终端按钮的提示里带上快捷键', /Ctrl/.test(String(terminalTip?.title)), JSON.stringify(terminalTip))
  check('文件面板按钮的提示里带上快捷键', /Ctrl/.test(String(filesTip?.title)), JSON.stringify(filesTip))

  // ② Ctrl+K 打开面板 —— 而且**焦点在输入框里也要生效**（命令面板的意义就在这里）
  await evaluate("document.querySelector('textarea')?.focus(); true")
  await pressCombo('k', 'KeyK', 75, CTRL)
  const launcherShown = await evaluate("Boolean(document.querySelector('[data-testid=\"launcher\"]'))")
  check('按 Ctrl+K 打开快速启动面板（焦点在输入框里也能唤起）', launcherShown === true)

  // ③ 输入即过滤
  const filtered = await evaluate(`(async () => {
    const input = document.querySelector('[data-testid="launcher-input"]')
    if (!input) return { items: [], error: '没有输入框' }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '终端')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 300))
    return { items: [...document.querySelectorAll('[cmdk-item]')].map((el) => el.innerText.trim()) }
  })()`)
  check(
    '输入会过滤列表（只留下终端那条）',
    (filtered?.items ?? []).length === 1 && String(filtered.items[0]).includes('终端'),
    JSON.stringify(filtered)
  )

  // ④ 回车执行：面板关闭，并且真的开合了终端
  const terminalBefore = (await headerButtonState('终端'))?.active
  await pressCombo('Enter', 'Enter', 13)
  const afterRun = await evaluate("Boolean(document.querySelector('[data-testid=\"launcher\"]'))")
  const terminalAfter = (await headerButtonState('终端'))?.active
  check('回车执行后面板关闭', afterRun === false)
  check('回车执行真的切换了终端面板', terminalAfter === !terminalBefore, JSON.stringify({ terminalBefore, terminalAfter }))

  // ⑤ 反引号那个键：Ctrl+` 开合终端。按两次，最后**恢复原状** ——
  // 这一段之后还有别的段落，不能给它们留下一个被改过的界面状态。
  const terminalBeforeHotkey = (await headerButtonState('终端'))?.active
  await pressCombo('`', 'Backquote', 192, CTRL)
  const terminalAfterHotkey = (await headerButtonState('终端'))?.active
  await pressCombo('`', 'Backquote', 192, CTRL)
  const terminalRestored = (await headerButtonState('终端'))?.active
  check(
    'Ctrl + ` 能开合终端（自定义键名也要真的生效）',
    terminalAfterHotkey === !terminalBeforeHotkey,
    JSON.stringify({ terminalBeforeHotkey, terminalAfterHotkey })
  )
  check('再按一次恢复终端状态（这一段不留副作用）', terminalRestored === terminalBeforeHotkey, JSON.stringify({ terminalRestored }))

  // ⑥ Ctrl+B 开合工作区文件面板，且**是开合**（连按两次回到原状）
  const filesBefore = (await headerButtonState('工作区文件'))?.active
  await pressCombo('b', 'KeyB', 66, CTRL)
  const filesAfterFirst = (await headerButtonState('工作区文件'))?.active
  await pressCombo('b', 'KeyB', 66, CTRL)
  const filesAfterSecond = (await headerButtonState('工作区文件'))?.active
  check('Ctrl+B 打开工作区文件面板', filesAfterFirst === !filesBefore, JSON.stringify({ filesBefore, filesAfterFirst }))
  check('再按一次 Ctrl+B 收起（是开合，不是只能开）', filesAfterSecond === filesBefore, JSON.stringify({ filesAfterSecond }))

  // ⑦ 键盘地图：从快速启动面板进去，内容要与实际绑定同源
  await pressCombo('k', 'KeyK', 75, CTRL)
  await evaluate(`(async () => {
    const input = document.querySelector('[data-testid="launcher-input"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '快捷键')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 300))
    return true
  })()`)
  await pressCombo('Enter', 'Enter', 13)
  const keyboardMap = await evaluate(`(() => {
    const panel = document.querySelector('[data-testid="keyboard-map"]')
    if (!panel) return { found: false }
    const text = panel.innerText
    return {
      found: true,
      keyChips: panel.querySelectorAll('kbd').length,
      mentionsLauncher: text.includes('快速启动'),
      mentionsTerminal: text.includes('终端面板'),
      groups: ['全局', '面板', '对话', '文件与编辑器'].filter((group) => text.includes(group))
    }
  })()`)
  check('快速启动面板里能打开键盘地图', keyboardMap?.found === true, JSON.stringify(keyboardMap))
  check('键盘地图列出了足够多的键位', (keyboardMap?.keyChips ?? 0) >= 10, JSON.stringify(keyboardMap))
  check(
    '键盘地图的内容与实际绑定同源（快速启动、终端、四个分组都在）',
    keyboardMap?.mentionsLauncher === true &&
      keyboardMap?.mentionsTerminal === true &&
      (keyboardMap?.groups ?? []).length === 4,
    JSON.stringify(keyboardMap)
  )
  await evaluate("document.querySelector('[data-testid=\"keyboard-map-backdrop\"]')?.click(); true")
  await new Promise((resolve) => setTimeout(resolve, 300))
  const mapClosed = await evaluate("Boolean(document.querySelector('[data-testid=\"keyboard-map\"]'))")
  check('点遮罩能关掉键盘地图', mapClosed === false)

  // ───────────────────────── 未保存改动：四条会丢内容的路径 ─────────────────────────

  console.log('\n── 未保存改动不该被静默丢掉 ──')

  /**
   * 编辑器里有未保存内容时，有四条路径可能把它丢掉：
   * ① 点文件树里的另一个文件 ② 点弹窗的 X ③ 点底部的「关闭」 ④ 点弹窗外的遮罩。
   *
   * 之前**只有按 Esc 会问一句**，另外四条全是静默丢弃 —— 同一次编辑，
   * 按 Esc 会问你、点 X 就直接丢。所以这一节逐条把四个入口都走一遍。
   */
  const UNSAVED = '// 这段没保存过'

  /**
   * 先自己把文件树摆好（打开面板 + 展开到 hello.ts 所在的目录）。
   *
   * 这一段原来直接找文件树里的行，也就是默认「前面某段已经导航到过那里」。
   * 快捷键那一段会开合面板，展开状态因此丢掉，这里就会以 `no-row` 失败 ——
   * 而那个失败信息完全指不到真正的原因。测试自己摆前提，比依赖执行顺序可靠。
   */
  const treeReady = await revealTreeFile('hello.ts', 'src')
  check('文件树里能找到 hello.ts（自己把前提摆好）', treeReady === true)

  const reopened = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const row = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'hello.ts')
      if (!row) return 'no-row'
      row.click()
      await wait(800)
      const content = document.querySelector('.cm-content')
      if (!content) return 'no-editor'
      content.focus()
      return 'open'
    })()
  `)

  check('重新打开文件准备制造未保存改动', reopened === 'open', String(reopened))

  await client.send('Input.insertText', { text: `${UNSAVED}\n` })
  await new Promise((r) => setTimeout(r, 500))
  const madeDirty = await evaluate(
    `({ dirty: document.body.innerText.includes('未保存'), text: document.querySelector('.cm-content')?.innerText ?? '' })`
  )
  check('制造出未保存状态', madeDirty?.dirty === true && String(madeDirty?.text).includes(UNSAVED), JSON.stringify(madeDirty?.dirty))

  /** ① 点文件树里的另一个文件 —— 必须先问。 */
  const switchAsks = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const row = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'README.md')
      if (!row) return 'no-row'
      row.click()
      await wait(700)
      return {
        asks: document.body.innerText.includes('丢弃并打开'),
        // 关键：还没丢 —— 编辑器里仍然是原文件与我敲的那段。
        stillMine: (document.querySelector('.cm-content')?.innerText ?? '').includes(${JSON.stringify(UNSAVED)}),
        stillOnHello: document.body.innerText.includes('hello.ts')
      }
    })()
  `)
  check('① 切文件前会问一句（不再静默丢弃）', switchAsks?.asks === true, JSON.stringify(switchAsks))
  check('① 问的时候内容还在（没被提前丢掉）', switchAsks?.stillMine === true, JSON.stringify(switchAsks))

  /** 取消之后必须回到原状。 */
  const unsavedCancelled = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const keep = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '继续编辑')
      if (!keep) return 'no-cancel'
      keep.click()
      await wait(500)
      return {
        confirmGone: !document.body.innerText.includes('丢弃并打开'),
        stillMine: (document.querySelector('.cm-content')?.innerText ?? '').includes(${JSON.stringify(UNSAVED)})
      }
    })()
  `)
  check('① 点「继续编辑」后确认收起且内容仍在', unsavedCancelled?.confirmGone === true && unsavedCancelled?.stillMine === true, JSON.stringify(unsavedCancelled))

  /** ② 点 X —— 之前这里是直接关掉（静默丢弃）。 */
  const xAsks = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const close = document.querySelector('button[title="关闭（有未保存改动会先问）"]')
      if (!close) return 'no-x-button'
      close.click()
      await wait(500)
      return {
        asks: document.body.innerText.includes('丢弃并关闭'),
        editorStillOpen: Boolean(document.querySelector('.cm-content')),
        stillMine: (document.querySelector('.cm-content')?.innerText ?? '').includes(${JSON.stringify(UNSAVED)})
      }
    })()
  `)
  check('② 点 X 会先问（之前是直接丢弃）', xAsks?.asks === true, JSON.stringify(xAsks))
  check('② 问的时候编辑器没有关掉、内容还在', xAsks?.editorStillOpen === true && xAsks?.stillMine === true, JSON.stringify(xAsks))

  /** ③ 点底部的「关闭」—— 同样必须先问。 */
  const footerCloseAsks = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const keep = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '继续编辑')
      if (keep) { keep.click(); await wait(400) }
      const close = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '关闭')
      if (!close) return 'no-close-button'
      close.click()
      await wait(500)
      return { asks: document.body.innerText.includes('丢弃并关闭'), stillMine: (document.querySelector('.cm-content')?.innerText ?? '').includes(${JSON.stringify(UNSAVED)}) }
    })()
  `)
  check('③ 点底部「关闭」会先问', footerCloseAsks?.asks === true, JSON.stringify(footerCloseAsks))

  /** ④ 点弹窗外面的遮罩 —— 这条最容易被忘掉。 */
  const backdropAsks = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const keep = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '继续编辑')
      if (keep) { keep.click(); await wait(400) }
      // 遮罩是弹窗外层那个 fixed inset-0 的容器；点它等于点「外面」。
      const backdrop = document.querySelector('div.fixed.inset-0')
      if (!backdrop) return 'no-backdrop'
      backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      await wait(500)
      return { asks: document.body.innerText.includes('丢弃并关闭'), stillOpen: Boolean(document.querySelector('.cm-content')) }
    })()
  `)
  check('④ 点弹窗外遮罩也会先问', backdropAsks?.asks === true, JSON.stringify(backdropAsks))
  check('④ 问的时候弹窗没有被关掉', backdropAsks?.stillOpen === true, JSON.stringify(backdropAsks))

  /** 确认丢弃之后：换到新文件，且磁盘上**没有**留下那段未保存内容。 */
  const unsavedDiscarded = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const keep = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '继续编辑')
      if (keep) { keep.click(); await wait(400) }
      const row = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'README.md')
      if (row) row.click()
      await wait(700)
      const discard = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '丢弃并打开')
      if (!discard) return { error: 'no-discard-button' }
      discard.click()
      await wait(900)
      return {
        onReadme: document.body.innerText.includes('README.md'),
        stillOpen: Boolean(document.querySelector('.cm-content'))
      }
    })()
  `)
  check('确认「丢弃并打开」后切到了新文件', unsavedDiscarded?.onReadme === true && unsavedDiscarded?.stillOpen === true, JSON.stringify(unsavedDiscarded))

  /**
   * 切换文件之后，编辑器里必须是**新文件**的内容。
   *
   * 这一条盯的是一个更严重的缺陷（写这段测试时才发现的）：弹窗内部用
   * `useState(preview.text)` 存文本，而换文件时组件被复用 —— 于是编辑器里仍是
   * 上一个文件的内容，`dirty` 立刻为真、「保存」可点，**Ctrl+S 会把上一个文件
   * 的内容写进这个文件**。修法是给弹窗加 `key={preview.path}`。
   */
  const afterSwitch = await evaluate(`
    (() => {
      const text = document.querySelector('.cm-content')?.innerText ?? ''
      return {
        showsReadme: text.includes('# fixture'),
        // 上一轮的未保存内容不该出现在新文件里。
        leakedOldText: text.includes(${JSON.stringify(UNSAVED)}),
        // 也不该出现「一打开就未保存」的假脏状态。
        spuriousDirty: document.body.innerText.includes('未保存')
      }
    })()
  `)
  check('切文件后编辑器里是新文件的内容', afterSwitch?.showsReadme === true, JSON.stringify(afterSwitch))
  check('新文件里没有混进上一个文件的内容', afterSwitch?.leakedOldText === false, JSON.stringify(afterSwitch))
  check('切文件后不会出现「一打开就未保存」的假脏状态', afterSwitch?.spuriousDirty === false, JSON.stringify(afterSwitch))

  const diskClean = await evaluate(
    `window.desk.fs.read(${JSON.stringify(workspaceId)}, 'src/hello.ts').then((r) => (r.ok ? r.data.text : r.error))`
  )
  check(
    '未保存的内容没有偷偷落盘（放弃就是真的放弃）',
    typeof diskClean === 'string' && !diskClean.includes('这段没保存过'),
    JSON.stringify(diskClean).slice(0, 160)
  )

  await evaluate(`
    (() => {
      const close = document.querySelector('button[title="关闭"]')
      if (close) close.click()
      return true
    })()
  `)
  await new Promise((r) => setTimeout(r, 400))

  // ─────────────────── 并发：agent 改了同一个文件，用户正好在编辑它 ───────────────────

  console.log('\n── 并发写：agent 在改、用户也在改 ──')

  /**
   * 这一节验的是**编辑器保存前的版本校验**（`expectedRevision`）为什么必须存在。
   *
   * 走法用「外部进程直接改盘」而不是走我们的 `fs.write` IPC —— 因为这才是真实机制：
   * agent 的 `write` 工具是 **sidecar 进程直接写文件系统**的，根本不经过主进程的
   * 写接口。所以主进程这边只会在用户点保存时，才发现 revision 对不上了。
   *
   * 要守住的性质只有一条：**先改的人赢，后改的人被拦下，而不是互相覆盖。**
   */
  const CONCURRENT_MINE = '// 用户正在敲的内容'
  const CONCURRENT_AGENT = 'export const hello = "agent 改过的内容"\n'

  const openedForConcurrent = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const titles = () => [...document.querySelectorAll('aside button[title]')].map((b) => b.getAttribute('title'))
      const refresh = document.querySelector('button[title="刷新"]')
      if (refresh) { refresh.click(); await wait(1200) }
      if (!titles().some((t) => t.startsWith('src/'))) {
        const srcRow = document.querySelector('aside button[title="src"]')
        if (srcRow) { srcRow.click(); await wait(800) }
      }
      const fileRow = [...document.querySelectorAll('aside button[title]')].find((b) => b.getAttribute('title') === 'src/hello.ts')
      if (!fileRow) return 'no-file-row: ' + JSON.stringify(titles().slice(0, 12))
      fileRow.click()
      /**
       * 等编辑器真的挂上，而不是「等 1 秒然后假设它在」。
       *
       * 固定等待在这里不够用：CodeMirror 内核是按需加载的 chunk，而在它之前
       * 还可能刚发生过一次主题切换（大范围重渲染）。第一版固定 1000ms，
       * 在一次「切主题之后再开文件」的情形下就抓空了 —— 而**抓空的后果不是一条失败，
       * 是整个套件卡住**：编辑器没开 → 没有未保存改动 → 后面的 window.close() 真的把窗口关掉
       * → 之后的 CDP 求值永不返回。
       */
      let content = null
      for (let i = 0; i < 24; i += 1) {
        content = document.querySelector('.cm-content')
        if (content) break
        await wait(250)
      }
      if (!content) return 'no-editor'
      content.focus()
      return 'open'
    })()
  `)
  check('打开 src/hello.ts 准备验并发写', openedForConcurrent === 'open', String(openedForConcurrent))

  await client.send('Input.insertText', { text: `${CONCURRENT_MINE}\n` })
  await new Promise((r) => setTimeout(r, 500))
  const dirtyBeforeExternal = await evaluate(
    `({ dirty: document.body.innerText.includes('未保存'), text: document.querySelector('.cm-content')?.innerText ?? '' })`
  )
  check(
    '编辑器里有了未保存的改动',
    dirtyBeforeExternal?.dirty === true && String(dirtyBeforeExternal?.text).includes(CONCURRENT_MINE),
    JSON.stringify(dirtyBeforeExternal?.dirty)
  )

  /**
   * 外部改盘 —— 等价于 agent 的 `write` 工具刚刚写过这个文件。
   * 用测试进程的 fs 直接写，而不是走 IPC：**sidecar 就是这么写的**。
   */
  writeFileSync(join(workspaceRoot, 'src', 'hello.ts'), CONCURRENT_AGENT, 'utf8')
  await new Promise((r) => setTimeout(r, 300))

  /** 用户点保存：必须被拦下。 */
  const saveAfterExternal = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const save = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存')
      if (!save) return { error: 'no-save-button' }
      save.click()
      await wait(1200)
      return {
        showsStale: document.body.innerText.includes('已被外部修改'),
        hasReloadButton: document.body.innerText.includes('重新加载（丢弃我的改动）'),
        keepsMyText: (document.querySelector('.cm-content')?.innerText ?? '').includes(${JSON.stringify(CONCURRENT_MINE)}),
        stillDirty: document.body.innerText.includes('未保存')
      }
    })()
  `)
  check('保存时发现文件被外部改过，界面给出过期提示', saveAfterExternal?.showsStale === true, JSON.stringify(saveAfterExternal))
  check('过期提示里带「重新加载」这条路（不让用户卡在无法保存的状态）', saveAfterExternal?.hasReloadButton === true, JSON.stringify(saveAfterExternal))
  check('被拦下后用户敲的内容还在', saveAfterExternal?.keepsMyText === true, JSON.stringify(saveAfterExternal))
  check('被拦下后仍然标着「未保存」（状态没有假装成功）', saveAfterExternal?.stillDirty === true, JSON.stringify(saveAfterExternal))

  /** 最关键的一条：磁盘上是 **agent 的**内容，用户的保存没有覆盖它。 */
  const diskAfterRejected = readFileSync(join(workspaceRoot, 'src', 'hello.ts'), 'utf8')
  check(
    '磁盘上保留的是外部（agent）写入的内容，没有被编辑器覆盖',
    diskAfterRejected === CONCURRENT_AGENT,
    JSON.stringify(diskAfterRejected)
  )

  /** 重新加载：接受磁盘上的版本，自己的改动被丢弃（这是用户明确点的）。 */
  const afterReloadClick = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const reload = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '重新加载（丢弃我的改动）')
      if (!reload) return { error: 'no-reload-button' }
      reload.click()
      await wait(1200)
      return {
        showsAgentText: (document.querySelector('.cm-content')?.innerText ?? '').includes('agent 改过的内容'),
        droppedMine: !(document.querySelector('.cm-content')?.innerText ?? '').includes(${JSON.stringify(CONCURRENT_MINE)}),
        dirtyGone: !document.body.innerText.includes('未保存')
      }
    })()
  `)
  check('重新加载后编辑器显示的是磁盘上的新内容', afterReloadClick?.showsAgentText === true, JSON.stringify(afterReloadClick))
  check('重新加载后自己的改动确实被丢弃（用户点的是「丢弃我的改动」）', afterReloadClick?.droppedMine === true, JSON.stringify(afterReloadClick))
  check('重新加载后不再是未保存状态', afterReloadClick?.dirtyGone === true, JSON.stringify(afterReloadClick))

  /** 恢复夹具内容，别让后面的段落踩到这个被改过的文件。 */
  writeFileSync(join(workspaceRoot, 'src', 'hello.ts'), 'export const hello = "edited by e2e"\n', 'utf8')
  await evaluate(`
    (() => {
      const close = document.querySelector('button[title="关闭"]')
      if (close) close.click()
      return true
    })()
  `)
  await new Promise((r) => setTimeout(r, 400))

  // ───────────────────────── 会话：重命名与搜索 ─────────────────────────

  console.log('\n── 会话重命名与搜索 ──')

  /**
   * 先造够会话才看得到搜索框（会话少时它不显示，见 Sidebar 的说明）。
   * 其中一个用显式标题，方便在列表里精确定位到它。
   */
  await evaluate(`
    (async () => {
      for (let i = 0; i < 4; i += 1) {
        await window.desk.session.create({ workspaceId: ${JSON.stringify(workspaceId)} })
      }
      window.__renameTarget = null
      const created = await window.desk.session.create({
        workspaceId: ${JSON.stringify(workspaceId)},
        title: 'e2e-待重命名'
      })
      if (created.ok) window.__renameTarget = created.data.id
      return true
    })()
  `)
  await new Promise((r) => setTimeout(r, 600))

  const searchBoxPresent = await evaluate(`Boolean(document.querySelector('input[aria-label="搜索会话"]'))`)
  check('会话足够多时出现搜索框', searchBoxPresent === true, String(searchBoxPresent))

  /**
   * 重命名走**真实交互**：真实 dblclick 进入编辑态、用原生 setter 触发 React 的
   * onChange、真实 Enter 提交。
   *
   * 直接改 `input.value` 是没用的 —— React 的受控输入不会收到通知，
   * 必须用原生 value setter + 手动派发 input 事件。这也正是测试里最容易写错的一处。
   */
  const renameResult = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const TARGET = 'e2e-待重命名'
      /**
       * 按**标题那一行的文本**定位，而不是整个按钮的 textContent ——
       * 按钮里还有一行「N 条 · 时间」的元信息，直接比对整体文本永远匹配不上。
       */
      const titleOf = (button) => {
        const first = button.querySelector('span')
        return first ? first.textContent.trim() : button.textContent.trim()
      }
      let row = null
      for (let i = 0; i < 25 && !row; i += 1) {
        row = [...document.querySelectorAll('aside button')].find((b) => titleOf(b) === TARGET)
        if (!row) await wait(200)
      }
      if (!row) {
        return 'row-not-found: ' + JSON.stringify([...document.querySelectorAll('aside button')].map(titleOf))
      }
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      await wait(400)

      const input = document.querySelector('input[aria-label="会话标题"]')
      if (!input) return 'no-rename-input'

      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '已重命名-e2e')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await wait(150)
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await wait(800)

      return {
        stillEditing: Boolean(document.querySelector('input[aria-label="会话标题"]')),
        shown: document.body.innerText.includes('已重命名-e2e'),
        oldGone: !document.body.innerText.includes('e2e-待重命名')
      }
    })()
  `)
  check('双击标题进入重命名输入态', typeof renameResult === 'object' && renameResult !== null, JSON.stringify(renameResult))
  check('Enter 提交后退出编辑态', renameResult?.stillEditing === false, JSON.stringify(renameResult))
  check('列表里显示了新标题', renameResult?.shown === true, JSON.stringify(renameResult))
  check('旧标题不再出现', renameResult?.oldGone === true, JSON.stringify(renameResult))

  // 关键：不只是界面上变了，磁盘上也得变。
  const persistedTitle = await evaluate(`
    window.desk.session.list().then((r) => {
      if (!r.ok) return r.error
      const target = r.data.find((s) => s.id === window.__renameTarget)
      return target ? target.title : 'not-found'
    })
  `)
  check('重命名已落盘（不只是界面状态）', persistedTitle === '已重命名-e2e', String(persistedTitle))

  const searchFiltered = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const input = document.querySelector('input[aria-label="搜索会话"]')
      if (!input) return 'no-search-input'
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '已重命名')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await wait(400)
      return { rows: document.querySelectorAll('aside li').length }
    })()
  `)
  check('搜索把列表收窄到匹配项', searchFiltered?.rows === 1, JSON.stringify(searchFiltered))

  const searchEmpty = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const input = document.querySelector('input[aria-label="搜索会话"]')
      if (!input) return 'no-search-input'
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, 'zzz-绝不可能匹配-zzz')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await wait(400)
      return {
        rows: document.querySelectorAll('aside li').length,
        // 「一个都没有」和「搜不到」必须是两条不同的提示，否则用户会以为会话丢了。
        emptyHint: document.body.innerText.includes('没有匹配')
      }
    })()
  `)
  check('搜不到时列表为空', searchEmpty?.rows === 0, JSON.stringify(searchEmpty))
  check('搜不到时给出的是「没有匹配」而不是「还没有会话」', searchEmpty?.emptyHint === true, JSON.stringify(searchEmpty))

  // 清空搜索，恢复列表（后续断言依赖这个状态）。
  await evaluate(`
    (async () => {
      const input = document.querySelector('input[aria-label="搜索会话"]')
      if (!input) return true
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()
  `)

  // ───────────────────────── 删除会话：确认 + 真的落盘 ─────────────────────────

  console.log('\n── 删除会话（确认 / 取消 / 删当前会话） ──')

  /**
   * 删除会话是**误点代价最高**的一处：两个 24px 的小图标只在悬停时出现、还紧挨着，
   * 点错丢掉的就是一整次对话。而这里此前没有任何断言 ——
   * 「确认」「取消」「删掉当前会话之后界面怎么办」全都没被测过。
   */
  const doomed = await evaluate(
    `window.desk.session.create({ workspaceId: ${JSON.stringify(workspaceId)}, title: 'e2e-待删除' })
       .then((r) => (r.ok ? r.data : r.error))`
  )
  check('删前造好一个会话', Boolean(doomed?.id), JSON.stringify(doomed))

  /** 点这一行的操作按钮。`title` 同一行里可能有多个，所以先按行标题定位到行。 */
  const rowClickScript = (rowTitle, buttonTitle) => `
    (() => {
      const row = [...document.querySelectorAll('aside li')].find((li) =>
        (li.querySelector('button[title]')?.getAttribute('title') ?? '').startsWith(${JSON.stringify(rowTitle)})
      )
      if (!row) return 'row-not-found'
      const button = [...row.querySelectorAll('button')].find((b) => b.getAttribute('title') === ${JSON.stringify(buttonTitle)})
      if (!button) return 'button-not-found'
      button.click()
      return 'ok'
    })()
  `

  const confirmShown = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const clicked = ${rowClickScript('e2e-待删除', '删除会话')}
      if (clicked !== 'ok') return clicked
      await wait(300)
      return {
        hasConfirm: Boolean(document.querySelector('button[title="确认删除会话"]')),
        hasCancel: Boolean(document.querySelector('button[title="取消删除会话"]')),
        // 关键：还没真删。确认之前**磁盘上必须还在**。
        stillListed: (await window.desk.session.list()).data.some((s) => s.title === 'e2e-待删除')
      }
    })()
  `)
  check('点删除先给出确认（而不是直接删）', confirmShown?.hasConfirm === true && confirmShown?.hasCancel === true, JSON.stringify(confirmShown))
  check('确认之前会话还在磁盘上', confirmShown?.stillListed === true, JSON.stringify(confirmShown))

  const sessionRemoveCancel = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const cancel = document.querySelector('button[title="取消删除会话"]')
      if (!cancel) return 'no-cancel'
      cancel.click()
      await wait(300)
      return {
        confirmGone: !document.querySelector('button[title="确认删除会话"]'),
        stillListed: (await window.desk.session.list()).data.some((s) => s.title === 'e2e-待删除')
      }
    })()
  `)
  check('点取消后确认态收起且会话保留', sessionRemoveCancel?.confirmGone === true && sessionRemoveCancel?.stillListed === true, JSON.stringify(sessionRemoveCancel))

  /**
   * 接着验最要紧的一种：**删掉的正是当前选中的会话**。
   *
   * 先把它选中（列表里点一下），再删 —— 要确认界面不会停在一个已经不存在的会话上，
   * 也不会把被删会话的消息留在屏幕上。
   */
  const removedCurrent = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const row = () => [...document.querySelectorAll('aside li')].find((li) =>
        (li.querySelector('button[title]')?.getAttribute('title') ?? '').startsWith('e2e-待删除')
      )
      // 选中它。
      row()?.querySelector('button[title]')?.click()
      await wait(600)
      const wasActive = row()?.querySelector('div')?.className.includes('accent-soft') ?? false

      const clicked = ${rowClickScript('e2e-待删除', '删除会话')}
      if (clicked !== 'ok') return clicked
      await wait(300)
      document.querySelector('button[title="确认删除会话"]')?.click()
      await wait(1200)

      const listed = await window.desk.session.list()
      return {
        wasActive,
        goneFromSidebar: !row(),
        goneFromDisk: !listed.data.some((s) => s.title === 'e2e-待删除'),
        // 界面不该停在一个不存在的会话上：要么切到别的会话，要么回到「没有会话」。
        stillHasComposer: Boolean(document.querySelector('textarea'))
      }
    })()
  `)
  check('选中待删会话后它确实是当前会话', removedCurrent?.wasActive === true, JSON.stringify(removedCurrent))
  check('确认后会话从侧栏消失', removedCurrent?.goneFromSidebar === true, JSON.stringify(removedCurrent))
  check('确认后会话从磁盘消失', removedCurrent?.goneFromDisk === true, JSON.stringify(removedCurrent))
  check('删掉当前会话后界面仍可用', removedCurrent?.stillHasComposer === true, JSON.stringify(removedCurrent))

  // ───────────────────────── 文件树：新建 / 重命名 / 删除 ─────────────────────────

  console.log('\n── 文件树操作（新建 / 重命名 / 删除） ──')

  /** 在页面里按「行的 title 属性」定位到某个文件的那一行，再点它的行内操作。 */
  const rowActionScript = (fileName, actionTitle) => `
    (() => {
      const rowButton = [...document.querySelectorAll('button')].find(
        (b) => b.getAttribute('title') === ${JSON.stringify(fileName)}
      )
      if (!rowButton) return 'row-not-found'
      const row = rowButton.closest('.group')
      if (!row) return 'row-wrapper-not-found'
      const action = [...row.querySelectorAll('button')].find((b) => b.getAttribute('title') === ${JSON.stringify(actionTitle)})
      if (!action) return 'action-not-found'
      action.click()
      return 'ok'
    })()
  `

  const NEW_FILE = 'e2e-created.md'
  const RENAMED_FILE = 'e2e-renamed.md'

  const createdViaUi = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const trigger = document.querySelector('button[title="在工作区根目录新建文件"]')
      if (!trigger) return 'no-create-button'
      trigger.click()
      await wait(300)
      const input = document.querySelector('input[aria-label="文件名"]')
      if (!input) return 'no-name-input'
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(NEW_FILE)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await wait(150)
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await wait(1000)
      return {
        inputGone: !document.querySelector('input[aria-label="文件名"]'),
        inTree: [...document.querySelectorAll('button')].some(
          (b) => b.getAttribute('title') === ${JSON.stringify(NEW_FILE)}
        ),
        // 新建后应当直接打开它 —— 建完文件的下一步几乎一定是写点东西。
        openedInEditor: Boolean(document.querySelector('.cm-editor'))
      }
    })()
  `)
  check('能通过界面新建文件', createdViaUi?.inputGone === true, JSON.stringify(createdViaUi))
  check('新文件出现在文件树里', createdViaUi?.inTree === true, JSON.stringify(createdViaUi))
  check('新文件在磁盘上确实存在', existsSync(join(workspaceRoot, NEW_FILE)), NEW_FILE)
  check('新建后自动打开在编辑器里', createdViaUi?.openedInEditor === true, JSON.stringify(createdViaUi))

  // 关掉编辑器，否则下面的行内操作会被遮住（虽然 JS click 不受影响，但要贴近真实使用）。
  await evaluate(`
    (() => {
      const close = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '关闭')
      if (close) close.click()
      return true
    })()
  `)
  await new Promise((r) => setTimeout(r, 400))

  const renameAction = await evaluate(rowActionScript(NEW_FILE, '重命名'))
  await new Promise((r) => setTimeout(r, 400))
  const renamed = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const input = document.querySelector('input[aria-label="文件名"]')
      if (!input) return 'no-rename-input'
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(RENAMED_FILE)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await wait(150)
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await wait(900)
      return {
        inputGone: !document.querySelector('input[aria-label="文件名"]'),
        inTree: [...document.querySelectorAll('button')].some(
          (b) => b.getAttribute('title') === ${JSON.stringify(RENAMED_FILE)}
        )
      }
    })()
  `)
  check('行内「重命名」能进入编辑态', renameAction === 'ok', String(renameAction))
  check('重命名后退出编辑态', renamed?.inputGone === true, JSON.stringify(renamed))
  check('文件树里显示新名字', renamed?.inTree === true, JSON.stringify(renamed))
  check('磁盘上是新名字', existsSync(join(workspaceRoot, RENAMED_FILE)), RENAMED_FILE)
  check('磁盘上旧名字已消失', !existsSync(join(workspaceRoot, NEW_FILE)), NEW_FILE)

  /**
   * 删除真的会把它移进**系统回收站**（这是产品行为：误删要可恢复）。
   * 代价是测试机的回收站里会多一条指向临时目录的记录 —— 可接受，
   * 因为「用回收站而不是 rm」正是这里要验证的行为。
   */
  const removeAction = await evaluate(rowActionScript(RENAMED_FILE, '删除'))
  await new Promise((r) => setTimeout(r, 400))
  const removeConfirmed = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const hasConfirm = document.body.innerText.includes('会移到系统回收站')
      if (!hasConfirm) return 'no-confirm-bar'
      const confirm = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '删除')
      if (!confirm) return 'no-confirm-button'
      confirm.click()
      await wait(1000)
      return {
        goneFromTree: ![...document.querySelectorAll('button')].some(
          (b) => b.getAttribute('title') === ${JSON.stringify(RENAMED_FILE)}
        )
      }
    })()
  `)
  check('删除前需要二次确认（并说明会进回收站）', removeAction === 'ok', String(removeAction))
  check('确认后文件从树里消失', removeConfirmed?.goneFromTree === true, JSON.stringify(removeConfirmed))
  check('磁盘上文件已被移走', !existsSync(join(workspaceRoot, RENAMED_FILE)), RENAMED_FILE)

  // 越界删除必须被主进程挡住（界面不该能删工作区外的东西）。
  const escapeRemove = await evaluate(
    `window.desk.fs.remove({ workspaceId: ${JSON.stringify(workspaceId)}, path: '../outside.txt' }).then(r => r.ok ? 'ALLOWED' : r.error.code)`
  )
  check('越界删除被拒绝', escapeRemove === 'FORBIDDEN', String(escapeRemove))

  // ───────────────────────── 技能：磁盘视角 ─────────────────────────

  console.log('\n── 文件树：移动到… ──')

  /**
   * 移动做成「可点可按的目录选择器」而不是拖拽。
   *
   * 理由很实际：拖拽在 CDP 下无法可靠驱动（合成 drag 事件与真实指针行为差别很大），
   * 而移动是**破坏性操作** —— 一个验不了的破坏性操作不值得做。
   * 这一节同时把一直没被碰过的「刷新」按钮也走了一遍。
   */
  const MOVE_FILE = 'e2e-move-me.md'
  await evaluate(
    `window.desk.fs.create({ workspaceId: ${JSON.stringify(workspaceId)}, path: ${JSON.stringify(MOVE_FILE)} })
       .then((r) => (r.ok ? 'ok' : r.error))`
  )

  const pickerOpened = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      // 「刷新」此前没有任何断言碰过：它负责在外部改动后重新读盘。
      const refresh = document.querySelector('button[title="刷新"]')
      if (!refresh) return { error: 'no-refresh-button' }
      refresh.click()
      await wait(900)

      const clicked = ${rowActionScript(MOVE_FILE, '移动到…')}
      if (clicked !== 'ok') return { error: clicked }
      await wait(600)

      return {
        hasConfirm: Boolean(document.querySelector('button[title="移到这里"]')),
        hasCancel: Boolean(document.querySelector('button[title="取消移动"]')),
        // 选择器默认从**文件当前所在目录**开始，所以根目录下应当列出 src。
        listsSrc: Boolean(document.querySelector('button[title="进入 src"]')),
        // 还没移：磁盘上必须还在原处。（fs.read 是位置参数，不是对象。）
        stillAtRoot: !!(await window.desk.fs.read(${JSON.stringify(workspaceId)}, ${JSON.stringify(MOVE_FILE)})).ok
      }
    })()
  `)
  check('点「移动到…」会打开目录选择器', pickerOpened?.hasConfirm === true && pickerOpened?.hasCancel === true, JSON.stringify(pickerOpened))
  check('选择器列出当前目录下的子目录（可进入）', pickerOpened?.listsSrc === true, JSON.stringify(pickerOpened))
  check('确认之前文件还在原处', pickerOpened?.stillAtRoot === true, JSON.stringify(pickerOpened))

  const cancelMove = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      document.querySelector('button[title="取消移动"]')?.click()
      await wait(400)
      return {
        pickerGone: !document.querySelector('button[title="移到这里"]'),
        stillAtRoot: !!(await window.desk.fs.read(${JSON.stringify(workspaceId)}, ${JSON.stringify(MOVE_FILE)})).ok
      }
    })()
  `)
  check('取消后选择器收起且文件没动', cancelMove?.pickerGone === true && cancelMove?.stillAtRoot === true, JSON.stringify(cancelMove))

  const movedViaUi = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const clicked = ${rowActionScript(MOVE_FILE, '移动到…')}
      if (clicked !== 'ok') return { error: clicked }
      await wait(500)

      // 进入 src，然后确认。
      const enter = document.querySelector('button[title="进入 src"]')
      if (!enter) return { error: 'no-src-entry' }
      enter.click()
      await wait(500)
      document.querySelector('button[title="移到这里"]')?.click()
      await wait(1200)

      const atRoot = await window.desk.fs.read(${JSON.stringify(workspaceId)}, ${JSON.stringify(MOVE_FILE)})
      const inSrc = await window.desk.fs.read(${JSON.stringify(workspaceId)}, 'src/' + ${JSON.stringify(MOVE_FILE)})
      const titles = () => [...document.querySelectorAll('aside button[title]')].map((b) => b.getAttribute('title') ?? '')
      // 目标目录要是收起的，就展开它 —— 否则「在目标目录里找得到它」验的是空气。
      const srcRow = document.querySelector('aside button[title="src"]')
      if (srcRow && !titles().some((t) => t.startsWith('src/'))) {
        srcRow.click()
        await wait(800)
      }
      return {
        pickerGone: !document.querySelector('button[title="移到这里"]'),
        goneFromRoot: !atRoot.ok,
        arrivedInSrc: inSrc.ok,
        rootRowGone: !titles().includes(${JSON.stringify(MOVE_FILE)}),
        /**
         * 正向断言，而不是「原来那个不在了」。
         *
         * 这一条是补上来的：原来只断言「根目录下不再显示它」，而
         * **树整个空了的时候这句话恒真** —— 于是「移动之后整棵树变空」
         * （删了缓存却忘了重新加载）这个真实缺陷从这条断言底下溜了过去。
         */
        treeNotEmpty: titles().length > 0,
        // 在**目标目录**里能找到它（上面已确保 src 展开）。
        foundInTarget: titles().includes('src/' + ${JSON.stringify(MOVE_FILE)})
      }
    })()
  `)
  check('确认后选择器收起', movedViaUi?.pickerGone === true, JSON.stringify(movedViaUi))
  check('文件真的从原目录移走了（磁盘）', movedViaUi?.goneFromRoot === true, JSON.stringify(movedViaUi))
  check('文件真的到了目标目录（磁盘）', movedViaUi?.arrivedInSrc === true, JSON.stringify(movedViaUi))
  check('文件树里根目录下不再显示它', movedViaUi?.rootRowGone === true, JSON.stringify(movedViaUi))
  /**
   * 这两条是「移动把整棵树弄空」那个缺陷的守卫。
   *
   * 它们必须是**正向**的：如果只断言「原位置不在了」，那么一个把所有东西都删掉的
   * bug 反而会让测试通过。
   */
  check('移动之后文件树没有变空', movedViaUi?.treeNotEmpty === true, JSON.stringify(movedViaUi))
  check('展开目标目录后能在树里找到它', movedViaUi?.foundInTarget === true, JSON.stringify(movedViaUi))

  // 跨目录移动的越界/覆盖/子目录等防线由单元测试逐条打（verify-workspace-fs 的 [14]）。

  console.log('\n── 路径改写：改名的目录里正开着文件 ──')

  /**
   * 三个操作（改名 / 移动 / 删除）原来都只按**精确路径相等**判断预览是否失效。
   * 于是「重命名一个目录、里面正开着文件」会留下一个指向不存在路径的编辑器：
   * 标题写着旧路径、按保存报 NOT_FOUND，用户只能把内容复制出来再关掉。
   *
   * 而改名/移动**不改变 mtime 与 size**（实测确认），也就是说 revision（mtime:size）
   * 在新路径上依然有效 —— 所以完全可以接着编辑并保存成功。这里逐条把这件事钉住。
   */
  const REMAP_MARK = '// 改名不该丢掉的编辑'
  /** 先把「刷新前」的树状态留一份：空树是缺陷，不该被后面那次刷新掩盖。 */
  const treeStateBefore = await evaluate(`
    ({
      treeTitles: [...document.querySelectorAll('aside button[title]')]
        .map((b) => b.getAttribute('title'))
        .filter((t) => t && !['选择工作目录', '新建会话', '重命名会话', '删除会话', '在工作区根目录新建文件', '刷新', '收起面板'].includes(t)),
      asideText: (document.querySelector('aside')?.innerText ?? '').slice(0, 200)
    })
  `)

  const openedForRemap = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const texts = () => [...document.querySelectorAll('button')].map((b) => b.textContent.trim())
      const clickByText = async (text, timeoutMs = 6000) => {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          const button = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === text)
          if (button) { button.click(); return true }
          await wait(200)
        }
        return false
      }

      // 先记一下刷新前的状态：前面几段折腾过树（展开/刷新/移动），万一它是空的，要知道。
      const before = {
        treeTitles: [...document.querySelectorAll('aside button[title]')]
          .map((b) => b.getAttribute('title'))
          .filter((t) => t && !['选择工作目录', '新建会话', '重命名会话', '删除会话', '在工作区根目录新建文件', '刷新', '收起面板'].includes(t))
          .slice(0, 12),
        asideText: (document.querySelector('aside')?.innerText ?? '').slice(0, 300)
      }

      const refresh = document.querySelector('button[title="刷新"]')
      if (refresh) { refresh.click(); await wait(1200) }

      if (!(await clickByText('src'))) {
        return 'no-src: ' + JSON.stringify({ before, after: document.querySelector('aside')?.innerText?.slice(0, 300) })
      }
      await wait(500)
      if (!(await clickByText('hello.ts'))) return 'no-file: ' + JSON.stringify(texts())
      await wait(900)
      const content = document.querySelector('.cm-content')
      if (!content) return 'no-editor'
      content.focus()
      return 'open'
    })()
  `)
  check('打开 src/hello.ts 准备测试路径改写', openedForRemap === 'open', String(openedForRemap))
  /**
   * 顺带守住一件事：**文件树不该在若干操作之后自己变空**。
   *
   * 这条是这一轮补的 —— 当时发现「移动文件之后整棵树变空」（删了缓存忘了重载），
   * 而原来的断言写成「原位置不在了」，树空了反而恒真。所以这里也留一条正向断言。
   * 上面那次「刷新」点击是为了让本节不受上游段落状态影响，但**空树本身要能被看见**。
   */
  check(
    '本段开始时文件树不是空的（空树本身是一个缺陷）',
    (treeStateBefore?.treeTitles?.length ?? 0) > 0,
    JSON.stringify(treeStateBefore)
  )

  await client.send('Input.insertText', { text: `${REMAP_MARK}\n` })
  await new Promise((r) => setTimeout(r, 400))

  /** 改名 `src` → `src-renamed`（行内「重命名」）。 */
  const renamedDir = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const row = [...document.querySelectorAll('aside li, aside div')].find(
        (el) => el.querySelector?.('button[title="src"]')
      ) ?? null
      void row
      // 目录行：按钮 title 就是它的路径。
      const rowButton = document.querySelector('button[title="src"]')
      if (!rowButton) return 'no-src-row'
      const wrapper = rowButton.closest('.group')
      if (!wrapper) return 'no-wrapper'
      const rename = [...wrapper.querySelectorAll('button')].find((b) => b.getAttribute('title') === '重命名')
      if (!rename) return 'no-rename-action'
      rename.click()
      await wait(400)
      const input = document.querySelector('input[aria-label="文件名"]')
      if (!input) return 'no-name-input'
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, 'src-renamed')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await wait(150)
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await wait(1200)
      return 'renamed'
    })()
  `)
  check('把 src 目录改名成功', renamedDir === 'renamed', String(renamedDir))

  const afterDirRename = await evaluate(`
    (() => {
      const text = document.querySelector('.cm-content')?.innerText ?? ''
      return {
        // 头部显示的路径必须跟着变，否则就是在对着一个不存在的文件编辑。
        headerMoved: document.body.innerText.includes('src-renamed/hello.ts'),
        keepsEdit: text.includes(${JSON.stringify(REMAP_MARK)}),
        stillDirty: document.body.innerText.includes('未保存')
      }
    })()
  `)
  check('改名后预览路径跟着改写（不再指向不存在的文件）', afterDirRename?.headerMoved === true, JSON.stringify(afterDirRename))
  check('改名后编辑内容仍在', afterDirRename?.keepsEdit === true, JSON.stringify(afterDirRename))
  check('改名后仍标着「未保存」', afterDirRename?.stillDirty === true, JSON.stringify(afterDirRename))

  /** 在新路径上保存 —— 这一条证明 revision 在改名后依然有效。 */
  await evaluate(`document.querySelector('.cm-content').focus(); true`)
  const modified = process.platform === 'darwin' ? 4 : 2 // Meta 或 Control
  await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers: modified })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers: modified })
  await new Promise((r) => setTimeout(r, 1200))

  const savedAfterRename = await evaluate(
    `window.desk.fs.read(${JSON.stringify(workspaceId)}, 'src-renamed/hello.ts').then((r) => (r.ok ? r.data.text : r.error))`
  )
  check(
    '改名后能在新路径上保存成功（revision 仍然有效）',
    typeof savedAfterRename === 'string' && savedAfterRename.includes(REMAP_MARK),
    JSON.stringify(savedAfterRename).slice(0, 160)
  )
  check('旧路径下已经没有这个文件', !existsSync(join(workspaceRoot, 'src', 'hello.ts')), join(workspaceRoot, 'src', 'hello.ts'))

  /** 再改回来，确认反向也走同一条路（顺带把夹具恢复原状）。 */
  const renamedBack = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const rowButton = document.querySelector('button[title="src-renamed"]')
      if (!rowButton) return 'no-row'
      const wrapper = rowButton.closest('.group')
      const rename = [...wrapper.querySelectorAll('button')].find((b) => b.getAttribute('title') === '重命名')
      rename.click()
      await wait(400)
      const input = document.querySelector('input[aria-label="文件名"]')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, 'src')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await wait(150)
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await wait(1200)
      return { back: document.body.innerText.includes('src/hello.ts') }
    })()
  `)
  check('改回原名后预览路径也跟着回来了', renamedBack?.back === true, JSON.stringify(renamedBack))
  check('夹具恢复：src/hello.ts 又存在了', existsSync(join(workspaceRoot, 'src', 'hello.ts')))

  /** 关掉预览，准备验「删除正打开的文件」。 */
  await evaluate(`
    (() => {
      const close = document.querySelector('button[title="关闭"]')
      if (close) close.click()
      return true
    })()
  `)
  await new Promise((r) => setTimeout(r, 400))

  const DELETED_OPEN = 'e2e-delete-open.md'
  await evaluate(
    `window.desk.fs.create({ workspaceId: ${JSON.stringify(workspaceId)}, path: ${JSON.stringify(DELETED_OPEN)}, text: '# 待删除\\n' })
       .then((r) => (r.ok ? 'ok' : r.error))`
  )
  await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const refresh = document.querySelector('button[title="刷新"]')
      if (refresh) { refresh.click(); await wait(900) }
      const row = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(DELETED_OPEN)})
      if (row) { row.click(); await wait(800) }
      return true
    })()
  `)

  const deletedOpen = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const rowButton = document.querySelector('button[title=${JSON.stringify(DELETED_OPEN)}]')
      if (!rowButton) return { error: 'no-row' }
      const wrapper = rowButton.closest('.group')
      const remove = [...wrapper.querySelectorAll('button')].find((b) => b.getAttribute('title') === '删除')
      if (!remove) return { error: 'no-remove-action' }
      remove.click()
      await wait(500)
      // 确认条是这一行的**兄弟**节点（不在 .group 里），所以要在整篇里找它的按钮。
      if (!document.body.innerText.includes('会移到系统回收站')) return { error: 'no-confirm-bar' }
      const confirm = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '删除')
      if (!confirm) return { error: 'no-confirm-button' }
      confirm.click()
      await wait(1200)
      return {
        previewClosed: !document.querySelector('.cm-content'),
        goneFromDisk: !(await window.desk.fs.read(${JSON.stringify(workspaceId)}, ${JSON.stringify(DELETED_OPEN)})).ok
      }
    })()
  `)
  check('删掉正打开的文件后预览会关掉（不留一个指向已删文件的编辑器）', deletedOpen?.previewClosed === true, JSON.stringify(deletedOpen))
  check('被删的文件确实不在磁盘上了', deletedOpen?.goneFromDisk === true, JSON.stringify(deletedOpen))

  console.log('\n── 技能（磁盘） ──')

  const diskSkills = await evaluate('window.desk.skills.list().then(r => r.ok ? r.data.map(s => s.name) : r.error)')
  check('skills.list 能看到预置技能', Array.isArray(diskSkills) && diskSkills.includes(SKILL_NAME), JSON.stringify(diskSkills))

  // ───────────────────────── 技能：内核视角（本轮核心） ─────────────────────────

  console.log('\n── 技能（内核）与系统提示 ──')

  const created = await evaluate(
    `window.desk.session.create({ workspaceId: ${JSON.stringify(workspaceId)} }).then(r => r.ok ? r.data.id : r.error)`
  )
  check('能创建会话', typeof created === 'string' && created.length > 10, JSON.stringify(created))

  const inspected = await evaluate(
    `window.desk.agent.inspect(${JSON.stringify(created)}).then(r => r.ok ? r.data : r.error)`
  )
  const skillNames = (inspected?.skills ?? []).map((s) => s.name)
  check('内核已加载预置技能', skillNames.includes(SKILL_NAME), JSON.stringify(inspected?.skills ?? inspected))
  check(
    '技能描述被内核读到',
    (inspected?.skills ?? []).some((s) => s.name === SKILL_NAME && String(s.description).includes('提交')),
    JSON.stringify(inspected?.skills)
  )
  check(
    '系统提示里出现了该技能名',
    typeof inspected?.systemPrompt === 'string' && inspected.systemPrompt.includes(SKILL_NAME),
    `systemPrompt 长度=${String(inspected?.systemPrompt ?? '').length}`
  )
  check(
    '系统提示里出现了技能描述（渐进式披露的目录行）',
    typeof inspected?.systemPrompt === 'string' && inspected.systemPrompt.includes('提交与代码风格约定'),
    String(inspected?.systemPrompt ?? '').slice(0, 400)
  )
  check(
    '技能全文未被塞进系统提示（渐进式披露）',
    typeof inspected?.systemPrompt === 'string' && !inspected.systemPrompt.includes(SKILL_MARKER),
    '技能正文出现在了系统提示里 —— 说明不是按需加载'
  )
  check('生效工具列表非空', Array.isArray(inspected?.activeTools) && inspected.activeTools.length > 0, JSON.stringify(inspected?.activeTools))
  check('无技能诊断错误', (inspected?.diagnostics ?? []).length === 0, JSON.stringify(inspected?.diagnostics))

  // ───────────────────────── 技能：通过 IPC 增删 ─────────────────────────

  console.log('\n── 技能（增删） ──')

  const installedViaIpc = await evaluate(
    `window.desk.skills.install({ name: 'e2e-installed', content: '---\\nname: e2e-installed\\ndescription: 通过 IPC 安装的技能\\n---\\n\\n正文\\n' }).then(r => r.ok ? r.data.name : r.error)`
  )
  check('通过 IPC 安装技能', installedViaIpc === 'e2e-installed', JSON.stringify(installedViaIpc))

  const afterInstall = await evaluate('window.desk.skills.list().then(r => r.ok ? r.data.map(s => s.name) : r.error)')
  check('新技能出现在列表里', Array.isArray(afterInstall) && afterInstall.includes('e2e-installed'), JSON.stringify(afterInstall))

  const badName = await evaluate(
    `window.desk.skills.install({ name: '../escape', content: 'x' }).then(r => r.ok ? 'ALLOWED' : r.error.code)`
  )
  check('非法技能名被拒（端到端）', badName === 'INVALID_SKILL_NAME', String(badName))

  const removed = await evaluate(`window.desk.skills.remove('e2e-installed').then(r => r.ok ? r.data.name : r.error)`)
  check('通过 IPC 删除技能', removed === 'e2e-installed', JSON.stringify(removed))

  const afterRemove = await evaluate('window.desk.skills.list().then(r => r.ok ? r.data.map(s => s.name) : r.error)')
  check('删除后不再出现', Array.isArray(afterRemove) && !afterRemove.includes('e2e-installed'), JSON.stringify(afterRemove))

  console.log('\n── 插件 ──')

  const pluginList = await evaluate('window.desk.plugins.list().then(r => r.ok ? r.data : r.error)')
  const fixture = (pluginList ?? []).find((p) => p.id === FIXTURE_PLUGIN_ID)
  check('插件出现在列表里', Boolean(fixture), JSON.stringify(pluginList?.map((p) => p.id)))
  check('安装后默认未启用（启用才是知情同意的落点）', fixture?.enabled === false, JSON.stringify(fixture?.enabled))
  check('manifest 解析无错误', fixture?.loadError === undefined, String(fixture?.loadError))
  check(
    '声明了权限清单（UI 要在启用前显示）',
    Array.isArray(fixture?.permissions) && fixture.permissions.includes('agent.tool.register'),
    JSON.stringify(fixture?.permissions)
  )
  check('声明了工具', Array.isArray(fixture?.tools) && fixture.tools.includes('fixture_echo'), JSON.stringify(fixture?.tools))

  const enabled = await evaluate(
    `window.desk.plugins.setEnabled(${JSON.stringify(FIXTURE_PLUGIN_ID)}, true).then(r => r.ok ? r.data : r.error)`
  )
  check('能启用插件', enabled?.enabled === true, JSON.stringify(enabled))

  /**
   * 建一个**新会话**：插件在会话建立时才被 sidecar 加载并注册工具。
   * 这一步验证的是整条链路 —— 主进程传 id/目录 → sidecar 重新校验 manifest →
   * 启动插件子进程 → 把它声明的工具注册给 pi → 把它带来的技能并入技能搜索路径。
   */
  const pluginSession = await evaluate(
    `window.desk.session.create({ workspaceId: ${JSON.stringify(workspaceId)} }).then(r => r.ok ? r.data.id : r.error)`
  )
  const pluginInspect = await evaluate(
    `window.desk.agent.inspect(${JSON.stringify(pluginSession)}).then(r => r.ok ? r.data : r.error)`
  )

  const pluginRuntime = (pluginInspect?.plugins ?? []).find((p) => p.id === FIXTURE_PLUGIN_ID)
  check('sidecar 已激活插件', pluginRuntime?.state === 'active', JSON.stringify(pluginInspect?.plugins))
  check(
    '插件工具已被注册给内核（出现在生效工具列表里）',
    Array.isArray(pluginInspect?.activeTools) && pluginInspect.activeTools.includes('fixture_echo'),
    JSON.stringify(pluginInspect?.activeTools)
  )
  check(
    '插件自带的技能被内核加载',
    (pluginInspect?.skills ?? []).some((s) => s.name === 'fixture-review'),
    JSON.stringify((pluginInspect?.skills ?? []).map((s) => s.name))
  )
  check(
    '插件技能进了系统提示（与用户技能同一套渐进式披露）',
    typeof pluginInspect?.systemPrompt === 'string' && pluginInspect.systemPrompt.includes('fixture-review'),
    String(pluginInspect?.systemPrompt ?? '').slice(0, 400)
  )

  // ───────────────────────── 让模型真的调一次插件工具 ─────────────────────────

  console.log('\n── 插件：让模型真的调用一次插件工具 ──')

  /**
   * 上面验的是「工具被注册进生效列表」——那是**注册成功**，不是**能跑通**。
   *
   * 这一段让假模型去调 `fixture_echo`，把中间每一段都走一遍：
   * 工具的 schema 转成厂商的函数调用格式 → 模型发起调用 → 宿主路由到插件子进程
   * → 参数真的传进去 → 结果回传给模型。任何一段断了，界面看起来都只是
   * 「模型没调工具」，很难定位。
   *
   * 插件工具**不在审批表里**，按 `write` 风险处理（宁可多问一次），所以会弹审批 ——
   * 顺带把「插件工具的审批路径」也验了。
   */
  const pluginToolSession = await evaluate(
    `window.desk.session.create({ workspaceId: ${JSON.stringify(workspaceId)}, title: 'e2e-插件工具' })
       .then((r) => (r.ok ? r.data.id : r.error))`
  )
  check('为插件工具建了一个会话', typeof pluginToolSession === 'string', JSON.stringify(pluginToolSession))

  /**
   * 这一段**自带一个可用的 provider**，不依赖脚本里其它段落的顺序。
   *
   * 第一版直接 prompt，结果是立刻 `stopReason: 'error'` —— 因为插件段跑在控制面同步
   * **之前**，那时默认 provider 还是种子里的 `e2e-provider`（指向一个死端口，
   * 那是留给「模型不可达」用例的）。测试不该假设「此刻默认 provider 是好的」。
   */
  const pluginProviderId = 'e2e-plugin-provider'
  const pluginProviderSaved = await evaluate(`
    window.desk.provider.save({
      provider: {
        id: ${JSON.stringify(pluginProviderId)},
        label: 'e2e 插件工具用',
        apiStyle: 'openai-completions',
        baseUrl: 'http://127.0.0.1:${CP_PORT}/v1',
        models: [{ id: 'mock-model', label: 'mock' }],
        enabled: true
      }
    }).then((r) => (r.ok ? 'ok' : r.error))
  `)
  /**
   * 断言这一步成功很重要：入参形状写错时（`provider.save` 要的是 `{ provider: {...} }`，
   * 不是平铺字段）它只会抛 BAD_REQUEST，而**不检查返回值就会静默吞掉**，
   * 现象推迟到几十行之后变成一个 `PROVIDER_NOT_FOUND`，离原因很远。
   */
  check('给插件工具这一段备好了一个可用 provider', pluginProviderSaved === 'ok', String(pluginProviderSaved))

  /**
   * **自己订阅事件**，用独立的数组。
   *
   * 第一版直接读 `window.__agentEvents`，结果是空的 —— 那个订阅是在脚本**更后面**
   * 的 agent 循环段里建立的。于是这一轮真实发生的审批事件我完全看不到，
   * 也就永远没去裁决，运行一直卡到审批超时（现象是「没有任何事件」+ 工具没执行）。
   *
   * 用独立的数组而不是共用：共用会让后面那些**按条数**断言的段落（例如
   * 「假模型确实走了两轮」）因为多了一个监听者而重复计数。
   */
  await evaluate(`
    window.__pluginEvents = []
    window.__pluginUnsub?.()
    window.__pluginUnsub = window.desk.events.onAgent((payload) => window.__pluginEvents.push(payload.event))
    'subscribed'
  `)
  await evaluate(`window.__pluginPrompt = undefined; 'cleared'`)
  /**
   * 发起这一轮，但**不 await 它**。
   *
   * 表达式最后一个语句写成字符串字面量，是为了让 CDP 的 `awaitPromise` 拿到一个
   * 明确的非 Promise 完成值 —— 否则这个 evaluate 会一直等到整轮 run 结束，
   * 而那一轮正卡在审批上等着后面去裁决，于是**自测自己把自己锁死**。
   * （上一版就是这么卡住的：日志停在这一行之后再也没有输出。）
   */
  await evaluate(`
    window.__pluginPrompt = undefined
    window.desk.agent.prompt({
      sessionId: ${JSON.stringify(pluginToolSession)},
      text: '@fixture 帮我调用一次插件工具',
      providerId: ${JSON.stringify(pluginProviderId)},
      modelId: 'mock-model'
    })
      .then((r) => { window.__pluginPrompt = r.ok ? r.data : { error: r.error } })
      .catch((e) => { window.__pluginPrompt = { error: String(e) } })
    'fired'
  `)

  // 等审批卡片出现（插件工具按 write 风险处理）—— 有硬上限，不会挂。
  const pluginApproval = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      for (let i = 0; i < 100; i += 1) {
        const event = (window.__pluginEvents || []).find((e) => e.type === 'approval.requested')
        if (event) return { toolName: event.toolName, args: event.args, danger: event.danger }
        // 这一轮要是已经失败了，没必要继续等：把原因带回去，而不是耗满 25 秒。
        if (window.__pluginPrompt !== undefined) {
          return { toolName: null, promptSettled: window.__pluginPrompt, events: (window.__pluginEvents || []).map((e) => e.type) }
        }
        await wait(250)
      }
      return { toolName: null, timedOut: true, events: (window.__pluginEvents || []).map((e) => e.type) }
    })()
  `)
  check('插件工具调用也走审批（认不出的工具按 write 风险处理）', pluginApproval?.toolName === 'fixture_echo', JSON.stringify(pluginApproval))
  check(
    '模型给的参数原样到达审批处（没在转换里丢）',
    JSON.stringify(pluginApproval?.args ?? '').includes('模型传过去的参数'),
    JSON.stringify(pluginApproval?.args)
  )

  await evaluate(`
    (async () => {
      const event = (window.__pluginEvents || []).find((e) => e.type === 'approval.requested')
      if (event) {
        await window.desk.agent.resolveApproval({
          sessionId: ${JSON.stringify(pluginToolSession)},
          approvalId: event.approvalId,
          decision: 'allow-once'
        })
      }
      return true
    })()
  `)

  // 等这一轮跑完（工具执行 → 结果回传 → 收尾）。有硬上限。
  const pluginWait = await evaluate(`
    new Promise((resolve) => {
      const started = Date.now()
      const tick = () => {
        if (window.__pluginPrompt !== undefined) return resolve('done')
        if (Date.now() - started > 40000) return resolve('timeout')
        setTimeout(tick, 250)
      }
      tick()
    })
  `)
  if (pluginWait !== 'done') {
    console.log(`        NOTE  插件工具这一轮没有正常收尾：${pluginWait}`)
  }

  const pluginRun = await evaluate(`
    (async () => {
      const events = window.__pluginEvents || []
      /**
       * 事件字段名照协议来：tool.started 带的是 name（不是 toolName），
       * 而 tool.finished **根本没有名字**、只有 callId —— 所以要靠 callId 配对。
       * （第一版按 e.toolName 找，于是明明发生了也判成 false。）
       */
      const started = events.find((e) => e.type === 'tool.started' && e.name === 'fixture_echo')
      const finished = events.find((e) => e.type === 'tool.finished' && e.callId === started?.callId)

      /**
       * 工具结果的**权威来源是事件流**（tool.finished.result）。
       *
       * 顺便记一个发现：**落盘的消息里那个 tool-call part 仍停在 pending、没有结果**
       * —— 内核在工具执行**之前**就定稿了那条 assistant 消息，结果到达时只更新了
       * 内存里的 live 状态，没有回写落盘。所以重启后界面上那次调用会一直显示「调用中」。
       * 见下面的「落盘的那份是否也定稿」那条断言。
       */
      const loaded = await window.desk.session.load(${JSON.stringify(pluginToolSession)})
      const messages = loaded.ok ? loaded.data.messages : []
      const parts = messages.flatMap((m) => m.parts)
      const call = parts.find((p) => p.kind === 'tool-call' && p.name === 'fixture_echo')
      const resultText =
        typeof finished?.result === 'string' ? finished.result : JSON.stringify(finished?.result ?? null)
      const finalText = messages
        .filter((m) => m.role === 'assistant')
        .map((m) => m.parts.filter((p) => p.kind === 'text').map((p) => p.text).join(''))
        .join('\\n')

      return {
        callState: call?.state ?? null,
        persistedResult: call?.result ?? null,
        toolStarted: Boolean(started),
        toolFinished: Boolean(finished),
        finishedOk: finished?.ok ?? null,
        failedEvents: events.filter((e) => e.type === 'run.failed').length,
        eventTypes: events.map((e) => e.type),
        toolResult: resultText.slice(0, 400),
        finalText: finalText.slice(-400)
      }
    })()
  `)
  check('模型发起的插件工具调用被宿主执行了', pluginRun?.toolStarted === true && pluginRun?.toolFinished === true, JSON.stringify(pluginRun))
  check('工具调用在消息里定稿为 succeeded', pluginRun?.callState === 'succeeded' && pluginRun?.finishedOk === true, JSON.stringify(pluginRun?.callState))

  check('插件进程真的产出了结果（夹具的字段回来了）', String(pluginRun?.toolResult ?? '').includes('hasElectronRunAsNode'), String(pluginRun?.toolResult))
  /**
   * 这里的匹配要先**反转义**：插件的 JSON 是嵌在工具结果的一个 content part 里，
   * 所以引号在传输中变成了 `\"`。直接找 `"leakedSecret":null` 永远匹配不上 ——
   * 而这会表现成「插件泄漏了密钥」这种**方向完全相反**的假失败。
   */
  const pluginResultText = String(pluginRun?.toolResult ?? '').replace(/\\"/g, '"')
  check('插件没有拿到宿主的敏感环境变量', pluginResultText.includes('"leakedSecret":null'), pluginResultText.slice(0, 200))
  check('模型给的参数原样到了插件进程', pluginResultText.includes('模型传过去的参数'), pluginResultText.slice(0, 200))

  /**
   * 落盘的那一份也必须定稿。
   *
   * 内核在工具**执行之前**就定稿了带 tool-call 的那条消息，结果到达时只更新了内存里的
   * live 状态。于是重启后：界面上那次调用永远停在「调用中」、也看不到结果 ——
   * 用户会以为它还卡着。（这条断言抓出的真实缺陷，修法是 `patchToolCallInSession`。）
   */
  check(
    '工具结果也回写到了落盘的消息（重启后不会停在「调用中」）',
    pluginRun?.callState === 'succeeded' && pluginRun?.persistedResult !== null,
    `落盘的 part 状态=${JSON.stringify(pluginRun?.callState)} result=${JSON.stringify(pluginRun?.persistedResult)?.slice(0, 80)}`
  )
  /**
   * 结果回传模型：收尾正文里带着工具输出（假模型把它摘进了 `已完成` 那句）。
   * 这一条才是「闭环」——工具执行了但结果没回传，模型下一轮就只能瞎猜。
   */
  check(
    '工具结果被回传给模型（收尾正文里带着它）',
    String(pluginRun?.finalText ?? '').includes('已完成：插件工具') && String(pluginRun?.finalText ?? '').includes('hasElectronRunAsNode'),
    String(pluginRun?.finalText).slice(-300)
  )
  check('插件工具这一轮没有失败', pluginRun?.failedEvents === 0, JSON.stringify(pluginRun?.eventTypes))

  // 收尾：退订、删掉这一段的临时 provider（控制面那段会数 provider）。
  await evaluate(`window.__pluginUnsub?.(); window.__pluginUnsub = undefined; 'unsubscribed'`)
  await evaluate(
    `window.desk.provider.remove(${JSON.stringify(pluginProviderId)}).then((r) => (r.ok ? 'ok' : r.error))`
  )

  const disabled = await evaluate(
    `window.desk.plugins.setEnabled(${JSON.stringify(FIXTURE_PLUGIN_ID)}, false).then(r => r.ok ? r.data.enabled : r.error)`
  )
  check('能停用插件', disabled === false, JSON.stringify(disabled))

  const badId = await evaluate(
    `window.desk.plugins.setEnabled('../escape', true).then(r => r.ok ? 'ALLOWED' : r.error.code)`
  )
  check('非法插件 id 被拒（路径校验不能只靠上游）', badId === 'INVALID_PLUGIN_ID', String(badId))

  console.log('\n── 控制面 ──')

  const cpUrl = `http://127.0.0.1:${CP_PORT}`
  const cpStatusBefore = await evaluate('window.desk.controlPlane.status().then(r => r.ok ? r.data : r.error)')
  check('初始状态为未登录', cpStatusBefore?.loggedIn === false, JSON.stringify(cpStatusBefore))

  const badLogin = await evaluate(
    `window.desk.controlPlane.login({ url: ${JSON.stringify(cpUrl)}, username: 'alice', password: 'wrong' })
       .then(r => r.ok ? 'ALLOWED' : r.error.code)`
  )
  check('错误密码被拒（服务端 401 → AUTH_REQUIRED）', badLogin === 'AUTH_REQUIRED', String(badLogin))

  const loggedIn = await evaluate(
    `window.desk.controlPlane.login({ url: ${JSON.stringify(cpUrl)}, username: 'alice', password: 'secret' })
       .then(r => r.ok ? r.data : r.error)`
  )
  check('登录成功并返回用户信息', loggedIn?.loggedIn === true && Boolean(loggedIn?.user?.name), JSON.stringify(loggedIn))

  const syncResult = await evaluate('window.desk.controlPlane.sync().then(r => r.ok ? r.data : r.error)')
  check('同步拿到 1 个 provider', syncResult?.providers === 1, JSON.stringify(syncResult))
  check('同步新增 1 个技能', syncResult?.skills?.added === 1, JSON.stringify(syncResult?.skills))
  check(
    '不合法技能名被跳过并报出来（不静默丢弃）',
    Array.isArray(syncResult?.skills?.skipped) && syncResult.skills.skipped.length === 1,
    JSON.stringify(syncResult?.skills?.skipped)
  )

  const providersAfterSync = await evaluate('window.desk.provider.list().then(r => r.ok ? r.data : r.error)')
  const managed = (providersAfterSync ?? []).find((p) => p.id === 'cp-internal-vllm')
  check('控制面 provider 已落盘', Boolean(managed), JSON.stringify(providersAfterSync?.map((p) => p.id)))
  check('落盘的 provider 标记为控制面来源', managed?.source === 'control-plane', JSON.stringify(managed))

  /**
   * 再同步一次：控制面 provider 必须被**替换**而不是**堆积**。
   * 这是 `source` 字段存在的全部意义 —— 也是上面那条断言抓到的 bug 的真实后果。
   */
  const secondSync = await evaluate('window.desk.controlPlane.sync().then(r => r.ok ? r.data : r.error)')
  const providersAfterSecond = await evaluate('window.desk.provider.list().then(r => r.ok ? r.data : r.error)')
  const cpProviderCount = (providersAfterSecond ?? []).filter((p) => p.source === 'control-plane').length
  check('重复同步不堆积控制面 provider', cpProviderCount === 1, `实际 ${cpProviderCount} 个：${JSON.stringify(providersAfterSecond?.map((p) => p.id))}`)
  check('二次同步把技能计为更新而非新增', secondSync?.skills?.updated === 1 && secondSync?.skills?.added === 0, JSON.stringify(secondSync?.skills))
  check(
    '用户的本地 provider 始终未被触碰',
    (providersAfterSecond ?? []).some((p) => p.id === 'e2e-provider'),
    JSON.stringify(providersAfterSecond?.map((p) => p.id))
  )

  const skillsAfterSync = await evaluate('window.desk.skills.list().then(r => r.ok ? r.data.map(s => s.name) : r.error)')
  check('控制面技能已落盘', Array.isArray(skillsAfterSync) && skillsAfterSync.includes('cp-review-checklist'), JSON.stringify(skillsAfterSync))
  check(
    '同步没有删掉用户手工放的技能',
    Array.isArray(skillsAfterSync) && skillsAfterSync.includes(SKILL_NAME),
    JSON.stringify(skillsAfterSync)
  )

  /**
   * 本轮最有价值的一条：控制面下发的技能有没有**真的被内核加载并进入系统提示**。
   * 必须新建会话 —— 资源在会话建立时加载，老会话不会看到新技能
   * （这正是文档里记着的「技能只在建会话时加载」这条限制）。
   */
  const cpSession = await evaluate(
    `window.desk.session.create({ workspaceId: ${JSON.stringify(workspaceId)} }).then(r => r.ok ? r.data.id : r.error)`
  )
  const cpInspect = await evaluate(
    `window.desk.agent.inspect(${JSON.stringify(cpSession)}).then(r => r.ok ? r.data : r.error)`
  )
  const cpSkillNames = (cpInspect?.skills ?? []).map((s) => s.name)
  check('内核加载了控制面下发的技能', cpSkillNames.includes('cp-review-checklist'), JSON.stringify(cpSkillNames))
  check(
    '控制面技能进了系统提示',
    typeof cpInspect?.systemPrompt === 'string' && cpInspect.systemPrompt.includes('cp-review-checklist'),
    String(cpInspect?.systemPrompt ?? '').slice(0, 300)
  )
  check(
    '同步后默认 provider 切到了控制面下发的那个',
    String(cpInspect?.model ?? '').startsWith('cp-internal-vllm/'),
    String(cpInspect?.model)
  )

  const quota = await evaluate('window.desk.controlPlane.quota().then(r => r.ok ? r.data : r.error)')
  check(
    '能读到配额',
    quota?.usedTokens === 128_400 && quota?.limitTokens === 500_000,
    JSON.stringify(quota)
  )

  const auditBefore = await evaluate('window.desk.controlPlane.flushAudit().then(r => r.ok ? r.data : r.error)')
  check('尚无审计事件时 flush 返回 0', auditBefore?.sent === 0 && auditBefore?.pending === 0, JSON.stringify(auditBefore))

  // ───────────────────── 完整 agent 循环（假模型端点） ─────────────────────

  console.log('\n── agent 循环（对话 → 工具调用 → 审批 → 结果回传） ──')

  /**
   * 审批驱动器工厂。
   *
   * `agent.prompt()` 只在整轮结束时 resolve，而审批发生在**轮次中间**，
   * 所以不能「先 await prompt 再处理审批」—— 那样会一直等到审批超时。
   * 做法是：不 await 地发起 prompt，另起一个轮询去接审批事件。
   *
   * 做成工厂是因为**重启应用后要用同一个逻辑驱动新页面**：
   * 重启会换掉 CDP 连接，但驱动流程不该跟着复制一份 ——
   * 复制出去的那一份迟早会与这份漂移。
   */
  const makeApprovalDriver = (evaluateFn) => async ({ sessionId, text, decision, providerId, modelId }) => {
    // 每一轮都清空事件缓冲：审批事件是**累积**的，不清空的话下一轮会捞到上一轮
    // 那个已经裁决过的审批，然后「拿到审批」但实际什么都没批准 —— 现象是
    // 「审批通过了，文件却没写」，而真实原因是测试驱动自己弄错了对象。
    await evaluateFn('window.__agentEvents = []; window.__promptResult = undefined; true')
    const target = providerId ? `, providerId: ${JSON.stringify(providerId)}` : ''
    const model = modelId ? `, modelId: ${JSON.stringify(modelId)}` : ''
    await evaluateFn(
      `window.desk.agent.prompt({ sessionId: ${JSON.stringify(sessionId)}, text: ${JSON.stringify(text)}${target}${model} })
         .then(r => { window.__promptResult = r.ok ? r.data : { error: r.error } })
         .catch(e => { window.__promptResult = { error: String(e) } }); true`
    )

    // 按 runId 精确定位本轮的审批（而不是「数组里第一个审批」）。
    const approval = await evaluateFn(`
      new Promise((resolve) => {
        const started = Date.now();
        let runId = null;
        const tick = () => {
          const events = window.__agentEvents || [];
          if (!runId) {
            const startedEvent = events.find((e) => e.type === 'run.started');
            if (startedEvent) runId = startedEvent.runId;
          }
          const event = runId
            ? events.find((e) => e.type === 'approval.requested' && e.runId === runId)
            : null;
          if (event) {
            window.desk.agent
              .resolveApproval({ sessionId: ${JSON.stringify(sessionId)}, approvalId: event.approvalId, decision: ${JSON.stringify(decision)} })
              .then(() => resolve(event))
              .catch((error) => resolve({ error: String(error) }));
            return;
          }
          if (Date.now() - started > 25000) return resolve(null);
          setTimeout(tick, 200);
        };
        tick();
      })
    `)

    const result = await evaluateFn(`
      new Promise((resolve) => {
        const started = Date.now();
        const tick = () => {
          if (window.__promptResult !== undefined) return resolve(window.__promptResult);
          if (Date.now() - started > 40000) return resolve({ error: 'timeout' });
          setTimeout(tick, 200);
        };
        tick();
      })
    `)

    return { approval, result }
  }

  await evaluate(`
    window.__agentEvents = [];
    window.desk.events.onAgent((p) => window.__agentEvents.push(p.event));
    true
  `)

  const drive = makeApprovalDriver(evaluate)
  const runPromptWithApproval = (decision) => drive({ sessionId: cpSession, text: '写一个文件', decision })

  // ── 路径一：拒绝 ──
  const denied = await runPromptWithApproval('deny')
  check('模型发起了工具调用并弹出了审批', denied.approval?.toolName === 'write', JSON.stringify(denied.approval))
  check('审批事件带上了差异预览（看得到要写什么才谈得上知情同意）', typeof denied.approval?.previewDiff === 'string', JSON.stringify(denied.approval?.previewDiff)?.slice(0, 200))
  check('拒绝后本轮正常收尾（不是卡住或崩掉）', denied.result?.stopReason === 'end_turn', JSON.stringify(denied.result))
  check(
    '拒绝真的阻止了写入（文件不存在）',
    !existsSync(join(workspaceRoot, 'agent-wrote.txt')),
    '文件竟然被创建了'
  )

  // ── 路径二：放行 ──
  const approved = await runPromptWithApproval('allow-once')
  check('第二轮同样弹出了审批', approved.approval?.toolName === 'write', JSON.stringify(approved.approval))
  check('放行后本轮正常收尾', approved.result?.stopReason === 'end_turn', JSON.stringify(approved.result))
  // 从测试进程直接读盘：这才是「工具真的执行了」的证据，而不是「事件说成功了」。
  const writtenPath = join(workspaceRoot, 'agent-wrote.txt')
  check('放行后文件真的落盘了', existsSync(writtenPath), writtenPath)
  check(
    '落盘内容是模型给的参数',
    existsSync(writtenPath) && readFileSync(writtenPath, 'utf8').includes('written-by-fake-model'),
    existsSync(writtenPath) ? readFileSync(writtenPath, 'utf8') : '(文件不存在)'
  )

  const finalText = await evaluate(`
    (window.__agentEvents || [])
      .filter((e) => e.type === 'message.committed' && e.message.role === 'assistant')
      .map((e) => e.message.parts.filter((p) => p.kind === 'text').map((p) => p.text).join(''))
      .join('\\n')
  `)
  check('流式正文被收到', String(finalText).includes('我先写一个文件'), String(finalText).slice(0, 200))
  check('第二轮模型的收尾正文被收到（说明工具结果回传给了模型）', String(finalText).includes('已完成'), String(finalText).slice(0, 300))

  const turns = (await (await fetch(`${cpUrl}/__received`)).json()).turns ?? []
  check(
    '假模型确实走了两轮（工具调用 → 收尾）',
    turns.filter((t) => t === 'tool-call').length >= 2 && turns.includes('final'),
    JSON.stringify(turns)
  )

  // ── 审计：成功路径也要留痕 ──
  await new Promise((r) => setTimeout(r, 1500))
  await evaluate('window.desk.controlPlane.flushAudit().then(r => r.ok ? r.data : r.error)')
  const receivedAfterLoop = await (await fetch(`${cpUrl}/__received`)).json()
  check(
    '成功的 run 被上报（type=run.completed）',
    (receivedAfterLoop.auditEvents ?? []).some((event) => event.type === 'run.completed'),
    JSON.stringify(receivedAfterLoop.auditEvents?.map((e) => e.type))
  )
  check(
    '用量被上报（token 数来自模型返回的 usage）',
    (receivedAfterLoop.auditEvents ?? []).some((event) => event.type === 'run.completed' && event.inputTokens > 0),
    JSON.stringify(receivedAfterLoop.auditEvents?.find((e) => e.type === 'run.completed'))
  )
  check(
    '审批决定也被审计（tool.approved 与 tool.denied 都在）',
    (receivedAfterLoop.auditEvents ?? []).some((e) => e.type === 'tool.approved') &&
      (receivedAfterLoop.auditEvents ?? []).some((e) => e.type === 'tool.denied'),
    JSON.stringify(receivedAfterLoop.auditEvents?.map((e) => e.type))
  )

  // ── 路径三：模型不可达 ──
  const failedRun = await evaluate(
    `window.desk.agent.prompt({ sessionId: ${JSON.stringify(cpSession)}, text: '这一轮会失败', providerId: 'e2e-provider' })
       .then(r => r.ok ? r.data : { error: r.error })`
  )
  check('模型不可达时 run 正常收尾为失败', failedRun?.stopReason === 'error' || failedRun?.error !== undefined, JSON.stringify(failedRun))

  await new Promise((r) => setTimeout(r, 1500))
  await evaluate('window.desk.controlPlane.flushAudit().then(r => r.ok ? r.data : r.error)')
  const receivedFinal = await (await fetch(`${cpUrl}/__received`)).json()
  check(
    '失败的 run 也被上报（失败同样要留痕）',
    (receivedFinal.auditEvents ?? []).some((event) => event.type === 'run.failed'),
    JSON.stringify(receivedFinal.auditEvents?.map((e) => e.type))
  )
  check(
    '审计事件不含对话内容',
    (receivedFinal.auditEvents ?? []).every((event) => !('messages' in event) && !('content' in event) && !('prompt' in event)),
    JSON.stringify(receivedFinal.auditEvents?.[0])
  )

  const loggedOut = await evaluate('window.desk.controlPlane.logout().then(r => r.ok ? r.data : r.error)')
  check('退出后状态为未登录', loggedOut?.loggedIn === false, JSON.stringify(loggedOut))

  console.log('\n── 差异视图（上下 / 并排） ──')

  /**
   * 这一轮之前目标文件是否已存在 —— 决定预览里**应该**看到删除行还是只有新增行。
   * 夹具的写入内容带递增序号，所以覆盖写时旧内容必须出现在删除行里。
   */
  const wroteFileBeforeDiff = existsSync(join(workspaceRoot, 'agent-wrote.txt'))

  /**
   * 这一轮**走真实输入路径**：在 composer 里打字并回车。
   *
   * 之前的 agent 循环都是直接调 `window.desk.agent.prompt(...)`，而审批卡片渲染在
   * 「界面当前选中的会话」里 —— 直接调 IPC 时界面可能停在别的会话上，卡片自然看不到。
   * 走 composer 还顺带补上了一个覆盖缺口：**输入框此前从未被真实驱动过**。
   */
  const typed = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      // 清空事件缓冲：不清的话下面看到的是前面几轮的历史，判断不出这一轮发生了什么。
      window.__agentEvents = []

      /**
       * 先新建一个会话，再输入。
       *
       * 不能直接用当前会话：它在前面的「模型不可达」那一步被显式设成了 e2e-provider
       * （会话会记住 provider），于是这一轮连模型请求都发不出去，
       * 自然也不会有工具调用与审批卡片。
       *
       * 顺带把侧栏的「新建会话」按钮也走了一遍。
       */
      const newSessionButton = document.querySelector('button[title="新建会话"]')
      if (!newSessionButton) return 'no-new-session-button'
      newSessionButton.click()
      await wait(600)

      const textarea = document.querySelector('textarea')
      if (!textarea) return 'no-composer'
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(textarea, '写一个文件')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      await wait(200)
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return 'sent'
    })()
  `)
  check('能用 composer 发送（Enter）', typed === 'sent', String(typed))

  // 诊断用：这一刻主进程侧的默认 provider / model 是什么。
  const defaultAtSend = await evaluate(
    `window.desk.settings.get().then(r => r.ok ? { provider: r.data.defaultProviderId, model: r.data.defaultModelId } : r.error)`
  )

  // 这一轮之后模型收到的请求（用来看工具集与消息角色）。
  const requestBeforeDiff = (await (await fetch(`${cpUrl}/__received`)).json()).requests?.length ?? 0

  const diffUnified = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      // 等审批卡片出现（它带着 diff）。
      for (let i = 0; i < 60; i += 1) {
        if (document.body.innerText.includes('将要改动的内容')) break
        await wait(250)
      }
      const toggle = document.querySelector('button[title="切换为并排显示"]')
      return {
        cardShown: document.body.innerText.includes('将要改动的内容'),
        /**
         * 整页文本，用来断言**内容**而不只是「有个 diff 区域」。
         *
         * 这一条补的正是那个未验证项真正的缺口：单元测试覆盖了 buildApprovalPreview
         * 这个函数，端到端只断言了「事件里带 previewDiff」「卡片渲染出了 diff」——
         * 但**没人确认过显示的是不是真实的那几行**。而那恰好是审批从
         * 「知情同意」退回「摆设」的分界。
         */
        cardText: document.body.innerText,
        // 卡片在但没有 diff 时界面会退回参数视图 —— 把这一点也报出来，
        // 免得「卡片没渲染」和「没有 diff 可渲染」混成同一个失败原因。
        fellBackToArgs: document.body.innerText.includes('仅允许这一次'),
        hasToggle: Boolean(toggle),
        // 统一视图：每个改动行是独立的一行，没有 w-1/2 的左右格子。
        halfCells: document.querySelectorAll('.w-1\\\\/2').length,
        // 出问题时最想知道的是「这一轮到底发生了什么」。
        events: (window.__agentEvents || []).map((e) => e.type + (e.stopReason ? ':' + e.stopReason : '')).slice(-8)
      }
    })()
  `)
  check('审批卡片里渲染出了 diff', diffUnified?.cardShown === true, JSON.stringify(diffUnified))

  /**
   * 这一版补的四件事，都要在**界面上**看到（而不是只在 store 里）。
   *
   * 它们的共同点：以前都是「用户得自己猜」的地方 ——
   * 等待时不知道在干什么、审批时不知道不点会怎样、会话多了分不清先后、
   * 缺配置时发出去才报错。断言渲染结果才盖得住。
   */
  const uiGaps = await evaluate(`
    (() => {
      const container = document.querySelector('.space-y-5')
      const chatText = container ? container.innerText : ''
      const status = document.querySelector('[data-testid="run-status"]')
      const blocker = document.querySelector('[data-testid="composer-blocker"]')
      const approvalText = (() => {
        const card = document.querySelector('[data-testid="run-status"]')
        return card ? card.innerText : ''
      })()
      return {
        // 思考态：步骤化 + 已用时长（≥10 秒才出现时长，这里只断言步骤那句）
        hasRunStatus: Boolean(status),
        runStatusText: status ? status.innerText.replace(/\\s+/g, ' ').trim() : null,
        // 审批倒计时（在聊天区里找「超时」那句）
        hasCountdown: /还有 \\d+ (分 \\d+ 秒|秒)/.test(chatText) && chatText.includes('超时按「拒绝」处理'),
        // 「包含」看不见重复：说明必须**恰好出现一次**（第一版就重复拼接了）
        countdownNoteCount: (chatText.match(/超时按「拒绝」处理/g) ?? []).length,
        countdownSample: (chatText.match(/还有 [^·]{0,24}秒[^·]{0,40}/) ?? [])[0] ?? null,
        // 会话列表的时间分组
        hasTodayGroup: [...document.querySelectorAll('aside p')].some((p) => (p.innerText || '').trim() === '今天'),
        // 就绪时不该出现「为什么不能发」
        blockerShown: Boolean(blocker),
        blockerText: blocker ? blocker.innerText.replace(/\\s+/g, ' ').trim() : null,
        _unusedApproval: approvalText
      }
    })()
  `)

  check('等待期间有「正在做什么」的状态行（不是只有一个转圈）', uiGaps?.hasRunStatus === true, JSON.stringify(uiGaps))
  check(
    '状态行说的是人话（正在读取/运行/调用 或 正在思考）',
    /正在思考|正在(读取|写入|修改|搜索|查找|列出|运行|调用)|已完成/.test(String(uiGaps?.runStatusText ?? '')),
    String(uiGaps?.runStatusText)
  )
  check(
    '审批卡写明了「不点会怎样」与剩余时间（且说明只出现一次）',
    uiGaps?.hasCountdown === true && uiGaps?.countdownNoteCount === 1,
    JSON.stringify({ countdown: uiGaps?.countdownSample, tail: String(uiGaps?.runStatusText) })
  )
  check('会话列表按时间分了组（今天）', uiGaps?.hasTodayGroup === true, JSON.stringify(uiGaps))
  check(
    '一切都就绪时**不**出现「为什么不能发」的说明行',
    uiGaps?.blockerShown === false,
    JSON.stringify({ blockerText: uiGaps?.blockerText })
  )

  if (diffUnified?.cardShown !== true) {
    // 定位用：这一轮模型收到的请求形状（工具集与角色）。
    const received = await (await fetch(`${cpUrl}/__received`)).json()
    const fresh = (received.requests ?? []).slice(requestBeforeDiff)
    console.log(`        NOTE  本轮模型请求：${JSON.stringify(fresh)}`)
    console.log(`        NOTE  本轮事件：${JSON.stringify(diffUnified?.events)}`)
    console.log(`        NOTE  发送时主进程默认 provider：${JSON.stringify(defaultAtSend)}`)
  }
  check('diff 头部有并排切换按钮', diffUnified?.hasToggle === true, JSON.stringify(diffUnified))
  check('默认是上下排列（没有左右格子）', diffUnified?.halfCells === 0, JSON.stringify(diffUnified?.halfCells))

  const diffText = String(diffUnified?.cardText ?? '')
  check(
    '卡片上显示的是**真实的那几行**（新增行带着模型给的内容，而不只是「有个 diff 区域」）',
    /\+[0-9]*\s*written-by-fake-model/.test(diffText),
    diffText.split('\n').filter((line) => /written-by-fake-model/.test(line)).slice(0, 6).join(' | ')
  )
  check(
    wroteFileBeforeDiff
      ? '覆盖写时，被替换掉的旧内容也出现在删除行里（前后两边都摊开了）'
      : '目标文件此前不存在，所以预览里只有新增行',
    wroteFileBeforeDiff
      ? /-[0-9]*\s*written-by-fake-model/.test(diffText)
      : !/(^|\n)[^\S\n]*-[0-9]*\s/.test(diffText),
    `此前存在=${wroteFileBeforeDiff}；${diffText.split('\n').filter((line) => /written-by-fake-model/.test(line)).slice(0, 6).join(' | ')}`
  )

  const diffSplit = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const toggle = document.querySelector('button[title="切换为并排显示"]')
      if (!toggle) return 'no-toggle'
      toggle.click()
      await wait(400)
      return {
        // 并排后每一行有两个半宽格子。
        halfCells: document.querySelectorAll('.w-1\\\\/2').length,
        backToggle: Boolean(document.querySelector('button[title="切换为上下排列"]'))
      }
    })()
  `)
  check('切换到并排后有左右两列', (diffSplit?.halfCells ?? 0) >= 2, JSON.stringify(diffSplit))
  check('按钮变成「切回上下」', diffSplit?.backToggle === true, JSON.stringify(diffSplit))

  const diffBack = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const toggle = document.querySelector('button[title="切换为上下排列"]')
      if (!toggle) return 'no-toggle'
      toggle.click()
      await wait(400)
      return { halfCells: document.querySelectorAll('.w-1\\\\/2').length }
    })()
  `)
  check('能切回上下排列', diffBack?.halfCells === 0, JSON.stringify(diffBack))

  /**
   * 收尾：**用卡片上的按钮裁决**，而不是直接调 IPC —— 这样顺带验了审批按钮本身。
   * 不裁决的话 run 会一直挂着直到 5 分钟超时。
   */
  const diffCleanup = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const deny = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '拒绝')
      if (!deny) {
        // 把可见按钮报出来，便于定位是文案变了还是卡片没渲染。
        return 'no-deny-button: ' + JSON.stringify([...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean).slice(0, 30))
      }
      deny.click()
      /**
       * 断言**行为结果**而不是具体文案：裁决之后这张卡上不该再有「仅允许这一次」这类
       * 待裁决按钮。用文案（「已处理」）去断言会把它绑在措辞上 —— 改个词测试就红了，
       * 而那并不是行为变化。
       */
      for (let i = 0; i < 40; i += 1) {
        const stillPending = [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '仅允许这一次')
        if (!stillPending) return 'resolved'
        await wait(250)
      }
      return 'not-resolved: ' + JSON.stringify([...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean).slice(0, 20))
    })()
  `)
  check('用卡片上的按钮拒绝后，审批不再处于待裁决状态', diffCleanup === 'resolved', String(diffCleanup))

  /**
   * 同一条事实，**在界面上**也必须成立 —— 上面那条查的是按钮状态，
   * 这一条查那张工具卡自己的状态显示。
   *
   * 真实缺陷正是：数据里是终态，卡片却永远停在「等待中」。原因是消息在
   * **工具还没跑完**时就定稿了（写文件要先问授权），此后状态继续前进，
   * 定稿消息里的那份没人更新，而流式气泡已经清空。
   *
   * 断言的是**不变量**而不是某个具体词：一旦裁决完成，卡片就不该再处于
   * 等待态；具体落在完成 / 失败 / 已拒绝哪个词上，取决于这一轮怎么裁决。
   */
  const toolCardState = await evaluate(`
    (() => {
      const container = document.querySelector('.space-y-5')
      const text = container ? container.innerText : ''
      const terminal = ['完成', '失败', '已拒绝']
      return {
        hasCard: text.includes('write') || text.includes('bash'),
        showsTerminal: terminal.some((word) => text.includes(word)),
        stuck: text.includes('等待中') || text.includes('等待授权'),
        tail: text.replace(/\\s+/g, ' ').slice(-160)
      }
    })()
  `)
  check(
    '裁决并执行完之后，界面上的工具卡不再处于等待态',
    toolCardState?.hasCard === true && toolCardState?.showsTerminal === true && toolCardState?.stuck === false,
    JSON.stringify(toolCardState)
  )



  /**
   * 部分完成汇总（设计稿 §3.4）。
   *
   * 这一段刚刚**拒绝**了一次审批，所以这一轮必然不是「全部成功」——
   * 正好是汇总该出现的时候。断言两件事：先给数字，以及被拒绝的原因写的是
   * 「你拒绝了这次操作」（与「失败」区分开，那是两件不同的事）。
   */
  const runSummaryCheck = await evaluate(`
    (() => {
      const card = document.querySelector('[data-testid="run-summary"]')
      if (!card) return { found: false }
      const text = card.innerText.replace(/\\s+/g, ' ').trim()
      return {
        found: true,
        headline: (text.match(/\\d+ 步里完成了 \\d+ 步/) ?? [])[0] ?? null,
        // 这个场景里只有被拒绝的那一步（0 步成功），所以确定该说「没有产生任何改动」
        saysKept: text.includes('这一步没有产生任何改动'),
        saysKeptWrong: text.includes('已完成的 0 步'),
        saysDenied: text.includes('你拒绝了这次操作'),
        text: text.slice(0, 200)
      }
    })()
  `)
  /**
   * ⚠️ 这里原来写的是 `headline !== null` —— 卡片**不存在**时 headline 是 `undefined`，
   * 而 `undefined !== null` 为真，于是「卡片根本没有」这种情况反而是绿的。
   * 是 A/B（把卡片关掉再跑）把它暴露出来的：那时 4 条断言里只红了 3 条。
   * 现在要求它是一个真的字符串。
   */
  check(
    '部分完成的汇总出现在界面上（先给数字）',
    typeof runSummaryCheck?.headline === 'string' && /步里完成了/.test(runSummaryCheck.headline),
    JSON.stringify(runSummaryCheck)
  )
  check('汇总说明了改动去哪了（零成功时不说「已完成的 0 步」）', runSummaryCheck?.saysKept === true, JSON.stringify(runSummaryCheck))
  check('零成功时不会出现「已完成的 0 步」这种废话', runSummaryCheck?.saysKeptWrong === false, JSON.stringify(runSummaryCheck))
  check('被拒绝的那一步写明是「你拒绝了」（不是「失败」）', runSummaryCheck?.saysDenied === true, JSON.stringify(runSummaryCheck))

  console.log('\n── 等审批时切到别的会话 ──')

  /**
   * 这一节盯的是「审批事件被丢弃」的后果。
   *
   * agent 事件的处理里有一道「只处理当前会话」的守卫（多会话并行时后台事件不该污染
   * 前台视图）。审批事件原来也走同一道守卫，于是出现一个很难受的场景：
   *
   *   用户在等审批时切到别的会话看一眼 → 切回来时 `selectSession` 把 `live` 清空
   *   → **卡片再也回不来了**：既看不到按钮、也无法批准，那个 run 只能安静地等
   *   5 分钟超时被判 deny，而界面上没有任何东西指向原因。
   *
   * 修法是审批**按会话记住**（`pendingApprovals`）：侧栏给出「待确认」指示，
   * 切回来时用事件里那个**真实 runId** 把卡片重新种回 `live`。
   */
  const approvalSessionA = await evaluate(
    `window.desk.session.create({ workspaceId: ${JSON.stringify(workspaceId)}, title: 'e2e-等审批-A' }).then(r => r.ok ? r.data : r.error)`
  )
  const approvalSessionB = await evaluate(
    `window.desk.session.create({ workspaceId: ${JSON.stringify(workspaceId)}, title: 'e2e-等审批-B' }).then(r => r.ok ? r.data : r.error)`
  )
  check('备好两个会话用于「切走再切回」', Boolean(approvalSessionA?.id && approvalSessionB?.id), JSON.stringify([approvalSessionA?.id, approvalSessionB?.id]))

  /** 独立缓冲：不吃别的段落的事件数组（那些数组的生命周期属于它们自己）。 */
  await evaluate(`
    window.__approvalEvents = [];
    window.__approvalUnsub = window.desk.events.onAgent((p) => window.__approvalEvents.push({ sessionId: p.sessionId, event: p.event }));
    true
  `)

  /** 在 A 里发起一轮（**不 await**）：假模型会发起 `write`，于是走到审批。 */
  await evaluate(`
    window.desk.agent.prompt({ sessionId: ${JSON.stringify(approvalSessionA.id)}, text: '写一个文件' })
      .then((r) => { window.__approvalRunResult = r.ok ? r.data : { error: r.error } })
      .catch((e) => { window.__approvalRunResult = { error: String(e) } });
    true
  `)

  const approvalArrived = await evaluate(`
    new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        const found = (window.__approvalEvents || []).find(
          (e) => e.event.type === 'approval.requested' && e.sessionId === ${JSON.stringify(approvalSessionA.id)}
        );
        if (found) return resolve({ approvalId: found.event.approvalId, toolName: found.event.toolName, runId: found.event.runId });
        if (Date.now() - started > 20000) return resolve(null);
        setTimeout(tick, 200);
      };
      tick();
    })
  `)
  check('A 会话发起了审批（此刻前端看的是另一个会话）', approvalArrived?.toolName === 'write', JSON.stringify(approvalArrived))

  /** 切到 A：卡片应当出现在眼前。 */
  const selectA = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const row = [...document.querySelectorAll('aside button[title]')].find(
        (b) => (b.getAttribute('title') ?? '').startsWith('e2e-等审批-A（')
      )
      if (!row) return { error: 'no-row-A' }
      row.click()
      await wait(1200)
      const buttons = [...document.querySelectorAll('button')].map((b) => b.textContent.trim())
      return {
        cardShown: buttons.includes('仅允许这一次'),
        composerBlocked: (document.querySelector('textarea')?.getAttribute('placeholder') ?? '').includes('等待')
      }
    })()
  `)
  check('切到 A 之后审批卡片在（用的是事件里那个真实 runId 种回来的）', selectA?.cardShown === true, JSON.stringify(selectA))
  check('等待裁决期间输入框被挡住（不会让人以为可以直接说话）', selectA?.composerBlocked === true, JSON.stringify(selectA))

  /** 切到 B：卡片消失，但 A 那一行必须有「待确认」指示。 */
  const selectB = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const row = [...document.querySelectorAll('aside button[title]')].find(
        (b) => (b.getAttribute('title') ?? '').startsWith('e2e-等审批-B（')
      )
      if (!row) return { error: 'no-row-B' }
      row.click()
      await wait(1200)
      const buttons = [...document.querySelectorAll('button')].map((b) => b.textContent.trim())
      const marker = document.querySelector('[data-testid="awaiting-approval"]')
      return {
        cardGone: !buttons.includes('仅允许这一次'),
        markerShown: Boolean(marker),
        markerInARow: Boolean(
          document.querySelector('aside button[title^="e2e-等审批-A（"]')?.closest('div')?.parentElement?.querySelector('[data-testid="awaiting-approval"]')
        )
      }
    })()
  `)
  check('切到 B 之后看不到那张卡片（不该串到别的会话里）', selectB?.cardGone === true, JSON.stringify(selectB))
  check('侧栏在**A 那一行**给出「待确认」指示', selectB?.markerShown === true && selectB?.markerInARow === true, JSON.stringify(selectB))

  /** 切回 A 并批准：这一轮必须能走完，文件必须真的落盘。 */
  const wroteBefore = existsSync(join(workspaceRoot, 'agent-wrote.txt'))
    ? readFileSync(join(workspaceRoot, 'agent-wrote.txt'), 'utf8')
    : null

  const backAndApprove = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const row = [...document.querySelectorAll('aside button[title]')].find(
        (b) => (b.getAttribute('title') ?? '').startsWith('e2e-等审批-A（')
      )
      if (!row) return { error: 'no-row-A' }
      row.click()
      await wait(1200)
      const approve = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '仅允许这一次')
      if (!approve) return { error: 'card-not-restored' }
      approve.click()

      // 等这一轮的 run.finished（限时）。
      const started = Date.now()
      while (Date.now() - started < 30000) {
        await wait(300)
        const finished = (window.__approvalEvents || []).some(
          (e) => e.event.type === 'run.finished' && e.sessionId === ${JSON.stringify(approvalSessionA.id)}
        )
        if (finished) return { finished: true, result: window.__approvalRunResult ?? null }
      }
      return { finished: false, result: window.__approvalRunResult ?? null }
    })()
  `)
  check('切回来能重新批准，并且这一轮真的跑完了', backAndApprove?.finished === true, JSON.stringify(backAndApprove))

  const wroteAfter = existsSync(join(workspaceRoot, 'agent-wrote.txt'))
    ? readFileSync(join(workspaceRoot, 'agent-wrote.txt'), 'utf8')
    : null
  check(
    '批准之后工具真的执行了（文件内容变了 —— 夹具每次写入带递增序号）',
    wroteAfter !== null && wroteAfter !== wroteBefore,
    `${JSON.stringify(wroteBefore)} → ${JSON.stringify(wroteAfter)}`
  )
  check('这一轮不是失败的（stopReason 不是 error）', backAndApprove?.result?.stopReason !== 'error', JSON.stringify(backAndApprove?.result))

  await evaluate(`window.__approvalUnsub && window.__approvalUnsub(); true`)

  console.log('\n── 「允许并记住」到底记住了什么 ──')

  /**
   * 这一节要**证伪一句文案**，而不是验证一个功能。
   *
   * 卡片上那个按钮原来写「本会话始终允许」，而白名单的键是
   * `工具名 + JSON.stringify(参数)`（agent-host 的 `approvalFingerprint`）——
   * **参数有一点不同就会再问一次**。写文件几乎每次内容都不一样，所以点了它之后
   * 下一次照样弹卡片：用户的合理理解是「按钮坏了」，而真相是那句话夸大了授予的范围。
   *
   * 处理方式是把**文案改准**（按钮与「已处理」都写清范围），行为本身不动 ——
   * 放宽到「同一工具」对 bash 是危险的，而放宽到「同一文件」需要按路径取键、
   * 且取不到时必须回落到精确参数，那是另一次权限边界改动。
   *
   * 所以这里的断言分成两半：
   *   1. 文案说清了范围（相同参数）；
   *   2. **行为与文案一致** —— 参数不同的下一次调用仍然会问。
   * 第 2 条是这一节的核心：它在将来**放宽**范围时也会立刻变红，提醒同步改文案。
   */
  const rememberSession = await evaluate(
    `window.desk.session.create({ workspaceId: ${JSON.stringify(workspaceId)}, title: 'e2e-记住授权' }).then(r => r.ok ? r.data : r.error)`
  )
  check('备好一个会话用于验「允许并记住」', Boolean(rememberSession?.id), JSON.stringify(rememberSession?.id))

  await evaluate(`
    window.__rememberEvents = [];
    window.__rememberUnsub = window.desk.events.onAgent((p) => {
      if (p.sessionId === ${JSON.stringify(rememberSession?.id ?? '')}) window.__rememberEvents.push(p.event);
    });
    true
  `)

  /** 选中这个会话（它刚建出来，点一下列表里的那一行）。 */
  await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const row = [...document.querySelectorAll('aside button[title]')].find(
        (b) => (b.getAttribute('title') ?? '').startsWith('e2e-记住授权（')
      )
      if (row) { row.click(); await wait(1000) }
      return true
    })()
  `)

  /** 工具：发一轮、等审批、点某个按钮、等这一轮结束。 */
  const driveApprovalRound = async (buttonText) => {
    await evaluate(`
      window.__rememberPromptResult = undefined;
      window.desk.agent.prompt({ sessionId: ${JSON.stringify(rememberSession?.id ?? '')}, text: '写一个文件' })
        .then((r) => { window.__rememberPromptResult = r.ok ? r.data : { error: r.error } })
        .catch((e) => { window.__rememberPromptResult = { error: String(e) } });
      true
    `)
    return await evaluate(`
      (async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        const seen = new Set();
        for (let i = 0; i < 120; i += 1) {
          await wait(250)
          for (const event of window.__rememberEvents || []) {
            if (event.type === 'approval.requested') seen.add(event.approvalId);
          }
          const button = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(buttonText)});
          if (button) {
            /**
             * 观察「已处理：…」的措辞 —— 用 **MutationObserver**，不是轮询。
             *
             * 这张卡属于 live，而 run.finished 会把 live 清空，所以那句话只在一小段窗口里
             * 存在；假模型几毫秒就跑完「执行工具 → 第二轮回话」，窗口可能比一次轮询间隔还短。
             *
             * 我第一版用 150ms 轮询、第二版用 25ms 轮询，都会**偶尔**看不到它 ——
             * 而「偶尔失败」的断言比没有断言更糟（下次它红的时候，没人知道是真回归还是抖动）。
             * MutationObserver 在每次 DOM 变更后触发，只要那句话真的渲染过一帧，就一定被看到。
             *
             * 匹配用正则而不是精确串：JSX 会在「已处理：」与后面的表达式之间留一个空格。
             */
            const resolvedSeen = new Promise((resolve) => {
              const classify = () => {
                const text = document.body.innerText;
                if (/参数相同的调用不再询问/.test(text)) return 'allow-always';
                if (/已处理[：:]\\s*仅允许这一次/.test(text)) return 'allow-once';
                if (/已处理[：:]\\s*拒绝/.test(text)) return 'deny';
                return null;
              };
              const observer = new MutationObserver(() => {
                const verdict = classify();
                if (verdict) {
                  observer.disconnect();
                  resolve(verdict);
                }
              });
              observer.observe(document.body, { childList: true, subtree: true, characterData: true });
              // 兜底：万一那句话压根没渲染，别把这里挂死。
              setTimeout(() => {
                observer.disconnect();
                resolve(classify());
              }, 5000);
            });

            button.click();
            const sawResolved = await resolvedSeen;

            // 再等这一轮收尾。
            for (let j = 0; j < 120; j += 1) {
              await wait(250);
              if ((window.__rememberEvents || []).some((e) => e.type === 'run.finished')) {
                return { clicked: true, approvals: seen.size, finished: true, sawResolved, result: window.__rememberPromptResult ?? null };
              }
            }
            return { clicked: true, approvals: seen.size, finished: false, sawResolved };
          }
        }
        return { clicked: false, approvals: seen.size };
      })()
    `)
  }

  const firstAlways = await driveApprovalRound('本会话内始终允许（相同参数）')
  check('第二轮：卡片上能找到说清范围的那个按钮并点下去', firstAlways?.clicked === true, JSON.stringify(firstAlways))
  check('点了之后这一轮正常收尾', firstAlways?.finished === true, JSON.stringify(firstAlways))
  check(
    '「已处理」里写清了真正授予的范围（裁决后那一小段窗口里能看到）',
    firstAlways?.sawResolved === 'allow-always',
    JSON.stringify(firstAlways)
  )

  const wroteAfterFirst = existsSync(join(workspaceRoot, 'agent-wrote.txt'))
    ? readFileSync(join(workspaceRoot, 'agent-wrote.txt'), 'utf8')
    : null

  /** 第三轮：参数必然不同（夹具每次写入带递增序号）—— 必须**再问一次**。 */
  const secondRound = await driveApprovalRound('仅允许这一次')
  check(
    '参数不同的下一次调用**仍然会问**（与文案一致：记住的是「相同参数」）',
    secondRound?.clicked === true && (secondRound?.approvals ?? 0) >= 1,
    JSON.stringify(secondRound)
  )
  check('第三轮也正常收尾', secondRound?.finished === true, JSON.stringify(secondRound))
  check('第三轮点的是「仅允许这一次」，回执也如实这么写', secondRound?.sawResolved === 'allow-once', JSON.stringify(secondRound))

  const wroteAfterSecond = existsSync(join(workspaceRoot, 'agent-wrote.txt'))
    ? readFileSync(join(workspaceRoot, 'agent-wrote.txt'), 'utf8')
    : null
  check(
    '两次都真的写了（内容不同，所以第二次才需要重新授权）',
    wroteAfterFirst !== null && wroteAfterSecond !== null && wroteAfterFirst !== wroteAfterSecond,
    `${JSON.stringify(wroteAfterFirst)} → ${JSON.stringify(wroteAfterSecond)}`
  )

  await evaluate(`window.__rememberUnsub && window.__rememberUnsub(); true`)

  console.log('\n── 中止（Stop）：跑飞时的唯一安全阀 ──')

  /**
   * 「中止」此前**一条断言都没有**。而它是 agent 跑飞时唯一的出口，
   * 实现里还藏着一处很微妙的顺序要求：
   *
   * > 必须**先把待裁决的审批判 deny，再 `pi.abort()`**。
   * > 因为 `_beforeToolCall` 正在 await 我们的审批 promise，
   * > 而 `session.abort()` 会等会话进入 idle —— 反过来的话两者互等，
   * > 一直卡到 5 分钟审批超时才解开。
   *
   * 所以这里刻意**让运行卡在审批上**再中止，而且断言**必须有时间上限**：
   * 20 秒内没结束就说明顺序错了。没有上限的断言会「等到超时也算过」，验不出这个 bug。
   */
  const abortStart = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const ta = () => document.querySelector('textarea')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      window.__agentEvents = []
      for (let i = 0; i < 40 && ta().value !== ''; i += 1) await wait(250)
      setter.call(ta(), '这一轮我要中止掉')
      ta().dispatchEvent(new Event('input', { bubbles: true }))
      await wait(250)
      ta().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      for (let i = 0; i < 80; i += 1) {
        const pending = [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '仅允许这一次')
        if (pending) {
          return { pending: true, stopButton: Boolean(document.querySelector('button[title="中止"]')) }
        }
        await wait(250)
      }
      return { pending: false }
    })()
  `)
  check('中止前：运行确实卡在待审批状态', abortStart?.pending === true, JSON.stringify(abortStart))
  check('中止前：界面上有「中止」按钮', abortStart?.stopButton === true, JSON.stringify(abortStart))

  const abortOutcome = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const pending = () => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '仅允许这一次')
      const busy = () => Boolean(document.querySelector('button[title="中止"]'))

      const stop = document.querySelector('button[title="中止"]')
      if (!stop) return { error: 'no-stop-button' }

      const started = Date.now()
      stop.click()
      for (let i = 0; i < 80; i += 1) {
        await wait(250)
        if (!pending() && !busy()) {
          return {
            elapsedMs: Date.now() - started,
            pendingCleared: true,
            noticeShown: document.body.innerText.includes('本次运行已被你中止'),
            stopReasons: (window.__agentEvents || [])
              .filter((e) => e.type === 'run.finished')
              .map((e) => e.stopReason),
            /**
             * 中止**不该**产生 run.failed。
             *
             * 这条是这轮补上的：用户中止会让在途请求断开，provider 于是报一个连接错误。
             * 早先的判据把 provider 报错排在「中止」前面，于是这一轮被记成失败 ——
             * 审计里「用户主动停止」看起来像「模型调用失败」，
             * 而界面因为拿到的是 error 而不是 aborted，**连「已中止」提示都不显示**。
             */
            failedEvents: (window.__agentEvents || []).filter((e) => e.type === 'run.failed').length
          }
        }
      }
      return { elapsedMs: Date.now() - started, timedOut: true, tail: document.body.innerText.slice(-500) }
    })()
  `)
  check('中止后 20 秒内就结束（没卡到 5 分钟审批超时）', abortOutcome?.timedOut !== true, JSON.stringify(abortOutcome))
  check('中止清掉了待裁决的审批', abortOutcome?.pendingCleared === true, JSON.stringify(abortOutcome))
  check('运行以 aborted 结束（而不是 error / end_turn）', (abortOutcome?.stopReasons ?? []).includes('aborted'), JSON.stringify(abortOutcome?.stopReasons))
  check('中止不被记成失败（否则审计里「主动停止」会像「模型调用失败」）', abortOutcome?.failedEvents === 0, JSON.stringify(abortOutcome?.failedEvents))
  check('界面提示「本次运行已被你中止」', abortOutcome?.noticeShown === true, JSON.stringify(abortOutcome))

  console.log('\n── 输入框历史记录（上下键） ──')

  /**
   * **自给自足**：新建一个会话，在里面连发两条，再验翻历史。
   *
   * 第一版依赖「上一段（差异视图）刚发过一条」，结果那个会话其实不是我以为的那个、
   * 里面只有一条消息，于是所有断言都成了对单元素历史的行为断言 —— 看起来像实现坏了，
   * 实际是测试假设错了。**测试自己造状态**比复用上游留下的状态可靠得多。
   */
  const historySetup = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const ta = () => document.querySelector('textarea')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      const pending = () => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '仅允许这一次')

      const waitEmpty = async () => {
        for (let i = 0; i < 40 && ta().value !== ''; i += 1) await wait(250)
        return ta().value === ''
      }

      const send = async (text) => {
        if (!(await waitEmpty())) return 'not-cleared:' + ta().value
        setter.call(ta(), text)
        ta().dispatchEvent(new Event('input', { bubbles: true }))
        await wait(250)
        ta().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        // 这一轮的假模型会发起工具调用 → 弹审批 → 用卡片上的按钮拒绝收尾。
        for (let i = 0; i < 80; i += 1) {
          const deny = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '拒绝')
          if (deny) {
            deny.click()
            for (let j = 0; j < 40; j += 1) {
              await wait(250)
              if (!pending()) return 'ok'
            }
            return 'not-resolved'
          }
          await wait(250)
        }
        return 'no-approval'
      }

      const newSession = document.querySelector('button[title="新建会话"]')
      if (!newSession) return 'no-new-session-button'
      newSession.click()
      await wait(700)

      const first = await send('第一条历史')
      const second = await send('第二条历史')
      return { first, second }
    })()
  `)
  check('历史夹具：第一条发送成功', historySetup?.first === 'ok', JSON.stringify(historySetup))
  check('历史夹具：第二条发送成功', historySetup?.second === 'ok', JSON.stringify(historySetup))

  /**
   * 用 **CDP 真实按键**驱动历史浏览，而不是 `new KeyboardEvent(...)`。
   *
   * 合成事件在 React 19 下表现不同（离散事件的优先级与批处理时机），
   * 会让「连续两次上键」看起来像状态没更新 —— 而真实用户按下的是浏览器产生的按键。
   * 既然要验的是用户路径，就用真实按键。
   */
  const pressKey = async (key) => {
    const code = key === 'ArrowUp' ? 38 : 40
    await client.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key,
      code: key,
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code
    })
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code: key,
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code
    })
    await new Promise((r) => setTimeout(r, 350))
    return evaluate(`document.querySelector('textarea').value`)
  }

  await evaluate(`document.querySelector('textarea').focus(); true`)
  const startValue = await evaluate(`document.querySelector('textarea').value`)
  check('翻历史前输入框是空的', startValue === '', JSON.stringify(startValue))

  const navSteps = []
  for (const key of ['ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown']) {
    navSteps.push(`${key}=${JSON.stringify(await pressKey(key))}`)
  }

  /**
   * 「一条消息只出现一次」——这个自测顺带抓出过一个真实缺陷：
   * 主进程把用户消息落库两次（prompt 时一次、内核回显 `message.committed` 时又一次），
   * 渲染层又把 session 事件与 agent 事件**两条通道**都追加进同一个数组，
   * 于是聊天区里用户消息出现三遍、助手消息两遍，会话文件也在变胖。
   *
   * 所以这里把「条数」也断言下来 —— 光看功能不看条数，这类重复可以一直藏着。
   */
  const messageCounts = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      await wait(500)
      // 聊天区（不含左侧会话栏，栏里也会显示标题文本）。
      const chat = document.querySelector('textarea')?.closest('.shrink-0')?.parentElement
      const transcript = chat ? chat.innerText : ''
      const count = (needle) => transcript.split(needle).length - 1

      // 落库的那份（磁盘上的会话）也数一遍。
      const list = await window.desk.session.list()
      const target = list.ok ? list.data.find((s) => s.title === '第一条历史') : null
      let persisted = null
      if (target) {
        const loaded = await window.desk.session.load(target.id)
        if (loaded.ok) {
          const users = loaded.data.messages.filter((m) => m.role === 'user')
          persisted = {
            userCount: users.length,
            texts: users.map((m) => m.parts.filter((p) => p.kind === 'text').map((p) => p.text).join(''))
          }
        }
      }
      return {
        firstInTranscript: count('第一条历史'),
        secondInTranscript: count('第二条历史'),
        persisted
      }
    })()
  `)
  check(
    '落库的用户消息正好两条（不是每条存三遍）',
    messageCounts?.persisted?.userCount === 2,
    JSON.stringify(messageCounts?.persisted)
  )
  check(
    '聊天区里每条消息只出现一次',
    messageCounts?.firstInTranscript === 1 && messageCounts?.secondInTranscript === 1,
    JSON.stringify(messageCounts)
  )
  check('上键翻出最近一条', navSteps[0] === 'ArrowUp="第二条历史"', JSON.stringify(navSteps))
  check('再按上键翻到更早一条', navSteps[1] === 'ArrowUp="第一条历史"', JSON.stringify(navSteps))
  check('已在最旧一条时停住（不绕回最新）', navSteps[2] === 'ArrowUp="第一条历史"', JSON.stringify(navSteps))
  check('下键翻回较新一条', navSteps[3] === 'ArrowDown="第二条历史"', JSON.stringify(navSteps))
  check('翻过最新一条回到空草稿', navSteps[4] === 'ArrowDown=""', JSON.stringify(navSteps))

  const draftGuard = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const ta = () => document.querySelector('textarea')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta(), '我正在写的草稿')
      ta().dispatchEvent(new Event('input', { bubbles: true }))
      await wait(300)
      return ta().value
    })()
  `)
  const duringUp = await pressKey('ArrowUp')
  const afterDown = await pressKey('ArrowDown')
  check('草稿在翻历史期间被暂存', draftGuard === '我正在写的草稿' && duringUp === '第二条历史', `${draftGuard} → ${duringUp}`)
  check('翻回底部时草稿被还回来', afterDown === '我正在写的草稿', JSON.stringify(afterDown))

  /**
   * 侧栏行数必须等于会话数。
   *
   * 同一个会话有两条路径会进列表（主进程的 `created` 广播 + `newSession()` 的显式插入），
   * 顺序不保证，所以曾经有可能出现两份。这条不变式守的是「无论如何都只有一份」。
   */
  const duplicateCheck = await evaluate(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const button = document.querySelector('button[title="新建会话"]')
      // 连按三次：把「广播与返回值两条路径」多走几遍。
      for (let i = 0; i < 3; i += 1) {
        if (button) button.click()
        await wait(500)
      }
      const listed = await window.desk.session.list()
      return {
        listed: listed.ok ? listed.data.length : -1,
        rows: document.querySelectorAll('aside li').length
      }
    })()
  `)
  check(
    '侧栏行数与会话数一致（新建不会重复插入）',
    duplicateCheck?.rows === duplicateCheck?.listed && duplicateCheck.listed > 0,
    JSON.stringify(duplicateCheck)
  )

  console.log('\n── 终端（PTY） ──')

  /**
   * 终端验证走的是**真实 shell**：起一个 PTY，往里写一条 echo，等回显。
   * 这同时证明了四件事：原生模块 ABI 对、PTY 能 spawn、数据事件能穿过 IPC、
   * 以及输出能在渲染层被观察到。
   */
  const probe = await evaluate('window.desk.terminal.probe().then(r => r.ok ? r.data : r.error)')
  check('terminal.probe 可用（node-pty 原生模块加载成功）', probe?.available === true, JSON.stringify(probe))

  if (probe?.available) {
    /**
     * 「销毁」不能只看会话列表 —— 必须确认**操作系统层面的 shell 进程真的没了**。
     * 僵尸 shell 恰恰是只看列表时最容易漏掉的问题：列表空了，任务管理器里却在堆积。
     */
    const countShells = () => {
      if (process.platform !== 'win32') return null
      try {
        const out = execSync('tasklist /FI "IMAGENAME eq cmd.exe" /FO CSV /NH', { encoding: 'utf8' })
        return out.split('\n').filter((line) => line.toLowerCase().includes('cmd.exe')).length
      } catch {
        return null
      }
    }
    const shellsBefore = countShells()

    // 先挂数据收集器，再创建会话 —— 反过来会漏掉启动横幅。
    await evaluate(`
      window.__termData = [];
      window.__termExit = null;
      window.desk.events.onTerminalData((p) => window.__termData.push(p));
      window.desk.events.onTerminalExit((p) => { window.__termExit = p; });
      true
    `)

    const createdTerm = await evaluate(
      `window.desk.terminal.create({ cols: 90, rows: 24, cwd: ${JSON.stringify(workspaceRoot)} })
         .then(r => r.ok ? r.data : r.error)`
    )
    check('能创建终端会话', typeof createdTerm?.id === 'string', JSON.stringify(createdTerm))
    check('会话回显了 cwd', createdTerm?.cwd === workspaceRoot, JSON.stringify(createdTerm))

    const termId = createdTerm?.id
    const marker = `IPI_TERM_${Date.now()}`

    await evaluate(`window.desk.terminal.write(${JSON.stringify(termId)}, "echo ${marker}\\r").then(r => r.ok)`)
    await evaluate(`window.desk.terminal.resize(${JSON.stringify(termId)}, 120, 30).then(r => r.ok)`)

    // 轮询等回显：ConPTY 下 shell 启动 + echo 往返通常 <1s，给 15s 余量。
    const echoed = await evaluate(`
      new Promise((resolve) => {
        const started = Date.now();
        const tick = () => {
          const joined = (window.__termData || []).map((p) => p.data).join('');
          if (joined.includes(${JSON.stringify(marker)})) return resolve('FOUND');
          if (Date.now() - started > 15000) return resolve('TIMEOUT:' + joined.slice(-200));
          setTimeout(tick, 200);
        };
        tick();
      })
    `)
    check('PTY 输出经 IPC 回到渲染层（marker 回显）', echoed === 'FOUND', String(echoed))

    const frames = await evaluate('(window.__termData || []).length')
    check('输出被合并成少量帧（不是逐字节）', typeof frames === 'number' && frames > 0 && frames < 200, `帧数=${frames}`)

    const listed = await evaluate('window.desk.terminal.list().then(r => r.ok ? r.data : r.error)')
    check('terminal.list 能看到该会话', Array.isArray(listed) && listed.includes(termId), JSON.stringify(listed))

    await evaluate(`window.desk.terminal.dispose(${JSON.stringify(termId)}).then(r => r.ok)`)
    const afterDispose = await evaluate('window.desk.terminal.list().then(r => r.ok ? r.data : r.error)')
    check('销毁后会话已回收', Array.isArray(afterDispose) && !afterDispose.includes(termId), JSON.stringify(afterDispose))

    const badWrite = await evaluate(
      `window.desk.terminal.write('does-not-exist', 'x').then(r => r.ok ? 'ALLOWED' : r.error.code)`
    )
    check('向不存在的会话写入返回错误码', badWrite === 'TERMINAL_NOT_FOUND', String(badWrite))

    /**
     * 等 shell 进程数回落到基线，最多等 `timeoutMs`。
     *
     * 原来这里是「固定等 1200ms 再比一次」，那是个**竞态**：`TerminateProcess` 到进程
     * 真的从 tasklist 消失有延迟，而这个延迟受机器负载影响 —— 在同一轮里刚做过
     * 全新构建时就会超时，于是断言失败，但产品其实没问题。
     *
     * 轮询到截止时间保留了断言的**本意**（进程最终必须消失），只是不再把它变成
     * 一场和调度器的赛跑。
     */
    const waitForShellsToSettle = async (baseline, timeoutMs = 8000) => {
      const deadline = Date.now() + timeoutMs
      let latest = countShells()
      while (Date.now() < deadline) {
        if (latest !== null && baseline !== null && latest <= baseline) return latest
        await new Promise((r) => setTimeout(r, 400))
        latest = countShells()
      }
      return latest
    }

    const shellsAfter = await waitForShellsToSettle(shellsBefore)
    if (shellsBefore === null || shellsAfter === null) {
      console.log('  SKIP  shell 进程数对比（当前平台不支持 tasklist）')
    } else {
      check(
        '销毁后没有残留 shell 进程',
        shellsAfter <= shellsBefore,
        `创建前 cmd.exe=${shellsBefore}，销毁后=${shellsAfter}（已轮询等待 8s）`
      )
    }
  }

  console.log('\n── 终端：界面上的新建 / 关标签 / 收起面板 ──')

  /**
   * 上面那一段走的是 **IPC 直调**。但用户碰的是界面上的按钮，
   * 而界面上有一条**只有它才会走的路径**：关掉标签 / 收起面板时要顺手收掉 PTY。
   *
   * 漏收的后果不是「列表里多一条」，而是**任务管理器里堆积的 cmd.exe** ——
   * 正是僵尸 shell 那类问题。所以这几条断言既看会话列表，也数系统进程。
   */
  if (probe?.available) {
    const countShells = () => {
      if (process.platform !== 'win32') return null
      try {
        const out = execSync('tasklist /FI "IMAGENAME eq cmd.exe" /FO CSV /NH', { encoding: 'utf8' })
        return out.split('\n').filter((line) => line.toLowerCase().includes('cmd.exe')).length
      } catch {
        return null
      }
    }
    const settle = async (baseline, timeoutMs = 8000) => {
      const deadline = Date.now() + timeoutMs
      let latest = countShells()
      while (Date.now() < deadline) {
        if (latest !== null && baseline !== null && latest <= baseline) return latest
        await new Promise((r) => setTimeout(r, 400))
        latest = countShells()
      }
      return latest
    }

    // 先确保终端面板是打开的（表头那个开关）。
    await evaluate(`
      (() => {
        const toggle = document.querySelector('button[title^="终端"]')
        if (toggle && !document.querySelector('button[title="新建终端"]')) toggle.click()
        return true
      })()
    `)
    await new Promise((r) => setTimeout(r, 600))

    const shellsBeforeUi = countShells()

    /**
     * 打开面板时的基线。
     *
     * 面板**自带来一个终端**（打开就能直接用，而不是先点「新建」），
     * 所以这里不能用「2 个标签」这类绝对值 —— 那是把「自带一个」这个行为
     * 当成不存在。用相对断言，顺便把「自带一个」也锁住。
     */
    const baseline = await evaluate(`
      (async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        /**
         * 轮询等面板挂载：终端面板现在**按需加载**（xterm ≈ 414 KB），
         * 固定等待在慢机器上会变成随机失败，而它想验的只是「最终会出来」。
         */
        const deadline = Date.now() + 8000
        while (Date.now() < deadline && !document.querySelector('.xterm')) await wait(200)
        const sessions = await window.desk.terminal.list()
        return {
          tabs: document.querySelectorAll('button[title="关闭终端"]').length,
          listed: sessions.ok ? sessions.data.length : -1,
          // xterm 的 CSS 也在按需 chunk 里。只验 DOM 有没有 .xterm 是不够的 ——
          // 节点在、样式没到，终端会渲染成一堆没有布局的乱码。
          xtermCssApplied: (() => {
            const node = document.querySelector('.xterm')
            if (!node) return false
            const style = getComputedStyle(node)
            return style.position === 'relative' && style.userSelect === 'none'
          })()
        }
      })()
    `)
    check('打开终端面板就自带一个终端（不用先点新建）', baseline?.tabs === 1, JSON.stringify(baseline))
    check('xterm 的样式随按需 chunk 一起生效（不是只有 DOM）', baseline?.xtermCssApplied === true, JSON.stringify(baseline))

    /**
     * 运行时证据：终端 chunk 是**打开终端时**才取的。
     *
     * 与编辑器那条同理 —— 产物拆了不等于运行时真的按需取；
     * 反过来「用了但其实在主 chunk 里」也要能拦住。
     */
    const terminalChunkFetched = networkRequests.filter((url) => /TerminalPanel-/.test(url)).length
    check('打开终端时才去取终端 chunk（运行时证据）', terminalChunkFetched >= 1, `匹配 ${terminalChunkFetched} 个请求（共记录 ${networkRequests.length} 个）`)

    // 用界面按钮再建一个：一个标签不够验「关掉一个还剩一个」。
    const createdViaUi = await evaluate(`
      (async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        const button = document.querySelector('button[title="新建终端"]')
        if (!button) return { error: 'no-new-terminal-button' }
        button.click()
        await wait(1500)
        const sessions = await window.desk.terminal.list()
        return {
          tabCount: document.querySelectorAll('button[title="关闭终端"]').length,
          listed: sessions.ok ? sessions.data.length : -1
        }
      })()
    `)
    check('界面上的「新建终端」能再开一个', createdViaUi?.tabCount === 2 && createdViaUi?.listed === 2, JSON.stringify(createdViaUi))

    const closedOne = await evaluate(`
      (async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        const close = document.querySelector('button[title="关闭终端"]')
        if (!close) return { error: 'no-close-button' }
        close.click()
        await wait(1500)
        const sessions = await window.desk.terminal.list()
        return {
          tabs: document.querySelectorAll('button[title="关闭终端"]').length,
          listed: sessions.ok ? sessions.data.length : -1
        }
      })()
    `)
    check('关掉一个标签后还剩一个', closedOne?.tabs === 1, JSON.stringify(closedOne))
    check('关标签顺手收掉了对应的 PTY 会话', closedOne?.listed === 1, JSON.stringify(closedOne))

    // 收起整个面板：剩下的那个也必须被收掉（这是卸载时的第二处清理）。
    const panelClosed = await evaluate(`
      (async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        const close = document.querySelector('button[title="收起终端"]')
        if (!close) return { error: 'no-collapse-button' }
        close.click()
        await wait(1500)
        const sessions = await window.desk.terminal.list()
        return {
          panelGone: !document.querySelector('button[title="收起终端"]'),
          listed: sessions.ok ? sessions.data.length : -1
        }
      })()
    `)
    check('收起面板后终端面板确实消失', panelClosed?.panelGone === true, JSON.stringify(panelClosed))
    check('收起面板收掉了剩下的终端', panelClosed?.listed === 0, JSON.stringify(panelClosed))

    const shellsAfterUi = await settle(shellsBeforeUi)
    if (shellsBeforeUi === null || shellsAfterUi === null) {
      console.log('  SKIP  界面路径的 shell 进程数对比（当前平台不支持 tasklist）')
    } else {
      check(
        '界面关掉的终端没有留下 shell 进程',
        shellsAfterUi <= shellsBeforeUi,
        `界面操作前 cmd.exe=${shellsBeforeUi}，全部关掉后=${shellsAfterUi}（已轮询等待 8s）`
      )
    }
  }

  console.log('\n── 重启应用后：内核还记得之前的对话吗 ──')

  /**
   * 为什么单独做一次真重启。
   *
   * 会话消息由主进程落盘，而内核的 `SessionManager` 是内存的。
   * 不把落盘历史喂回内核，就会出现最影响日常使用的那个问题：
   * **界面上历史都在，模型完全不记得** —— 追问一句「继续改刚才那个函数」，
   * 得到的是「哪个函数？」。而这恰恰是每天第一次打开应用必然发生的事。
   */
  const requestsBeforeRestart =
    (await (await fetch(`${cpUrl}/__received`)).json()).requests?.length ?? 0

  /**
   * 先把窗口改成一个有辨识度的尺寸，用来验证「重启后尺寸被记住」。
   *
   * 走不了 `Browser.setWindowBounds`：Electron 的调试端点没有实现 Browser 域
   * （实测报 `'Browser.getWindowForTarget' wasn't found`）。所以分两步验，
   * 反而比强行改窗口更接近真实路径：
   *
   *  1. **正常关闭**窗口（`window.close()`，而不是 taskkill）→ 走我们的 close 钩子
   *     → 断言 `window-state.json` 被写出来。强杀不会触发 close 钩子，
   *     所以这一步必须用正常退出，它验的正是「保存」那一半。
   *  2. 把文件改写成有辨识度的尺寸，再启动 → 断言窗口真的按它打开。
   *     这一步验的是**恢复**那一半，也就是真正有逻辑风险的地方
   *     （保存的位置可能来自一块已经拔掉的显示器）。
   */
  const RESIZED = { width: 1040, height: 720 }

  /**
   * 长会话夹具：**在重启前**写进 sessions 目录，重启后的应用才会读到它。
   *
   * 为什么不放在文件开头的夹具区：那样开机就会选中这个 60 条的会话，
   * 而靠前的若干段断言的是「空状态」（起手任务、打招呼）。种在重启前既拿到了长会话，
   * 又不打扰开机状态 —— 而断言放在重启后（用新的 CDP 连接，见 §15.21）。
   *
   * updatedAt 刻意设成很早：让它在会话列表里排在后面，不抢别的段落用到的会话。
   */
  const LONG_SESSION_ID = 'e2e-long-session'
  mkdirSync(join(userData, 'sessions'), { recursive: true })
  writeFileSync(
    join(userData, 'sessions', `${LONG_SESSION_ID}.json`),
    JSON.stringify(
      {
        session: {
          id: LONG_SESSION_ID,
          workspaceId: 'e2e-workspace',
          title: 'e2e-长会话（60 条）',
          createdAt: new Date(Date.now() - 7_200_000).toISOString(),
          updatedAt: new Date(Date.now() - 7_200_000).toISOString(),
          messageCount: 60
        },
        messages: Array.from({ length: 60 }, (_, index) => ({
          id: `long-${index}`,
          role: index % 2 === 0 ? 'user' : 'assistant',
          createdAt: new Date(Date.now() - (60 - index) * 60_000).toISOString(),
          parts: [{ kind: 'text', text: `第 ${index + 1} 条消息` }]
        }))
      },
      null,
      2
    ),
    'utf8'
  )

  await evaluate('window.close(); true')
  const exitedCleanly = await waitForPortFree(8000)
  if (!exitedCleanly) {
    console.log('  NOTE  正常关闭未在 8s 内生效，回退到强杀（尺寸恢复断言仍会执行）')
    killTree(child)
    await waitForPortFree()
  }

  const boundsFile = join(userData, 'window-state.json')
  check('正常关闭后窗口尺寸被落盘（强杀不会触发这个钩子）', existsSync(boundsFile), boundsFile)

  const savedBounds = existsSync(boundsFile) ? JSON.parse(readFileSync(boundsFile, 'utf8')) : null
  check(
    '落盘的尺寸是合法数值',
    Number.isFinite(savedBounds?.width) && savedBounds.width >= 900 && Number.isFinite(savedBounds?.height),
    JSON.stringify(savedBounds)
  )

  // 改写成有辨识度的尺寸，下一次启动应当按它打开。
  writeFileSync(boundsFile, JSON.stringify(RESIZED), 'utf8')

  spawnApp()
  const restartedTarget = await waitForTarget()
  const restartedClient = await connect(restartedTarget.webSocketDebuggerUrl)
  await restartedClient.send('Runtime.enable', {})
  await new Promise((r) => setTimeout(r, 3000))

  const evaluate2 = async (expression) => {
    const result = await restartedClient.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate 失败')
    }
    return result.result.value
  }

  // ───────────────────────── 长会话：渲染窗口（重启后，用新连接）─────────────────────────

  console.log('\n── 长会话：只渲染最近 N 条 ──')

  /**
   * 规则本身由单测覆盖（lib/message-window.ts，10 条）。这里验**真界面**：
   * 那个 60 条的会话只渲染最近 40 条，展开后给全部。
   *
   * ⚠️ 这一段必须用 `evaluate2`（重启后的连接）。上一轮它用重启前的 `evaluate`
   * 放在重启之后 —— 对一条已断的连接 await 永远不会返回，自测停在这里直到超时，
   * 而两次运行停在完全相同的日志行数上（详见 §15.21 与 HANDOVER 的坑表）。
   */
  /**
   * 先把视口设宽。
   *
   * 重启那一段**故意**把窗口设成 1040×720（验「尺寸被记住」），而 1040 已经低于
   * 紧凑侧栏的阈值（1080）—— 于是重启后侧栏是图标条，里面**没有会话列表**，
   * 按行选择会以 `no-row` 失败，而失败信息完全指不到「界面正处于紧凑模式」。
   * 这里显式把视口设宽，让这一节不依赖段序。
   */
  await restartedClient.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 840,
    deviceScaleFactor: 1,
    mobile: false,
    scale: 1
  })
  await new Promise((r) => setTimeout(r, 700))

  const longSelected = await evaluate2(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    // title 前缀 + 文本兜底：会话行的 title 形态在不同段落里见过两种，
    // 只按其中一种匹配会在别的段落改动后突然失效（失败信息只有 no-row）。
    const row = [...document.querySelectorAll('aside button')].find((b) => {
      const title = b.getAttribute('title') || ''
      return title.startsWith('e2e-长会话') || b.textContent.includes('长会话')
    })
    if (!row) return 'no-row'
    row.click()
    await wait(1500)
    return 'ok'
  })()`)
  check('能打开那个 60 条的会话', longSelected === 'ok', String(longSelected))

  const windowState = await evaluate2(`(() => {
    return {
      rendered: document.querySelectorAll('[data-testid="message-parts"]').length,
      button: (() => {
        const el = document.querySelector('[data-testid="show-earlier"]')
        return el ? el.innerText.trim() : null
      })()
    }
  })()`)
  check('只渲染最近 40 条（不是 60 条全渲染）', windowState?.rendered === 40, JSON.stringify(windowState))
  check(
    '折叠提示写明还有多少条（60 - 40 = 20）',
    String(windowState?.button ?? '').includes('20'),
    JSON.stringify(windowState)
  )

  const expandedState = await evaluate2(`(async () => {
    const button = document.querySelector('[data-testid="show-earlier"]')
    if (button) button.click()
    await new Promise((r) => setTimeout(r, 800))
    return {
      rendered: document.querySelectorAll('[data-testid="message-parts"]').length,
      button: Boolean(document.querySelector('[data-testid="show-earlier"]'))
    }
  })()`)
  check('点开后渲染全部 60 条', expandedState?.rendered === 60, JSON.stringify(expandedState))
  check('展开后折叠提示消失', expandedState?.button === false, JSON.stringify(expandedState))

  // ───────────────────────── 窄窗口：侧栏折叠成图标条 ─────────────────────────

  console.log('\n── 窄窗口：侧栏折叠成图标条 ──')

  /**
   * 用 CDP 改**视口**来模拟窄窗口（改真实窗口尺寸走不通：Electron 的调试端点没有 Browser 域）。
   *
   * ⚠️ `scale` 必须显式给 1：不给的话 Chrome 会按 deviceScaleFactor 缩放整页，
   * 之前量边框时就因此读到过 0.666667px（见 HANDOVER 的坑表）。
   */
  const setViewport = (width, height) =>
    restartedClient.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
      scale: 1
    })

  await setViewport(960, 800)
  await new Promise((r) => setTimeout(r, 600))

  const narrowState = await evaluate2(`(() => {
    const rail = document.querySelector('[data-testid="sidebar-rail"]')
    const aside = document.querySelector('aside')
    return {
      rail: Boolean(rail),
      width: aside ? Math.round(aside.getBoundingClientRect().width) : null,
      hasNewSession: rail
        ? [...rail.querySelectorAll('button')].some((b) => (b.getAttribute('title') || '').includes('新建会话'))
        : false
    }
  })()`)
  check('窄视口下侧栏折叠成图标条', narrowState?.rail === true, JSON.stringify(narrowState))
  check('图标条真的很窄（≈52px）', narrowState?.width !== null && narrowState.width <= 60, JSON.stringify(narrowState))
  check('折叠后核心动作还在（新建会话）', narrowState?.hasNewSession === true, JSON.stringify(narrowState))

  // 还原视口：后面还有段落。
  // 注意不能只调 clearDeviceMetricsOverride —— 它不会触发 resize 事件，
  // 于是界面停在折叠状态，后面所有依赖会话列表的段落全崩（第一次跑就红了 30 条）。
  // 显式设回一个宽视口，resize 一定会发生。
  await setViewport(1280, 840)
  await new Promise((r) => setTimeout(r, 700))
  const wideState = await evaluate2(`(() => {
    const aside = document.querySelector('aside')
    return {
      rail: Boolean(document.querySelector('[data-testid="sidebar-rail"]')),
      width: aside ? Math.round(aside.getBoundingClientRect().width) : null
    }
  })()`)
  check('还原宽度后回到完整侧栏', wideState?.rail === false && (wideState?.width ?? 0) >= 200, JSON.stringify(wideState))

  const restoredIds = await evaluate2('window.desk.session.list().then(r => r.ok ? r.data.map(s => s.id) : r.error)')
  check(
    '重启后会话列表里还有之前的会话',
    Array.isArray(restoredIds) && restoredIds.includes(cpSession),
    JSON.stringify(restoredIds)
  )

  const restoredMessages = await evaluate2(
    `window.desk.session.load(${JSON.stringify(cpSession)}).then(r => r.ok ? r.data.messages.length : r.error)`
  )
  check('重启后能从磁盘读回历史消息', typeof restoredMessages === 'number' && restoredMessages > 0, JSON.stringify(restoredMessages))

  const restoredSize = await evaluate2('window.outerWidth + "x" + window.outerHeight')
  const [restoredWidth, restoredHeight] = String(restoredSize).split('x').map(Number)
  /**
   * 容差 ±2：`BrowserWindow` 的 width/height 与渲染层的 `outerWidth/outerHeight`
   * 在带边框/不同 DPI 缩放下可能差一两个像素。断言精确相等会把平台差异当成功能缺陷。
   */
  check(
    `重启后窗口尺寸被恢复（期望 ${RESIZED.width}x${RESIZED.height}，实际 ${restoredSize}）`,
    Math.abs(restoredWidth - RESIZED.width) <= 2 && Math.abs(restoredHeight - RESIZED.height) <= 2,
    String(restoredSize)
  )

  await evaluate2(`
    window.__agentEvents = [];
    window.desk.events.onAgent((p) => window.__agentEvents.push(p.event));
    true
  `)

  /**
   * 追问一句。用 `deny` 处理审批：这条断言的关注点是**模型收到了什么上下文**，
   * 而不是工具执行结果 —— 拒绝同样能证明记忆恢复了，而且少一层干扰。
   */
  const driveAfterRestart = makeApprovalDriver(evaluate2)
  const followUp = await driveAfterRestart({
    sessionId: cpSession,
    text: '我刚才让你做的第一件事是什么？',
    decision: 'deny',
    providerId: 'cp-internal-vllm',
    modelId: 'Qwen3-Coder-30B'
  })
  check('重启后追问能正常结束', followUp.result?.stopReason === 'end_turn', JSON.stringify(followUp.result))
  check('重启后追问同样弹出了审批（说明工具仍然可用）', followUp.approval?.toolName === 'write', JSON.stringify(followUp.approval))

  const receivedAfterRestart = await (await fetch(`${cpUrl}/__received`)).json()
  const allRequests = receivedAfterRestart.requests ?? []
  // 追问会带出**两条**请求（发起工具调用 → 工具结果回传后的收尾）。
  // 要看的是**追问的第一条**：当前问题在那一条的末尾，历史在它前面。
  const followUpRequests = allRequests.slice(requestsBeforeRestart)
  const firstFollowUp = followUpRequests[0]
  const latestRoles = firstFollowUp?.roles ?? []

  check('重启后确实发出了新的模型请求', followUpRequests.length >= 1, `${requestsBeforeRestart} → ${allRequests.length}`)
  check(
    '重启后模型收到了带历史的上下文（出现了重启前的 user 消息）',
    latestRoles.filter((role) => role === 'user').length >= 2,
    JSON.stringify(latestRoles)
  )
  check('重启后的上下文里还有之前的 assistant 回复', latestRoles.includes('assistant'), JSON.stringify(latestRoles))
  check(
    '历史排在当前问题之前（当前问题是最后一条）',
    latestRoles[latestRoles.length - 1] === 'user',
    JSON.stringify(latestRoles)
  )
  check(
    '重放的角色严格交替（Anthropic 类接口要求）',
    latestRoles.filter((role) => role !== 'system').every((role, index, list) => index === 0 || role !== list[index - 1]),
    JSON.stringify(latestRoles)
  )

  console.log('\n── 发送失败时不该丢失已输入的内容 ──')

  /**
   * 场景：输入框是**先清空再发送**的（必须如此——一轮 run 可能跑几分钟，不能等它结束才清）。
   * 但如果这次发送**在落库之前**就失败（没配 provider、缺 key），内容就白丢了。
   *
   * 这里把 provider 全删掉，制造一个「根本没发出去」的失败：
   * `resolveRunContext` 在落库之前就抛错，会话里不会留下这条消息 ——
   * 所以内容应当被还回输入框。反过来，如果失败发生在落库之后（内核/网络错误），
   * 会话里已经有这条消息，就**不该**还原，否则会和历史重复。
   */
  /**
   * 制造一个「**根本没发出去**」的失败：把默认 provider 指成一个不存在的 id。
   *
   * 这里换过两次做法，两次的教训都值得留着：
   *
   *  1. 第一版是「删掉所有 provider，之后再按 id 重新保存」—— 那一步是错的：
   *     它按 id **重新编造**了一份配置（硬编码成指向死端口的 `e2e-provider`），
   *     于是把控制面下发的那条 provider 也改成了死端口。后面任何一段真要用模型的
   *     地方都变成 `PROVIDER_ERROR: Connection error.`，而报错现场离真正的原因
   *     （几十行前那一步「恢复」）非常远。
   *  2. 第二版想「把所有 provider 停用」，但 provider 域**没有** setEnabled
   *     （那是插件域的方法）—— 只能靠 `provider.save` 重写整份配置，同样会碰配置内容。
   *
   * 现在改的是 `settings.defaultProviderId`：一个纯字符串，**精确可还原**、
   * 完全不碰 provider 配置（也就不碰密钥）。前提是当前会话自己没有 providerId ——
   * 这个自测里所有会话都是 `session.create({ workspaceId })` 建的，都没带，成立。
   * 万一哪天不成立了，下面那条「内容被还回输入框」的断言会立刻变红（前提失效会被看见）。
   */
  const defaultProviderBefore = await evaluate2(
    'window.desk.settings.get().then(r => r.ok ? r.data.defaultProviderId : r.error)'
  )
  const madeUnreachable = await evaluate2(
    `window.desk.settings.set({ defaultProviderId: 'e2e-provider-does-not-exist' }).then(r => (r.ok ? 'ok' : r.error))`
  )
  check('把默认 provider 指向不存在的 id（制造落库前的失败）', madeUnreachable === 'ok', String(madeUnreachable))
  await new Promise((r) => setTimeout(r, 400))

  const LOST_TEXT = '这段话不该因为发送失败而消失'
  const restoreResult = await evaluate2(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const textarea = document.querySelector('textarea')
      if (!textarea) return 'no-composer'
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(textarea, ${JSON.stringify(LOST_TEXT)})
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      await wait(200)
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      // 等失败回填：发送 → IPC 抛错 → store 置 restorableText → 输入框还原。
      for (let i = 0; i < 40; i += 1) {
        await wait(250)
        if ((document.querySelector('textarea')?.value ?? '') === ${JSON.stringify(LOST_TEXT)}) {
          return { restored: true, errorShown: document.body.innerText.includes('配置') || document.body.innerText.includes('模型') }
        }
      }
      return { restored: false, value: document.querySelector('textarea')?.value ?? null }
    })()
  `)
  check('发送失败时已输入的内容被还回输入框', restoreResult?.restored === true, JSON.stringify(restoreResult))

  // 还原默认 provider（精确还原，且全程没碰过任何 provider 配置）。
  const restoredDefault = await evaluate2(
    `window.desk.settings.set({ defaultProviderId: ${JSON.stringify(defaultProviderBefore)} }).then(r => r.ok ? r.data.defaultProviderId : r.error)`
  )
  check(
    '还原默认 provider（测完不留改动）',
    restoredDefault === defaultProviderBefore,
    `${JSON.stringify(defaultProviderBefore)} → ${JSON.stringify(restoredDefault)}`
  )

  console.log('\n── 渲染层错误 ──')
  check('无未捕获异常', exceptions.length === 0, exceptions.join('\n        '))
  check('无 console.error', consoleErrors.length === 0, consoleErrors.join('\n        '))

  // ─────────────────── 未保存改动的最后两道闸门：切工作区 / 关窗口 ───────────────────

  /**
   * 这一段的两个入口都会把编辑器里的内容丢掉：
   *
   *   1. 切换工作区（侧栏的「选择工作目录」与「最近目录」）—— 会重置预览；
   *   2. 关窗口 —— 每个使用会话的最后一步。
   *
   * 两者都要先问一句。关窗口那一条还必须跨进程（只有主进程拿得到 `close` 事件），
   * 所以它验的是一整条协议，不只是界面。
   *
   * ⚠️ 两个坑都在第一次跑时踩过，写在这里免得下次再踩：
   *   - 这一段在**重启之后**跑，原 `client` 的 socket 已经随旧进程死了，
   *     必须用 `restartedClient` / `evaluate2`（用它发消息永远等不到回应）；
   *   - `child` 指的是**第一次启动**的进程，重启后的进程在 `extraChildren` 里。
   */
  const secondDir = mkdtempSync(join(tmpdir(), 'ipi-e2e-second-'))
  secondWorkspaceDir = secondDir
  await evaluate2(`window.desk.workspace.open(${JSON.stringify(secondDir)}).then((r) => (r.ok ? r.data.name : r.error))`)

  /**
   * 重载界面。
   *
   * store 里的工作区列表只在 `init` 时拉一次，而上面是**直接调的 IPC**（绕过了 store），
   * 所以「最近目录」里还看不到第二个工作区 —— 而它正是另一个会把预览重置掉的入口。
   * 重载是这里最诚实的做法：用户下次打开应用时看到的就是这个列表。
   *
   * `location.reload()` 用**发完不管**的方式发（不 await）：导航会拆掉执行上下文，
   * 等它回应本身就可能是永远等不到 —— 那正是第一次跑卡死的原因之一。
   */
  void restartedClient.send('Runtime.evaluate', { expression: 'location.reload()' })
  await new Promise((r) => setTimeout(r, 4000))

  /** 重载期间求值可能落到正在拆掉的上下文上：包一层重试，别让一次抖动变成「卡死」。 */
  const evaluateAfterReload = async (expression, attempts = 8) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await evaluate2(expression)
      } catch {
        await new Promise((r) => setTimeout(r, 700))
      }
    }
    throw new Error('重载后求值重试耗尽')
  }

  const afterReload = await evaluateAfterReload(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      for (let i = 0; i < 40; i += 1) {
        await wait(300)
        if (document.body.innerText.includes('i-pi-desk') && document.querySelector('button[title="选择工作目录"]')) {
          return 'ready'
        }
      }
      return 'not-ready'
    })()
  `)
  check('重载后界面重新就绪', afterReload === 'ready', String(afterReload))

  const reopenFixture = await evaluateAfterReload(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const row = [...document.querySelectorAll('aside button[title]')].find(
        (b) => b.getAttribute('title') === ${JSON.stringify(workspaceRoot)}
      )
      if (!row) {
        return {
          error: 'no-recent-entry',
          titles: [...document.querySelectorAll('aside button[title]')].map((b) => b.getAttribute('title')).slice(0, 10)
        }
      }
      row.click()
      await wait(1800)
      return {
        asked: document.body.innerText.includes('切换工作区会丢弃'),
        onFixture: document.body.innerText.includes('e2e-fixture')
      }
    })()
  `)
  check('不脏时切工作区直接切（不问一句）', reopenFixture?.asked === false, JSON.stringify(reopenFixture))
  check('从「最近目录」能切回夹具工作区', reopenFixture?.onFixture === true, JSON.stringify(reopenFixture))

  /** 打开一个文件并敲点东西，制造未保存状态。 */
  const MAKE_DIRTY_MARK = '// 切工作区前敲的'
  const dirtyForSwitch = await evaluate2(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const titles = () => [...document.querySelectorAll('aside button[title]')].map((b) => b.getAttribute('title'))
      /**
       * 必须先把文件面板打开。
       *
       * 上面那次 \`location.reload()\` 会把「面板是否展开」一起重置（它只是组件内部状态），
       * 所以重载后文件树根本不在 DOM 里 —— 第一次跑就栽在这里：
       * 报错是「找不到文件行」，而真实原因是**面板没开**。
       */
      if (!document.querySelector('button[title="收起面板"]')) {
        const openPanel = document.querySelector('button[title^="工作区文件"]')
        if (!openPanel) return 'no-panel-toggle'
        openPanel.click()
        await wait(1200)
      }
      const refresh = document.querySelector('button[title="刷新"]')
      if (refresh) { refresh.click(); await wait(1400) }
      if (!titles().some((t) => t.startsWith('src/'))) {
        const srcRow = document.querySelector('aside button[title="src"]')
        if (srcRow) { srcRow.click(); await wait(800) }
      }
      const fileRow = [...document.querySelectorAll('aside button[title]')].find((b) => b.getAttribute('title') === 'src/hello.ts')
      if (!fileRow) return 'no-file-row: ' + JSON.stringify(titles().slice(0, 12))
      fileRow.click()
      await wait(1000)
      const content = document.querySelector('.cm-content')
      if (!content) return 'no-editor'
      content.focus()
      return 'open'
    })()
  `)
  check('为测切工作区准备了未保存状态', dirtyForSwitch === 'open', String(dirtyForSwitch))
  await restartedClient.send('Input.insertText', { text: `${MAKE_DIRTY_MARK}\n` })
  await new Promise((r) => setTimeout(r, 500))

  const switchWithDirty = await evaluate2(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const row = [...document.querySelectorAll('aside button[title]')].find(
        (b) => b.getAttribute('title') === ${JSON.stringify(secondDir)}
      )
      if (!row) return 'no-second'
      row.click()
      await wait(800)
      return {
        asked: document.body.innerText.includes('切换工作区会丢弃'),
        stillOnFixture: document.body.innerText.includes('e2e-fixture'),
        keepsEdit: (document.querySelector('.cm-content')?.innerText ?? '').includes(${JSON.stringify(MAKE_DIRTY_MARK)})
      }
    })()
  `)
  check('有未保存改动时切工作区会先问', switchWithDirty?.asked === true, JSON.stringify(switchWithDirty))
  check('问的时候还留在原工作区（内容没被提前重置）', switchWithDirty?.stillOnFixture === true, JSON.stringify(switchWithDirty))
  check('问的时候编辑内容还在', switchWithDirty?.keepsEdit === true, JSON.stringify(switchWithDirty))

  const switchCancelled = await evaluate2(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const cancel = [...document.querySelectorAll('button')].find((b) => b.getAttribute('title') === '取消切换')
      if (!cancel) return { error: 'no-cancel' }
      cancel.click()
      await wait(600)
      return {
        confirmGone: !document.body.innerText.includes('切换工作区会丢弃'),
        stillOnFixture: document.body.innerText.includes('e2e-fixture'),
        keepsEdit: (document.querySelector('.cm-content')?.innerText ?? '').includes(${JSON.stringify(MAKE_DIRTY_MARK)})
      }
    })()
  `)
  check(
    '取消切换后确认收起、内容仍在',
    switchCancelled?.confirmGone === true && switchCancelled?.keepsEdit === true,
    JSON.stringify(switchCancelled)
  )

  /** 「选择工作目录」是另一个入口：有未保存改动时**不该**直接弹系统目录框。 */
  const pickAsks = await evaluate2(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const pick = document.querySelector('button[title="选择工作目录"]')
      if (!pick) return 'no-pick-button'
      pick.click()
      await wait(800)
      return { asked: document.body.innerText.includes('切换工作区会丢弃') }
    })()
  `)
  check('「选择工作目录」也会先问（不会直接弹系统目录框）', pickAsks?.asked === true, JSON.stringify(pickAsks))
  await evaluate2(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const cancel = [...document.querySelectorAll('button')].find((b) => b.getAttribute('title') === '取消切换')
      if (cancel) { cancel.click(); await wait(500) }
      return true
    })()
  `)

  const switchConfirmed = await evaluate2(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const row = [...document.querySelectorAll('aside button[title]')].find(
        (b) => b.getAttribute('title') === ${JSON.stringify(secondDir)}
      )
      if (!row) return { error: 'no-second-row' }
      row.click()
      await wait(700)
      const go = [...document.querySelectorAll('button')].find((b) => b.getAttribute('title') === '丢弃改动并切换')
      if (!go) return { error: 'no-confirm-button' }
      go.click()
      await wait(2000)
      return {
        switched: document.body.innerText.includes('ipi-e2e-second'),
        editorClosed: !document.querySelector('.cm-content'),
        dirtyBadgeGone: !document.body.innerText.includes('未保存')
      }
    })()
  `)
  check('确认后切到了第二个工作区', switchConfirmed?.switched === true, JSON.stringify(switchConfirmed))
  check('切过去后编辑器关掉了（旧工作区的文件不该继续开着）', switchConfirmed?.editorClosed === true, JSON.stringify(switchConfirmed))
  /**
   * 这一条是**关窗拦截的前置条件**：脏标记必须跟着归零。
   * 否则它会一直挂着，导致之后**每次关窗口都弹「有未保存的改动」** ——
   * 那种「关不掉的窗口」比丢一次改动更让人恼火。
   */
  check('切工作区后「未保存」标记归零', switchConfirmed?.dirtyBadgeGone === true, JSON.stringify(switchConfirmed))

  // ── 会话选择必须跟着目录走（否则 agent 会在旧目录里干活）──

  console.log('\n── 切目录后：会话、聊天区、以及 agent 实际干活的目录 ──')

  /**
   * 这一节盯的是一个**静默地在错误目录里干活**的缺陷：
   *
   * 跑一轮用的 cwd 来自**会话自带的 workspaceId**（主进程 `resolveRunContext`），
   * 而 `openWorkspace` 原本只换 `currentWorkspace`、不动 `currentSessionId` ——
   * 于是切到 B 之后，聊天区显示 A 的对话，用户输入一句，agent 在 **A** 里干活，
   * 而界面（标题、文件树）显示的是 **B**。
   *
   * 所以这里不只验「列表过滤了」，还要验**最后那一步：文件真的落在新目录里**。
   */
  const scopedAfterSwitch = await evaluate2(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      await wait(600)
      const rowTitles = [...document.querySelectorAll('button[title$="（双击重命名）"]')].map((b) => b.getAttribute('title'))
      return {
        sessionRows: rowTitles.length,
        showsElsewhereHint: /其它目录还有 \\d+ 个会话/.test(document.body.innerText),
        // 聊天区应当回到「没有会话」的空状态，而不是留着上一个目录的对话。
        chatEmpty: document.body.innerText.includes('选择一个工作目录') || document.body.innerText.includes('切换工作目录'),
        stillShowsFixturePath: document.body.innerText.includes(${JSON.stringify(workspaceRoot)})
      }
    })()
  `)
  check('切到新目录后，会话列表里没有旧目录的会话', scopedAfterSwitch?.sessionRows === 0, JSON.stringify(scopedAfterSwitch))
  check('给出「其它目录还有 N 个会话」的提示（不让人以为会话丢了）', scopedAfterSwitch?.showsElsewhereHint === true, JSON.stringify(scopedAfterSwitch))
  check(
    '聊天区回到了空状态（旧目录的对话不再挂在这里）',
    scopedAfterSwitch?.chatEmpty === true,
    JSON.stringify(scopedAfterSwitch)
  )
  check('界面确实已经指向新目录', scopedAfterSwitch?.stillShowsFixturePath === false, JSON.stringify(scopedAfterSwitch))

  /** 为新目录建一个会话，让假模型写文件 —— 看它落在哪个目录。 */
  const newWorkspaceId = await evaluate2(
    `window.desk.workspace.list().then(r => r.ok ? (r.data.find(w => w.path === ${JSON.stringify(secondDir)})?.id ?? null) : r.error)`
  )
  check('拿得到新工作区的 id', typeof newWorkspaceId === 'string' && newWorkspaceId.length > 0, String(newWorkspaceId))

  const scopedSession = await evaluate2(
    `window.desk.session.create({ workspaceId: ${JSON.stringify(newWorkspaceId)} }).then(r => r.ok ? r.data : r.error)`
  )
  check('能在新工作区里建会话', scopedSession?.workspaceId === newWorkspaceId, JSON.stringify(scopedSession))

  /**
   * 重新挂上事件订阅：上面那次 \`location.reload()\` 会把页面里的订阅一起清掉，
   * 而审批驱动要靠它拿事件（不重挂的话会一直等审批直到超时）。
   */
  await evaluate2(`
    window.__agentEvents = [];
    window.desk.events.onAgent((p) => window.__agentEvents.push(p.event));
    true
  `)

  /**
   * 这一段**自带 provider**，不假设「此刻默认 provider 是好的」。
   *
   * 第一次跑就是栽在这上面：默认 provider 被前面「发送失败」那一段换成了指向死端口的
   * `e2e-provider`（那是那个用例故意要的），于是这一轮直接 `Connection error`，
   * 表现成「审批事件没来 → 驱动等到超时 → 断言拿不到结果」，
   * 离真正的原因（provider 不对）很远。
   */
  const goodProvider = await evaluate2(
    `window.desk.provider.list().then((r) => {
       const list = r.ok ? r.data : []
       const p = list.find((x) => x.source === 'control-plane' && x.enabled !== false) ?? list.find((x) => x.id !== 'e2e-provider')
       return p ? { id: p.id, modelId: p.models?.[0]?.id ?? null, baseUrl: p.baseUrl ?? null } : null
     })`
  )
  check('拿得到一个可用的 provider（不假设默认那个是好的）', Boolean(goodProvider?.id && goodProvider?.modelId), JSON.stringify(goodProvider))

  const driveInNewWorkspace = makeApprovalDriver(evaluate2)
  const runInNewWorkspace = await driveInNewWorkspace({
    sessionId: scopedSession.id,
    text: '写一个文件',
    decision: 'allow-once',
    providerId: goodProvider.id,
    modelId: goodProvider.modelId
  })
  /**
   * 失败时把这一轮的事件摊开。
   *
   * 断言只说「没跑成」，而原因在事件里（`run.failed` 带着 error）——
   * 少了这一段，排查就得重新手工复现一遍。第一次跑就是因为没有它，
   * 只能看到一个光秃秃的 `{stopReason:'error'}`。
   */
  if (runInNewWorkspace?.result?.stopReason !== 'end_turn') {
    const diagnostics = await evaluate2(`
      (window.__agentEvents || []).map((e) => e.type === 'run.failed' ? { type: e.type, error: e.error } : { type: e.type }).slice(-8)
    `)
    console.log(`        本轮事件：${JSON.stringify(diagnostics)}`)
  }
  check(
    '在新目录里也能跑完一轮（含审批）',
    runInNewWorkspace?.result?.stopReason === 'end_turn',
    JSON.stringify(runInNewWorkspace)
  )

  /**
   * **决定性的一条**：假模型的 \`write\` 用的是相对路径，
   * 所以文件落在哪个目录，就等于 agent 的 cwd 是哪个目录。
   */
  const wroteInNew = existsSync(join(secondDir, 'agent-wrote.txt'))
  check(
    'agent 真的在**新目录**里写了文件（cwd 跟着会话走）',
    wroteInNew,
    `新目录 ${secondDir} / 旧目录 ${workspaceRoot}`
  )
  check(
    '写的东西是假模型给的（不是空文件）',
    wroteInNew && readFileSync(join(secondDir, 'agent-wrote.txt'), 'utf8').includes('written-by-fake-model'),
    wroteInNew ? readFileSync(join(secondDir, 'agent-wrote.txt'), 'utf8').slice(0, 80) : '(文件不存在)'
  )

  /** 切回夹具目录：会话列表应当回来，提示里的计数应当只数**另一个**目录。 */
  const backScoped = await evaluate2(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const row = [...document.querySelectorAll('aside button[title]')].find(
        (b) => b.getAttribute('title') === ${JSON.stringify(workspaceRoot)}
      )
      if (!row) return { error: 'no-recent-entry' }
      row.click()
      await wait(2000)
      return {
        sessionRows: [...document.querySelectorAll('button[title$="（双击重命名）"]')].length,
        /**
         * 核对**确切条数**而不是「有没有这句提示」。
         * 上面在新目录里建的那个会话此刻仍然存在，所以这里应当是「还有 1 个」——
         * 只断言「提示存在」的话，计数算错（比如把别的目录的会话漏算）也照样通过。
         */
        elsewhereOne: document.body.innerText.includes('其它目录还有 1 个会话'),
        elsewhereHint: (document.body.innerText.match(/其它目录还有 \\d+ 个会话/) ?? [null])[0],
        onFixture: document.body.innerText.includes('e2e-fixture')
      }
    })()
  `)
  check('切回旧目录后，它的会话又出现了', (backScoped?.sessionRows ?? 0) > 0, JSON.stringify(backScoped))
  check(
    '切回旧目录后，提示数的是**另一个目录**里的会话数（正好 1 个）',
    backScoped?.elsewhereOne === true,
    JSON.stringify(backScoped)
  )
  check('确实回到了夹具目录', backScoped?.onFixture === true, JSON.stringify(backScoped))

  /** 切回夹具工作区，给关窗测试留一个能打开文件的环境。 */
  await evaluate2(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const row = [...document.querySelectorAll('aside button[title]')].find(
        (b) => b.getAttribute('title') === ${JSON.stringify(workspaceRoot)}
      )
      if (row) { row.click(); await wait(1800) }
      return true
    })()
  `)

  // ── 最近目录里的目录被外部删掉之后 ──

  /*
    「项目」分组（别的目录里的会话可以点开）**故意没有端到端覆盖**，原因写在这里：

    它要能点，前提是「那个目录此刻还在应用的目录列表里」。而这份自测跑到这里时，
    第二个目录的状态已经被前后两段各自改动过（「切目录」把它切进来、「最近目录」
    会把它从列表里移除）。我试过三种位置与两种还原方式，每次都会把相邻那一段的
    全局状态挤掉 —— 现象是「最近目录坏了」（no-recent-entry 一片），
    真因是上一段切了工作区。为了一个入口去改另一段的语义不划算。

    所以：这个分组的**逻辑**用单测钉住（lib/session-groups.ts 的 otherProjects，8 条：
    别的目录才列、带会话数、查名字与路径、目录被移除但会话还在时仍然列出、
    路径为空时不切、空列表、未选工作区、空会话），
    而「点一下真的切过去」这条路径**如实记为未覆盖**。

    （它在开发机上手工验过：行渲染、点击切目录、会话被选中。手工验证不算覆盖。）
  */

  console.log('\n── 最近目录里那条已经不好使的记录 ──')

  /**
   * 「最近目录」里的路径随时可能被外部删掉或改名 —— 这不是边缘情况
   * （临时目录、清理脚本、移动硬盘、别人删了共享目录）。
   *
   * 原来的行为很糟：点下去**完全没反应**，一句提示都没有。
   * 因为 store 没接住主进程抛的 `WORKSPACE_NOT_FOUND`，而侧栏又是 `void` 掉这个 Promise ——
   * 于是异常沉下去，用户只看到「点了没用」（顺带留下一次未处理的 rejection）。
   */
  const listedBeforeStale = await evaluate2(
    `window.desk.workspace.list().then(r => r.ok ? r.data.map(w => w.path) : r.error)`
  )
  check('这一刻第二个目录还在最近列表里', (listedBeforeStale ?? []).includes(secondDir), JSON.stringify(listedBeforeStale))

  // 从**外部**把它删掉（测试进程动手，不经过应用）—— 模拟目录被清理掉。
  rmSync(secondDir, { recursive: true, force: true })
  check('第二个目录已从磁盘上删除', !existsSync(secondDir), secondDir)

  const staleClick = await evaluate2(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const row = [...document.querySelectorAll('aside button[title]')].find(
        (b) => b.getAttribute('title') === ${JSON.stringify(secondDir)}
      )
      if (!row) return { error: 'no-recent-entry' }
      const before = document.body.innerText
      row.click()
      await wait(1200)
      return {
        // 点之前界面上没有这个提示（说明它确实是这次点击带来的）
        noErrorBefore: !before.includes('打不开「'),
        showsError: document.body.innerText.includes('打不开「'),
        mentionsMissing: /不存在|不是什么|不是目录|NOT_FOUND/i.test(document.body.innerText),
        hasForgetButton: [...document.querySelectorAll('button')].some(
          (b) => b.getAttribute('title') === '从最近目录里移除'
        ),
        /**
         * 用**路径**判断「还在原工作区」，而不是工作区名字。
         * 名字是预置的夹具数据（workspaces.json 里写的是 e2e-fixture），
         * 拿它当判据会把「名字被谁改过」和「目录切走没有」混在一起 ——
         * 这一轮我就因为顺手刷新了 name，让 4 条同类断言一起变红。
         * 标题栏显示的是路径，那才是「当前在哪个目录」的直接事实。
         */
        stillOnFixture: document.body.innerText.includes(${JSON.stringify(workspaceRoot)})
      }
    })()
  `)
  check('点击之前没有任何报错提示（对照）', staleClick?.noErrorBefore === true, JSON.stringify(staleClick))
  check('点击之后给出了「打不开」的提示（不再静默无反应）', staleClick?.showsError === true, JSON.stringify(staleClick))
  check('提示里说明了原因（目录不存在）', staleClick?.mentionsMissing === true, JSON.stringify(staleClick))
  check('提示里给出了「从列表移除」这条出路', staleClick?.hasForgetButton === true, JSON.stringify(staleClick))
  check('打不开就当作没点过：当前工作区没有变', staleClick?.stillOnFixture === true, JSON.stringify(staleClick))

  const afterForget = await evaluate2(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const forget = [...document.querySelectorAll('button')].find((b) => b.getAttribute('title') === '从最近目录里移除')
      if (!forget) return { error: 'no-forget-button' }
      forget.click()
      await wait(1000)
      const listed = await window.desk.workspace.list()
      return {
        goneFromUi: ![...document.querySelectorAll('aside button[title]')].some(
          (b) => b.getAttribute('title') === ${JSON.stringify(secondDir)}
        ),
        goneFromDiskList: listed.ok ? !listed.data.some((w) => w.path === ${JSON.stringify(secondDir)}) : 'list-error',
        errorCleared: !document.body.innerText.includes('打不开「'),
        // 应用还得好好的：当前目录的会话仍然在列表里。
        sessionsStillListed: [...document.querySelectorAll('button[title$="（双击重命名）"]')].length > 0
      }
    })()
  `)
  check('「从列表移除」后它从侧栏消失', afterForget?.goneFromUi === true, JSON.stringify(afterForget))
  check('「从列表移除」后它也不再出现在持久化的列表里', afterForget?.goneFromDiskList === true, JSON.stringify(afterForget))
  check('移除后提示收起', afterForget?.errorCleared === true, JSON.stringify(afterForget))
  check('应用照常可用（当前目录的会话仍在）', afterForget?.sessionsStillListed === true, JSON.stringify(afterForget))

  /**
   * 「移除」之后**再把它加回来**：那个目录下的会话必须还在。
   *
   * 这一条盯的是「移除」的实现方式。如果移除是 `splice`（删记录）、重开是 `randomUUID()`，
   * 那么 id 就变了，旧会话的 `workspaceId` 再也对不上 —— 对话**还在磁盘上但永远看不到**。
   * 现在的做法是按路径复用同一条记录、「移除」只标记隐藏，所以 id 不变。
   *
   * 用户侧的等价路径是「选择工作目录」再选一次同一个目录（这里用 IPC 走同一段主进程代码）。
   */
  mkdirSync(secondDir, { recursive: true })
  const reopenedSecond = await evaluate2(
    `window.desk.workspace.open(${JSON.stringify(secondDir)}).then(r => r.ok ? r.data : r.error)`
  )
  check(
    '重新打开同一路径会**复用同一个 id**（这正是会话不会变孤儿的原因）',
    reopenedSecond?.id === newWorkspaceId,
    `${String(newWorkspaceId)} → ${JSON.stringify(reopenedSecond?.id)}`
  )
  check('重新打开后它又出现在最近列表里', reopenedSecond?.hidden !== true, JSON.stringify(reopenedSecond?.hidden))

  const sessionsAfterReopen = await evaluate2(
    `window.desk.session.list().then(r => r.ok ? r.data.filter(s => s.workspaceId === ${JSON.stringify(newWorkspaceId)}).map(s => s.id) : r.error)`
  )
  check(
    '那个目录下的会话仍然挂在同一个工作区上（移除没有丢对话）',
    Array.isArray(sessionsAfterReopen) && sessionsAfterReopen.includes(scopedSession?.id),
    JSON.stringify(sessionsAfterReopen)
  )

  // 收拾干净：把它移出列表，回到「只有一个工作区」的初始状态。
  await evaluate2(
    `window.desk.workspace.remove(${JSON.stringify(reopenedSecond?.id ?? '')}).then(r => (r.ok ? 'ok' : r.error))`
  )


  // ── 多主题 ──
  // ───────────────────────── 限额预警：接近上限 ─────────────────────────

  console.log('\n── 限额预警：接近上限时提前提醒 ──')

  /**
   * 这一条此前一直是缺口：预警条件是 `used / max >= 0.8 且 used < max`，
   * 而假模型**一轮最多 2 次工具调用** —— 2 次要落进 [80%, 100%) 需要
   * maxSteps ∈ (2, 2.5]，没有这样的整数。
   *
   * 补法两件事：
   *  1. 给假模型加 `@loopN` 连续工具调用模式（用 read：不需要审批，
   *     于是这一段不必去点「仅允许这一次」，也不把审批时序混进来）；
   *  2. **通过设置界面**改 maxSteps，而不是直接调 IPC ——
   *     渲染层的预警读的是 store 里的 settings，直接改 IPC 的话 store 不知道，
   *     于是界面仍按 40 算，预警永远不出现（第一次跑就是这么红的）。
   *
   * 4 次工具调用 + maxSteps=5 → 4/5 正好 80%。预警只在**运行中**显示，
   * 所以一边跑一边轮询（假模型每次循环刻意慢 400ms）。
   */
  const setMaxStepsViaUi = async (value) => {
    return evaluate2(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const openButton = [...document.querySelectorAll('header button')].find((b) =>
        (b.getAttribute('title') || '').startsWith('设置')
      )
      if (!openButton) return 'no-settings-button'
      openButton.click()
      await wait(700)

      const input = [...document.querySelectorAll('input[type="number"]')].find((el) => el.closest('.field, div'))
      if (!input) return 'no-number-input'
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, String(${value}))
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await wait(500)

      const closeButton = [...document.querySelectorAll('button')].find((b) =>
        (b.getAttribute('title') || '').startsWith('关闭设置')
      )
      if (closeButton) closeButton.click()
      await wait(500)
      return 'ok'
    })()`)
  }

  const maxStepsSet = await setMaxStepsViaUi(5)
  const maxStepsStored = await evaluate2('window.desk.settings.get().then((r) => (r.ok ? r.data.maxSteps : null))')
  check('能通过设置界面把单次最大步数改成 5', maxStepsSet === 'ok' && maxStepsStored === 5, JSON.stringify({ maxStepsSet, maxStepsStored }))

  const limitSent = await evaluate2(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const newSessionButton = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '新建会话')
    if (!newSessionButton) return 'no-new-session-button'
    newSessionButton.click()
    await wait(700)
    const textarea = document.querySelector('textarea')
    if (!textarea) return 'no-composer'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(textarea, '@loop4 一次一次读这个文件')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(200)
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return 'sent'
  })()`)
  check('能发起这一轮（@loop4：连续 4 次工具调用）', limitSent === 'sent', String(limitSent))

  let limitWarning = null
  for (let attempt = 0; attempt < 90; attempt += 1) {
    limitWarning = await evaluate2(`(() => {
      const el = document.querySelector('[data-testid="limit-warning"]')
      if (!el) return null
      return {
        text: el.innerText.replace(/\\s+/g, ' ').trim(),
        hasButton: Boolean(el.querySelector('button'))
      }
    })()`)
    if (limitWarning) break
    await new Promise((resolve) => setTimeout(resolve, 150))
  }

  check('接近上限时出现了预警', Boolean(limitWarning), JSON.stringify(limitWarning))
  check('预警带具体进度（4/5 步）', String(limitWarning?.text ?? '').includes('4/5'), String(limitWarning?.text))
  check(
    '预警说清了这是「接近上限」而不是已经停下',
    String(limitWarning?.text ?? '').includes('接近上限'),
    String(limitWarning?.text)
  )
  check('预警旁边有去调大的入口', limitWarning?.hasButton === true, JSON.stringify(limitWarning))

  // 等这一轮收尾，再把上限改回去（不留副作用）
  await new Promise((resolve) => setTimeout(resolve, 2500))
  const maxStepsRestoredSet = await setMaxStepsViaUi(40)
  /**
   * 收尾：把这一节新建的那个会话删掉。
   *
   * 不清掉的话，后面按「目录里有多少个会话」计数的段落会因为多出这一个而失败 ——
   * 现象是「切目录后还留着旧目录的会话」，而真因在这一节（每条自测自己收干净，
   * 是这份自测里反复出现的教训）。
   */
  const limitSessionRemoved = await evaluate2('window.desk.session.list().then((r) => (r.ok ? r.data.map((s) => s.id) : []))')
    .then((ids) => (Array.isArray(ids) && ids.length > 0 ? evaluate2(`window.desk.session.remove(${JSON.stringify(ids[0])}).then(() => true).catch(() => false)`) : false))
  void limitSessionRemoved

  const maxStepsRestored = await evaluate2('window.desk.settings.get().then((r) => (r.ok ? r.data.maxSteps : null))')
  check(
    '跑完把 maxSteps 改回 40（这一节不留副作用）',
    maxStepsRestoredSet === 'ok' && maxStepsRestored === 40,
    JSON.stringify({ maxStepsRestoredSet, maxStepsRestored })
  )

  // ───────────────────────── 设置：整窗面板 ─────────────────────────

  console.log('\n── 设置：整窗面板 + 左导航 + 搜索 ──')

  /**
   * 参考上游把设置从弹窗换成整窗面板。这里验的正是「换成了什么」：
   *  1. 面板**铺满窗口**（弹窗的特征是「有边框的盒子 + 遮罩」）；
   *  2. 左侧常驻导航 + 搜索框；
   *  3. 搜索能过滤导航项；
   *  4. 点导航项会滚到对应区块（不是切换子页 —— 所有控件始终在 DOM 里）。
   */
  const settingsPaneOpened = await evaluate2(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const button = [...document.querySelectorAll('header button')].find((b) =>
      (b.getAttribute('title') || '').startsWith('设置')
    )
    if (!button) return 'no-settings-button'
    button.click()
    await wait(700)
    return document.querySelector('[data-testid="settings-pane"]') ? 'ok' : 'no-pane'
  })()`)
  check('能打开设置面板', settingsPaneOpened === 'ok', String(settingsPaneOpened))

  const settingsPaneState = await evaluate2(`(() => {
    const pane = document.querySelector('[data-testid="settings-pane"]')
    if (!pane) return null
    const nav = document.querySelector('[data-testid="settings-nav"]')
    const rect = pane.getBoundingClientRect()
    return {
      fullWindow: rect.width >= window.innerWidth - 2 && rect.height >= window.innerHeight - 2,
      size: Math.round(rect.width) + 'x' + Math.round(rect.height),
      inner: window.innerWidth + 'x' + window.innerHeight,
      navOnTheLeft: nav ? Math.round(nav.getBoundingClientRect().left) : null,
      navWidth: nav ? Math.round(nav.getBoundingClientRect().width) : null,
      hasSearch: Boolean(nav && nav.querySelector('input[placeholder^="搜索设置"]')),
      itemCount: nav ? nav.querySelectorAll('button').length : 0
    }
  })()`)
  check('设置面板铺满窗口（不再是居中的弹窗盒子）', settingsPaneState?.fullWindow === true, JSON.stringify(settingsPaneState))
  check('左侧是常驻导航', settingsPaneState?.navOnTheLeft !== null && settingsPaneState.navOnTheLeft <= 8, JSON.stringify(settingsPaneState))
  check('导航里有搜索框', settingsPaneState?.hasSearch === true, JSON.stringify(settingsPaneState))
  check('导航列出的设置项不少于 5 条', (settingsPaneState?.itemCount ?? 0) >= 5, JSON.stringify(settingsPaneState))

  // 搜索能过滤导航项
  const settingsNavFiltered = await evaluate2(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const input = document.querySelector('[data-testid="settings-nav"] input')
    if (!input) return 'no-input'
    const before = document.querySelectorAll('[data-testid="settings-nav"] button').length
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '插件')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(300)
    const after = document.querySelectorAll('[data-testid="settings-nav"] button').length
    setter.call(input, '')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(200)
    return { before, after }
  })()`)
  check(
    '搜索会过滤导航项（输入「插件」后只剩它）',
    settingsNavFiltered?.after === 1 && (settingsNavFiltered?.before ?? 0) > 1,
    JSON.stringify(settingsNavFiltered)
  )

  // 点导航项会滚到对应区块
  const settingsScrolled = await evaluate2(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const content = document.querySelector('[data-testid="settings-content"]')
    if (!content) return 'no-content'
    const button = [...document.querySelectorAll('[data-testid="settings-nav"] button')].find(
      (b) => b.textContent.trim() === '模型 provider'
    )
    if (!button) return 'no-nav-item'
    const before = content.scrollTop
    button.click()
    await wait(900)
    const anchor = document.getElementById('settings-providers')
    return {
      before,
      after: content.scrollTop,
      anchorTop: anchor ? Math.round(anchor.getBoundingClientRect().top) : null,
      viewport: Math.round(content.getBoundingClientRect().height)
    }
  })()`)
  /**
   * 断言写成「滚动发生了 **或** 锚点已经在视野里」。
   *
   * 第一版只断言 scrollTop 变大 —— 而窗口够高、内容本来就装得下时 scrollTop 恒为 0，
   * 于是这条会在某些窗口尺寸下恒假（现象是「导航点了没反应」，其实是没得滚）。
   * 真正要保证的是：点完之后，那个区块**看得见**。
   */
  check(
    '点导航项后对应区块进入视野（滚动定位，不切换子页）',
    (settingsScrolled?.after ?? 0) > (settingsScrolled?.before ?? 0) ||
      ((settingsScrolled?.anchorTop ?? 999) >= 0 && (settingsScrolled?.anchorTop ?? 999) <= (settingsScrolled?.viewport ?? 0)),
    JSON.stringify(settingsScrolled)
  )

  // 权限模式：下拉 → 分段控件（互斥三档，一眼看全当前在哪一档）
  const permissionSeg = await evaluate2(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const group = document.querySelector('[role="radiogroup"][aria-label="权限模式"]')
    if (!group) return 'no-group'
    const items = [...group.querySelectorAll('[data-testid^="permission-"]')]
    const checkedBefore = items.filter((i) => i.getAttribute('aria-checked') === 'true').length
    const readonly = items.find((i) => i.getAttribute('data-testid') === 'permission-readonly')
    if (!readonly) return 'no-readonly'
    readonly.click()
    await wait(600)
    const stored = await window.desk.settings.get()
    const checkedAfter = items.filter((i) => i.getAttribute('aria-checked') === 'true').length
    // 收干净：切回「每次询问」
    const ask = items.find((i) => i.getAttribute('data-testid') === 'permission-ask')
    if (ask) ask.click()
    await wait(500)
    return {
      count: items.length,
      labels: items.map((i) => i.textContent.trim()),
      checkedBefore,
      checkedAfter,
      stored: stored.ok ? stored.data.permissionMode : null
    }
  })()`)
  check('权限模式改成了分段控件（三档一排，不是下拉）', permissionSeg?.count === 3, JSON.stringify(permissionSeg))
  check('分段控件里同时只有一档是选中的', permissionSeg?.checkedBefore === 1 && permissionSeg?.checkedAfter === 1, JSON.stringify(permissionSeg))
  // 这一条要在**点完「只读」之后**读设置：读到 readonly 才证明它真的改了主进程里的设置。
  check('点分段控件会真的改设置（不是只改样式）', permissionSeg?.stored === 'readonly', JSON.stringify(permissionSeg))

  // 收干净：关掉设置
  const settingsPaneClosed = await evaluate2(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const close = document.querySelector('button[title="关闭设置"]')
    if (!close) return 'no-close'
    close.click()
    await wait(500)
    return document.querySelector('[data-testid="settings-pane"]') ? 'still-open' : 'ok'
  })()`)
  check('关掉设置后不留面板', settingsPaneClosed === 'ok', String(settingsPaneClosed))

  // ───────────────────────── 置顶 ─────────────────────────

  console.log('\n── 置顶：单独一组，且真的落盘 ──')

  /**
   * 置顶是这一轮新增的功能，验四件事：
   *  1. 点行内按钮能置顶，且**单独成一组**（不是插进时间分组里）；
   *  2. 置顶**不改时间序**（组内顺序与原来一致 —— 这一点单测钉得更细）；
   *  3. 真的落盘（换一次页面仍然置顶）；
   *  4. 能取消，取消后分组消失。
   */
  const pinTarget = await evaluate2(`(() => {
    const rows = [...document.querySelectorAll('aside button[title]')]
    const row = rows.find((b) => (b.getAttribute('title') || '').length > 0 && !b.closest('[data-pinned]'))
    return row ? row.getAttribute('title') : null
  })()`)

  const pinned = await evaluate2(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    // 找一个还没置顶的会话行：先悬停让按钮出现，再点它（走真实交互路径）
    const rows = [...document.querySelectorAll('aside li')]
    for (const row of rows) {
      const button = row.querySelector('[data-testid="pin-session"]')
      if (!button) continue
      if (button.getAttribute('title') !== '置顶会话') continue
      button.click()
      await wait(700)
      const title = row.querySelector('button[title]')?.getAttribute('title') ?? null
      return { ok: true, title }
    }
    return { ok: false, title: null }
  })()`)
  check('能点行内按钮把会话置顶', pinned?.ok === true, JSON.stringify(pinned))

  const pinnedState = await evaluate2(`(() => {
    const labels = [...document.querySelectorAll('aside p')].map((p) => p.textContent.trim())
    const pinnedIndex = labels.indexOf('置顶')
    const index = pinnedIndex === -1 ? -1 : labels.indexOf('今天')
    return {
      hasPinnedGroup: pinnedIndex !== -1,
      pinnedFirst: pinnedIndex !== -1 && index !== -1 ? pinnedIndex < index : pinnedIndex === 0 || labels[0] === '置顶',
      labels: labels.slice(0, 6)
    }
  })()`)
  check('侧栏出现了「置顶」分组', pinnedState?.hasPinnedGroup === true, JSON.stringify(pinnedState))
  check('「置顶」排在时间分组之前', pinnedState?.pinnedFirst === true, JSON.stringify(pinnedState))

  const storedPinned = await evaluate2(
    'window.desk.session.list().then((r) => (r.ok ? r.data.filter((s) => s.pinned === true).length : -1))'
  )
  check('置顶真的落盘了（IPC 里能看到 pinned）', storedPinned === 1, String(storedPinned))

  /*
    持久化怎么验：**读主进程里的会话列表**，而不是整页 reload。
    理由：reload 会把「文件面板是否打开」这类全局 UI 状态一起清掉，害到后面的段落
    （第一版就是这么让「关窗测试前置条件」以 no-editor 失败的 —— 现象指向关窗，
    真因在这一段）。而 pinned 落在会话文件里，IPC 读到的就是磁盘状态，证据同样硬。
    界面侧的证据上面已经有一条：「置顶」分组在侧栏里排在最前。
  */
  const pinPersisted = await evaluate2(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    await wait(400)
    const sessions = await window.desk.session.list()
    if (!sessions.ok) return { error: 'list-failed' }
    const pinned = sessions.data.filter((s) => s.pinned === true)
    return { count: pinned.length, titles: pinned.map((s) => s.title) }
  })()`)
  check(
    '置顶落在会话文件里（IPC 读得到，不是内存状态）',
    pinPersisted?.count === 1,
    JSON.stringify(pinPersisted)
  )

  // 取消置顶
  const unpinned = await evaluate2(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const button = [...document.querySelectorAll('aside [data-testid="pin-session"]')].find(
      (b) => b.getAttribute('title') === '取消置顶'
    )
    if (!button) return 'no-button'
    button.click()
    await wait(700)
    const labels = [...document.querySelectorAll('aside p')].map((p) => p.textContent.trim())
    return labels.includes('置顶') ? 'still-pinned-group' : 'ok'
  })()`)
  check('取消置顶后分组消失（状态收干净）', unpinned === 'ok', String(unpinned))

  /**
   * ⚠️ 位置：放在「最近目录」那一段**之后**。
   *
   * 这一段会点「项目」行把工作区切回夹具目录 —— 而「最近目录」那一段依赖
   * 「当前还在第二个目录、且列表里有一条打不开的记录」。放在它前面时，
   * 那 6 条断言会以 no-recent-entry 失败，看起来像「最近目录坏了」，
   * 真因是**上一段把状态改了**（自测里每一次移动段落都要重新想这件事）。
   */
  console.log('\n── 多主题：切换、生效、持久化 ──')
  /**
   * 这一节验的是主题系统的**可观测后果**，不是「菜单里有没有那几项」：
   *
   *   1. 真实的点击路径（点调色板 → 点菜单项）能切过去；
   *   2. 切完 `<html data-theme>`、`color-scheme`、以及**计算后的 token**都变了 ——
   *      最后一项才是「真的生效」，前两项只是记账；
   *   3. 刷新之后仍然是切过去那套（偏好落在主进程的设置里，不是内存里的状态）；
   *   4. xterm 依赖的那个机制（把 `oklch()` token 光栅化成 `#rrggbb`）当前可用 ——
   *      它一旦坏掉，终端会**静默**退回黑底白字，没有任何报错。
   */
  const themeMenu = await evaluate2(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const button = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '').startsWith('主题'))
      if (!button) return { error: 'no-theme-button' }
      const buttonTitle = button.getAttribute('title')
      button.click()
      await wait(300)
      const menu = document.querySelector('[role="menu"][aria-label="选择主题"]')
      if (!menu) return { error: 'no-menu', buttonTitle }
      const items = [...menu.querySelectorAll('[role="menuitemradio"]')].map((el) => el.innerText.replace(/\\s+/g, ' ').trim())
      return { buttonTitle, itemCount: items.length, hasSystem: items.some((t) => t.includes('跟随系统')), labels: items.map((t) => t.split(' ')[0]) }
    })()
  `)
  check('顶栏有主题切换按钮', themeMenu?.error === undefined, JSON.stringify(themeMenu))
  check(
    '菜单里有「跟随系统」+ 5 套主题',
    themeMenu?.itemCount === 6 && themeMenu?.hasSystem === true,
    JSON.stringify(themeMenu)
  )

  /** 记录切换前的 token，用来证明「切换真的改变了渲染结果」。 */
  const beforeSwitch = await evaluate2(`
    (() => {
      const style = getComputedStyle(document.documentElement)
      return { theme: document.documentElement.dataset.theme, canvas: style.getPropertyValue('--color-canvas').trim() }
    })()
  `)

  const switched = await evaluate2(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const menu = document.querySelector('[role="menu"][aria-label="选择主题"]')
      if (!menu) return { error: 'menu-closed-too-early' }
      const item = [...menu.querySelectorAll('[role="menuitemradio"]')].filter((el) => !el.innerText.includes('跟随系统')).find((el) => el.innerText.includes('Daylight'))
      if (!item) return { error: 'no-daylight-item' }
      item.click()
      await wait(900)
      const style = getComputedStyle(document.documentElement)
      return {
        theme: document.documentElement.dataset.theme,
        colorScheme: document.documentElement.style.colorScheme,
        canvas: style.getPropertyValue('--color-canvas').trim(),
        menuClosed: !document.querySelector('[role="menu"][aria-label="选择主题"]'),
        bodyColor: getComputedStyle(document.body).color
      }
    })()
  `)
  check('通过真实点击切到 Daylight', switched?.theme === 'daylight', JSON.stringify(switched))
  check('切到浅色主题后 color-scheme 也跟着变成 light', switched?.colorScheme === 'light', JSON.stringify(switched))
  check(
    '主题 token 真的变了（不是只改了 data-theme）',
    Boolean(switched?.canvas) && switched?.canvas !== beforeSwitch?.canvas,
    `切换前 ${beforeSwitch?.canvas} → 切换后 ${switched?.canvas}`
  )
  check('选完自动收起菜单', switched?.menuClosed === true, JSON.stringify(switched))

  /** 持久化：刷新后仍是刚选的那套。 */
  await evaluate2(`location.reload()`)
  await new Promise((r) => setTimeout(r, 3500))
  const themeAfterReload = await evaluate2(`
    (() => {
      const style = getComputedStyle(document.documentElement)
      return {
        theme: document.documentElement.dataset.theme,
        colorScheme: document.documentElement.style.colorScheme,
        canvas: style.getPropertyValue('--color-canvas').trim()
      }
    })()
  `)
  check(
    '刷新之后主题仍然是 Daylight（偏好落在设置里，不是内存状态）',
    themeAfterReload?.theme === 'daylight' && themeAfterReload?.canvas === switched?.canvas,
    JSON.stringify(themeAfterReload)
  )

  /**
   * xterm 的取色依赖「光栅化」这一步。
   *
   * 断言的是**机制可用**：token 值能变成 `#rrggbb`。它的坏法很隐蔽 ——
   * 第一版用 `ctx.fillStyle` 读回来，Chrome 对 `oklch()` 原样返回，
   * 于是终端悄悄退回默认黑底白字，界面看起来「只是没生效」。
   */
  const rasterized = await evaluate2(`
    (() => {
      const style = getComputedStyle(document.documentElement)
      const canvas = document.createElement('canvas')
      canvas.width = 1
      canvas.height = 1
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      const raster = (value) => {
        ctx.clearRect(0, 0, 1, 1)
        ctx.fillStyle = value.trim()
        ctx.fillRect(0, 0, 1, 1)
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
        return { hex: '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join(''), alpha: a }
      }
      return {
        raw: style.getPropertyValue('--color-canvas').trim(),
        ...raster(style.getPropertyValue('--color-canvas'))
      }
    })()
  `)
  check(
    '主题 token 能被光栅化成 xterm 认的 #rrggbb（终端配色的前提）',
    /^#[0-9a-f]{6}$/.test(rasterized?.hex ?? '') && rasterized?.alpha === 255,
    JSON.stringify(rasterized)
  )
  check(
    '光栅化结果确实来自 token（而不是退回兜底色）',
    rasterized?.raw?.startsWith('oklch(') && rasterized.hex !== '#0e1014' && rasterized.hex !== '#0a0e12',
    JSON.stringify(rasterized)
  )


  /**
   * 终端配色**真的**跟随主题。
   *
   * 这一条是针对一个具体坏法的：xterm 自带颜色解析器，不认 `oklch()`。
   * 一旦归一化写错（第一版就是），xterm 会**静默**退回自己的默认配色 ——
   * 界面上「只是看起来没生效」，没有任何报错。
   *
   * 判据是 xterm 渲染出来的**实际前景色**：它必须等于主题 ink 的光栅化结果。
   * 退化成默认配色时这个等式立刻不成立。
   */
  const terminalFollows = await evaluate2(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const raster = (value) => {
        const canvas = document.createElement('canvas')
        canvas.width = 1
        canvas.height = 1
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        ctx.clearRect(0, 0, 1, 1)
        ctx.fillStyle = value.trim()
        ctx.fillRect(0, 0, 1, 1)
        const d = ctx.getImageData(0, 0, 1, 1).data
        return 'rgb(' + d[0] + ', ' + d[1] + ', ' + d[2] + ')'
      }
      const inkFor = () => raster(getComputedStyle(document.documentElement).getPropertyValue('--color-ink'))

      const toggle = document.querySelector('button[title^="终端"]')
      if (!toggle) return { error: 'no-terminal-button' }
      if (!document.querySelector('.xterm')) {
        toggle.click()
        for (let i = 0; i < 40 && !document.querySelector('.xterm-rows'); i++) await wait(250)
      }
      const rows = document.querySelector('.xterm-rows')
      if (!rows) return { error: 'no-xterm-rows' }

      const lightInk = inkFor()
      const lightRow = getComputedStyle(rows).color

      // 切到深色主题：终端的实际前景色应当随之改变
      const button = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '').startsWith('主题'))
      button.click()
      await wait(300)
      const menu = document.querySelector('[role="menu"][aria-label="选择主题"]')
      const item = menu && [...menu.querySelectorAll('[role="menuitemradio"]')].filter((el) => !el.innerText.includes('跟随系统')).find((el) => el.innerText.includes('Midnight'))
      if (!item) return { error: 'no-midnight-item' }
      item.click()
      await wait(1200)

      return {
        lightInk,
        lightRow,
        darkInk: inkFor(),
        darkRow: getComputedStyle(document.querySelector('.xterm-rows') || rows).color,
        theme: document.documentElement.dataset.theme
      }
    })()
  `)
  check(
    '开着终端切主题：终端实际前景色跟着主题变（默认配色会在这里露馅）',
    terminalFollows?.lightRow === terminalFollows?.lightInk &&
      terminalFollows?.darkRow === terminalFollows?.darkInk &&
      terminalFollows?.lightRow !== terminalFollows?.darkRow,
    JSON.stringify(terminalFollows)
  )

  /** 把终端收起来，别影响后面的关窗测试。 */
  await evaluate2(`
    (() => {
      const close = document.querySelector('button[title="收起终端"]')
      if (close) close.click()
      return true
    })()
  `)
  await new Promise((r) => setTimeout(r, 600))


  /**
   * 设置里的「外观」也必须是**主题网格**，而不是当年那个只给 跟随系统/深色/浅色 的下拉。
   *
   * 这一条守的是一个具体的坏法：主题网格写好了却**没接进去**
   * （第一版就是这样 —— 组件在，导出在，没有任何地方用它，界面上只剩旧下拉）。
   * 只断言「文件里有这个组件」是看不见的，必须从界面点进去。
   */
  const settingsTheme = await evaluate2(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const open = document.querySelector('button[title^="设置"]')
      if (!open) return { error: 'no-settings-button' }
      open.click()
      await wait(900)
      const dialog = document.querySelector('div.fixed.inset-0')
      if (!dialog) return { error: 'no-dialog' }
      const scroller = dialog.querySelector('.overflow-y-auto')
      if (scroller) scroller.scrollTop = scroller.scrollHeight
      await wait(400)

      const cards = [...dialog.querySelectorAll('button[aria-pressed]')]
      const paperCard = cards.find((card) => (card.innerText || '').includes('Paper'))
      if (!paperCard) {
        return { error: 'no-paper-card', cards: cards.map((c) => (c.innerText || '').replace(/\s+/g, ' ').slice(0, 24)) }
      }
      paperCard.click()
      await wait(900)

      const after = {
        theme: document.documentElement.dataset.theme,
        colorScheme: document.documentElement.style.colorScheme,
        cardCount: cards.length,
        pressed: cards.filter((card) => card.getAttribute('aria-pressed') === 'true').length
      }

      // 收干净：关掉设置，切回默认深色主题
      const close = document.querySelector('button[title="关闭设置"]')
      if (close) close.click()
      await wait(500)
      const button = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '').startsWith('主题'))
      if (button) {
        button.click()
        await wait(300)
        const menu = document.querySelector('[role="menu"][aria-label="选择主题"]')
        const midnight = menu && [...menu.querySelectorAll('[role="menuitemradio"]')]
          .filter((el) => !el.innerText.includes('跟随系统'))
          .find((el) => el.innerText.includes('Midnight'))
        if (midnight) midnight.click()
        await wait(700)
      }
      return { ...after, restored: document.documentElement.dataset.theme }
    })()
  `)
  check(
    '设置里的外观是主题网格（≥6 张卡片，不是只有亮暗的下拉）',
    (settingsTheme?.cardCount ?? 0) >= 6 && settingsTheme?.error === undefined,
    JSON.stringify(settingsTheme)
  )
  check(
    '在设置里点主题卡片也能切换，并且高亮跟着走',
    settingsTheme?.theme === 'paper' && settingsTheme?.colorScheme === 'light' && settingsTheme?.pressed === 1,
    JSON.stringify(settingsTheme)
  )
  check('设置里切完能切回默认深色（状态收干净）', settingsTheme?.restored === 'midnight', JSON.stringify(settingsTheme?.restored))

  /**
   * 字体是**随应用分发**的，所以要断言它真的在用。
   *
   * 这里必须盯住一个很隐蔽的坏法：字体名写错（或包换了导出名）时，
   * 浏览器**静默回落到系统字体**，界面照常显示、没有任何报错，
   * 只是换了一台机器字宽行高就全变了 —— 而那正是打包字体要解决的问题。
   * 所以判据不能是「CSS 里写了 Geist」，而是「渲染宽度与兜底字体不同」。
   *
   * ⚠️ 字体名必须**写死在这里**：名字写错时唯一的症状就是上面那种静默回落，
   * 所以这条断言的价值恰恰来自它会因为「换了字体但没改这里」而变红 ——
   * 换成 Geist 时它就是这么红的（组名从 inter* 改成 sans*，下次换字体只改字符串）。
   */
  const fontsInUse = await evaluate2(`
    (async () => {
      await document.fonts.ready
      const probe = (family, text) => {
        const span = document.createElement('span')
        span.style.cssText = 'position:absolute;visibility:hidden;font-size:20px;white-space:nowrap'
        span.textContent = text
        document.body.appendChild(span)
        span.style.fontFamily = family
        const withFont = span.getBoundingClientRect().width
        span.style.fontFamily = 'monospace'
        const fallback = span.getBoundingClientRect().width
        span.remove()
        return Math.abs(withFont - fallback) > 0.5
      }
      const families = [...new Set([...document.fonts].map((f) => f.family))]
      return {
        families,
        sansAvailable: document.fonts.check('16px "Geist Variable"'),
        monoAvailable: document.fonts.check('16px "JetBrains Mono Variable"'),
        sansActuallyRenders: probe('"Geist Variable", monospace', 'Reading the quick brown fox 0123456789'),
        monoActuallyRenders: probe('"JetBrains Mono Variable", monospace', 'const value = 0xdeadbeef;')
      }
    })()
  `)
  check(
    '打包的两个字族都加载了（Geist / JetBrains Mono）',
    fontsInUse?.sansAvailable === true && fontsInUse?.monoAvailable === true,
    JSON.stringify(fontsInUse)
  )
  check(
    '字体真的在渲染（宽度与兜底字体不同 —— 字体名写错会静默回落）',
    fontsInUse?.sansActuallyRenders === true && fontsInUse?.monoActuallyRenders === true,
    JSON.stringify(fontsInUse)
  )


  /** 切回默认深色主题：后面的关窗测试与它无关，但状态要收干净。 */
  const backToDark = await evaluate2(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const button = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '').startsWith('主题'))
      if (!button) return { error: 'no-theme-button' }
      button.click()
      await wait(300)
      const menu = document.querySelector('[role="menu"][aria-label="选择主题"]')
      const item = menu && [...menu.querySelectorAll('[role="menuitemradio"]')].filter((el) => !el.innerText.includes('跟随系统')).find((el) => el.innerText.includes('Midnight'))
      if (!item) return { error: 'no-midnight-item' }
      item.click()
      await wait(800)
      return {
        theme: document.documentElement.dataset.theme,
        colorScheme: document.documentElement.style.colorScheme,
        buttonTitle: button.getAttribute('title')
      }
    })()
  `)
  check('能切回深色主题 Midnight', backToDark?.theme === 'midnight' && backToDark?.colorScheme === 'dark', JSON.stringify(backToDark))
  check(
    '主题按钮的 title 会显示当前主题（可发现性）',
    typeof backToDark?.buttonTitle === 'string' && backToDark.buttonTitle.includes('主题'),
    JSON.stringify(backToDark?.buttonTitle)
  )

  console.log('\n── 关窗口前的确认 ──')
  /**
   * 关窗是**每个使用会话的最后一步**，而它原本会静默丢掉编辑器里未保存的内容。
   * 拦截只能在主进程做（`close` 事件在它那里），所以这一节验的是一整条协议：
   *
   *   渲染层上报脏状态 → 主进程拦下 close → 通知渲染层 → 用户确认 → 真的关掉
   *
   * 用「页面里订阅 onCloseRequested 的计数」判断主进程**有没有问过**，
   * 这样能区分「真的没触发」与「触发了但没问」—— 只断言弹窗出现是不够的。
   */
  await evaluate2(`
    (() => {
      window.__closeRequests = 0
      window.__closeUnsub = window.desk.events.onCloseRequested(() => { window.__closeRequests += 1 })
      return true
    })()
  `)

  const dirtyForClose = await evaluate2(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const titles = () => [...document.querySelectorAll('aside button[title]')].map((b) => b.getAttribute('title'))
      // 同样先确保文件面板开着（不依赖上一次操作留下的状态）。
      if (!document.querySelector('button[title="收起面板"]')) {
        const openPanel = document.querySelector('button[title^="工作区文件"]')
        if (openPanel) { openPanel.click(); await wait(1200) }
      }
      const cleanBefore = !document.body.innerText.includes('未保存')
      if (!titles().some((t) => t.startsWith('src/'))) {
        const srcRow = document.querySelector('aside button[title="src"]')
        if (srcRow) { srcRow.click(); await wait(900) }
      }
      const fileRow = [...document.querySelectorAll('aside button[title]')].find((b) => b.getAttribute('title') === 'src/hello.ts')
      if (!fileRow) return 'no-file-row: ' + JSON.stringify(titles().slice(0, 12))
      fileRow.click()
      await wait(1000)
      const content = document.querySelector('.cm-content')
      if (!content) return 'no-editor'
      content.focus()
      return cleanBefore ? 'open' : 'was-dirty'
    })()
  `)
  check('关窗测试开始前编辑器是干净的（否则对照不成立）', dirtyForClose === 'open', String(dirtyForClose))
  /**
   * 前置条件不成立就**停下来**，不要继续。
   *
   * 继续下去会发生什么：编辑器没开 → 没有未保存改动 → 主进程不拦 close
   * → 下面的 window.close() 真的把窗口关掉 → 之后每一次 CDP 求值都永不返回，
   * 整个套件**挂死**（而不是给出一条失败）。
   * 抛出去由外层 catch 记一条 FAIL，finally 照常收掉进程。
   */
  if (dirtyForClose !== 'open') {
    throw new Error('关窗测试的前置条件不成立（编辑器没打开），跳过后续步骤以免真的关掉窗口')
  }
  await restartedClient.send('Input.insertText', { text: '// 关窗前的未保存内容\n' })
  await new Promise((r) => setTimeout(r, 500))

  /**
   * 记录 Electron 进程是否退出 —— 「窗口真的关了」最硬的证据。
   *
   * ⚠️ 必须盯**当前**那个进程：重启段落之后跑的是 `spawnApp()` 起的新进程
   * （在 `extraChildren` 里），而 `child` 指的是**第一次启动**的那个 ——
   * 它早就退出了，监听它会让 `appExited` 一开始就是 true，白送一个假通过。
   */
  const currentApp = extraChildren[extraChildren.length - 1] ?? child
  let appExited = false
  currentApp.once('exit', () => {
    appExited = true
  })

  const closeBlocked = await evaluate2(`
    (async () => {
      window.close()
      await new Promise((r) => setTimeout(r, 1800))
      return {
        asked: window.__closeRequests,
        modalShown: document.body.innerText.includes('有未保存的改动'),
        stillAlive: true
      }
    })()
  `)
  check('有未保存改动时，关窗请求被主进程拦下并通知了渲染层', Number(closeBlocked?.asked ?? 0) >= 1, JSON.stringify(closeBlocked))
  check('渲染层弹出了确认（而不是静默退出）', closeBlocked?.modalShown === true, JSON.stringify(closeBlocked))
  check('确认之前窗口没有关掉（我们还能求值到这行）', closeBlocked?.stillAlive === true && appExited === false, JSON.stringify({ appExited }))

  const closeCancelled = await evaluate2(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const cancel = [...document.querySelectorAll('button')].find((b) => b.getAttribute('title') === '取消退出')
      if (!cancel) return { error: 'no-cancel' }
      cancel.click()
      await wait(700)
      return {
        modalGone: !document.body.innerText.includes('有未保存的改动'),
        keepsEdit: (document.querySelector('.cm-content')?.innerText ?? '').includes('关窗前的未保存内容')
      }
    })()
  `)
  check('点「取消」后确认收起、编辑内容仍在', closeCancelled?.modalGone === true && closeCancelled?.keepsEdit === true, JSON.stringify(closeCancelled))
  check('点「取消」不会退出应用', appExited === false, JSON.stringify({ appExited }))

  /** 再关一次并确认：这次应该真的退出。 */
  await evaluate2(`
    (async () => {
      window.close()
      await new Promise((r) => setTimeout(r, 1800))
      return true
    })()
  `)
  const confirmedQuit = await evaluate2(`
    (() => {
      const go = [...document.querySelectorAll('button')].find((b) => b.getAttribute('title') === '不保存并退出')
      if (!go) return { error: 'no-confirm-button' }
      go.click()
      return { clicked: true }
    })()
  `)
  check('第二次关窗仍然会问（不是只问一次）', confirmedQuit?.clicked === true, JSON.stringify(confirmedQuit))

  /** 等进程退出：这是「窗口真的关了」的唯一硬证据。 */
  const exitedAfterConfirm = await (async () => {
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline && !appExited) await new Promise((r) => setTimeout(r, 400))
    return appExited
  })()
  check('确认「不保存并退出」后应用真的退出了', exitedAfterConfirm === true, JSON.stringify({ appExited }))

  /**
   * 关掉重启后的那个 CDP 连接。
   *
   * 放在这里（最后两段断言**之后**）：那两段用的就是它。
   * 提前关掉会让后面的 `evaluate2` 发到一个已关闭的 socket 上 ——
   * 表现是**永远等不到回应**（第一次跑就卡死在这里，日志停在某个小标题后面不动）。
   */
  restartedClient.close()

  /**
   * 出问题时把主进程日志里与插件/技能/运行时相关的行打出来。
   *
   * 断言只说「结果不对」，而 sidecar 的日志说「为什么不对」—— 少了这一段，
   * 排查就得重新手工复现一遍。只在失败时输出，免得正常情况刷屏。
   */
  if (failures > 0) {
    const logPath = join(userData, 'logs', 'main.log')
    if (existsSync(logPath)) {
      const interesting = readFileSync(logPath, 'utf8')
        .split('\n')
        .filter((line) => /\[runtime\]|\[plugin|\[control-plane\]|\[terminal\]/.test(line))
      console.log(`\n── 主进程日志（相关行，共 ${interesting.length}） ──`)
      for (const line of interesting.slice(-25)) console.log(`  ${line}`)
    }
  }

  client.close()
} catch (error) {
  failures += 1
  console.log(`  FAIL  自测自身出错: ${String(error)}`)
  if (childErr) console.log(`  --- electron stderr ---\n${childErr.slice(-2000)}`)
} finally {
  killTree(child)
  for (const extra of extraChildren) killTree(extra)
  mockControlPlane.kill()
  await new Promise((r) => setTimeout(r, 1200))
  // 清理失败不该让自测变红：退出中的 Electron 可能还占着 userData 里的文件句柄。
  try {
    rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    rmSync(workspaceRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    if (secondWorkspaceDir) rmSync(secondWorkspaceDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  } catch (error) {
    console.log(`  NOTE  临时目录未清理干净（不影响结论）：${String(error)}`)
  }
}

// 顺带确认主进程日志里没有 sidecar 崩溃（有的话说明三进程链路断了）。
console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
