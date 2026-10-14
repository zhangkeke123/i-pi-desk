import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { IPC, type IpcEventChannel } from '@i-pi-desk/shared'
import { AgentSupervisor } from './agent/supervisor.js'
import type { AppContext } from './context.js'
import { registerAllIpc } from './ipc/index.js'
import { initLogger, log } from './logger.js'
import { getAppPaths, resolveSidecarEntry } from './paths.js'
import { applyContentSecurityPolicy } from './security.js'
import { ensureDir } from './store/json-store.js'
import { piAgentDir } from './store/pi-config.js'
import { TerminalHost } from './terminal/host.js'
import { createMainWindow } from './window.js'

/**
 * 主进程启动编排。
 * 顺序是有讲究的：先建日志与安全策略 → 起 sidecar → 注册 IPC → 最后开窗口。
 * 窗口放最后，是因为渲染层一挂载就会立刻调 `appInfo` / `settingsGet`，
 * handler 必须已经在位，否则用户会看到一瞬间的错误提示。
 */

let mainWindow: BrowserWindow | null = null
let supervisor: AgentSupervisor | null = null
let terminalHost: TerminalHost | null = null

/**
 * 向渲染层推事件。
 *
 * 窗口可能已销毁（用户关窗但应用还在托盘）。这里必须判空，
 * 否则 sidecar / PTY 事件会在退出路径上把主进程打崩。
 */
function broadcast(channel: IpcEventChannel, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

// 必须在任何 app.getPath('userData') 之前设定。
// 否则 Electron 会拿 package.json 里的 name（"@i-pi-desk/desktop"）当应用名，
// userData 目录会变成 `@i-pi-desk/desktop` 这种带 scope 的怪路径，
// 而且打包后（productName 为 i-pi-desk）与开发期的数据目录不一致 —— 用户升级后
// 会发现「会话全没了」。
app.setName('i-pi-desk')

// 多开会让两个进程同时写 sessions/ 和 settings.json，直接串数据。
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void bootstrap()
}

async function bootstrap(): Promise<void> {
  await app.whenReady()

  const paths = getAppPaths()
  ensureDir(paths.logsDir)
  initLogger(join(paths.logsDir, 'main.log'))
  log(`i-pi-desk ${app.getVersion()} 启动，userData=${paths.userData}`)

  // 开发模式下 electron-vite 会提供 ELECTRON_RENDERER_URL；据此判断 CSP 档位与
  // 后续窗口的加载方式，两者必须用同一个判据，否则会出现「按开发档下发 CSP
  // 却加载本地文件」这类自相矛盾的状态。
  const isDev = Boolean(process.env.ELECTRON_RENDERER_URL)
  applyContentSecurityPolicy(isDev)

  supervisor = new AgentSupervisor({
    entry: resolveSidecarEntry(),
    // 必须在 spawn 时就给出真实的 agent 目录，晚一秒就来不及：
    // pi 的 `utils/tools-manager.js` 在**模块顶层**算 `TOOLS_DIR = join(getAgentDir(), 'bin')`，
    // 而 getAgentDir() 读的正是这个环境变量。也就是说它在 sidecar 第一次 import pi 的
    // 那一刻就被固化了，之后 sidecar 再改 process.env 也不会生效。
    // 不给的话，sidecar 只能退回临时目录兜底（见 agent-host/src/isolation.ts），
    // 后果是 rg/fd 缓存落在 temp 而不是随应用数据一起管理。
    env: { PI_CODING_AGENT_DIR: piAgentDir() },
    onLog: (line) => log(`[sidecar] ${line}`)
  })

  terminalHost = new TerminalHost({
    onData: (payload) => broadcast(IPC.event.terminalData, payload),
    onExit: (payload) => broadcast(IPC.event.terminalExit, payload),
    log
  })

  const ctx: AppContext = {
    supervisor,
    terminal: terminalHost,
    getWindow: () => mainWindow,
    broadcast,
    log
  }

  registerAllIpc(ctx)
  supervisor.start()

  // 终端会话归属于创建它的 webContents。窗口一销毁就收掉它建的 PTY ——
  // 这一条是「不留僵尸 shell」三处清理里的第一处（另两处是面板卸载与 before-quit）。
  app.on('web-contents-created', (_event, contents) => {
    contents.once('destroyed', () => {
      const disposed = terminalHost?.disposeByOwner(contents.id) ?? 0
      if (disposed > 0) log(`[terminal] 窗口销毁，已回收 ${disposed} 个终端会话`)
    })
  })

  mainWindow = createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow()
    }
  })
}

// 最后一道兜底：进程真的要退出时再收一次 PTY。
// `before-quit` 覆盖正常退出路径，但 `app.exit()` 之类会跳过它；
// 这一层顺手补上。注意它**挡不住 Task Manager 结束进程**（那种情况下
// 操作系统不给任何回调机会），那种场景残留的 shell 只能在下次启动时人工清理 ——
// 这是所有 Electron 终端应用的共同限制，不必假装解决了。
process.on('exit', () => {
  try {
    terminalHost?.disposeAll()
  } catch {
    // 退出路径上不值得为清理失败再抛错。
  }
})

app.on('window-all-closed', () => {
  // Windows/Linux 上关窗即退出；macOS 留在 Dock 里是系统惯例。
  if (process.platform !== 'darwin') app.quit()
})

// 退出前必须收掉 sidecar 与所有 PTY，否则会留下孤儿的 node / shell 进程。
app.on('before-quit', (event) => {
  if (!supervisor && !terminalHost) return
  event.preventDefault()

  const disposedTerminals = terminalHost?.disposeAll() ?? 0
  if (disposedTerminals > 0) log(`[terminal] 退出前回收 ${disposedTerminals} 个终端会话`)
  terminalHost = null

  const stopping = supervisor
  supervisor = null
  log('正在停止 agent sidecar…')
  void (stopping ? stopping.stop() : Promise.resolve()).finally(() => app.exit(0))
})
