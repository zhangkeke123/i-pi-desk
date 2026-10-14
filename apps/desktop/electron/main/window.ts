import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, nativeTheme, screen, shell } from 'electron'
import { getSettings } from './store/settings.js'
import { closeGuard } from './close-guard-host.js'
import { DEFAULT_BOUNDS, MIN_HEIGHT, MIN_WIDTH, resolveWindowBounds } from './store/window-bounds.js'
import { readWindowBounds, writeWindowBounds } from './store/window-state.js'

/**
 * 窗口创建。
 *
 * 安全基线（不要为了省事放宽）：
 *  - `contextIsolation: true`：渲染层与世界隔离，只能通过 preload 白名单通信。
 *  - `nodeIntegration: false`：渲染层拿不到 require/process。
 *  - `sandbox: false`：**这是唯一一处让步**，因为 Electron 的 ESM preload 在
 *    sandbox 下无法加载。代价可控：preload 里只暴露我们自己写的方法，不转发 ipcRenderer。
 */

function resolvePreload(): string {
  // electron-vite 在 ESM 工程下产出 .mjs，CJS 工程下产出 .js。两个都探测，避免
  // 构建格式一变就出现「preload 加载失败 → 窗口一片空白」这种难查的问题。
  const candidates = ['../preload/index.mjs', '../preload/index.js', '../preload/index.cjs']
  for (const candidate of candidates) {
    const full = join(import.meta.dirname, candidate)
    if (existsSync(full)) return full
  }
  return join(import.meta.dirname, '../preload/index.mjs')
}

/** 墨点 logo：开发态走 resources/，安装包可由 electron-builder 写入 exe；窗口再显式指定一次。 */
function resolveWindowIcon(): string | undefined {
  const candidates = [
    join(import.meta.dirname, '../../resources/icon.ico'),
    join(import.meta.dirname, '../../build/icon.ico'),
    join(process.resourcesPath, 'icon.ico')
  ]
  for (const full of candidates) {
    if (existsSync(full)) return full
  }
  return undefined
}

/**
 * 保存窗口尺寸/位置的节流间隔。
 *
 * 拖动窗口时 `resize`/`move` 会以极高频率触发，每次都写文件既浪费又会把磁盘打满
 * （一个拖拽动作能产生几百次事件）。500ms 足够在用户松手后落盘，
 * 也让「拖到一半崩溃」最多丢失半秒的窗口位置 —— 这个代价无所谓。
 */
const SAVE_THROTTLE_MS = 500

export function createMainWindow(): BrowserWindow {
  // 恢复上次的尺寸与位置。传入当前所有屏幕的可视区域做校验 ——
  // 保存的位置可能来自一块已经拔掉的显示器（见 store/window-state.ts 的说明）。
  const displays = screen.getAllDisplays().map((display) => display.workArea)
  const bounds = resolveWindowBounds(readWindowBounds(), displays) ?? { ...DEFAULT_BOUNDS }
  const icon = resolveWindowIcon()

  const window = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    // 没有可用位置时**不传 x/y**：交给 Electron 居中，比我们自己算更稳。
    ...(bounds.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: backdropForSettings(),
    title: 'i-pi-desk',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  // 先隐藏、等首帧渲染完再显示，避免看到白色闪屏。
  window.once('ready-to-show', () => {
    // 最大化状态在窗口显示之后再恢复：在构造参数里设 `maximized` 与 `x/y/width/height`
    // 同时给会互相干扰（不同平台表现不一致），分开做更可靠。
    if (bounds.maximized) window.maximize()
    window.show()
  })

  installBoundsPersistence(window)

  /**
   * 关窗前问一句「有未保存的改动」。
   *
   * 拦截逻辑放在这里而不是 `index.ts`：窗口可能在 macOS 上重建
   * （`activate` 里会再 `createMainWindow()`），跟着窗口走才不会漏掉新窗口。
   */
  closeGuard.attach(window)

  // 渲染层里的所有外链都交给系统浏览器，绝不在应用内开新窗口。
  // target="_blank" 若被默认处理，会得到一个没有 preload 的裸窗口。
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 阻止渲染层被导航到外部页面（例如 markdown 里的链接被点击）。
  window.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    const isDev = Boolean(devUrl) && url.startsWith(devUrl as string)
    if (isDev || url.startsWith('file://')) return
    event.preventDefault()
    void shell.openExternal(url)
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void window.loadURL(devUrl)
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  return window
}

/**
 * 让窗口尺寸/位置在下一次启动时被恢复。
 *
 * ## 两个必须处理的细节
 *
 * **一、最大化时不能记最大化后的尺寸。**
 * 最大化状态下 `getBounds()` 返回的是铺满屏幕的矩形，把它当"用户喜欢的尺寸"存下来，
 * 下次取消最大化后就再也回不到原来的大小了。所以要记 `getNormalBounds()`
 * （不含最大化/全屏的"正常"矩形）。
 *
 * **二、只在退出时写是不够的。**
 * 强杀（任务管理器、崩溃）不会触发 `close`，窗口位置就丢了。
 * 所以拖动结束时也写一次（节流），退出时再写一次兜底。
 */
function installBoundsPersistence(window: BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined

  const snapshot = (): void => {
    if (window.isDestroyed()) return
    try {
      // getNormalBounds：最大化/全屏下也能拿到"正常"矩形，见上文说明。
      const normal = window.getNormalBounds()
      writeWindowBounds({
        x: normal.x,
        y: normal.y,
        width: normal.width,
        height: normal.height,
        maximized: window.isMaximized()
      })
    } catch {
      // 取不到就跳过，不该影响使用。
    }
  }

  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(snapshot, SAVE_THROTTLE_MS)
    timer.unref?.()
  }

  window.on('resize', schedule)
  window.on('move', schedule)
  window.on('maximize', schedule)
  window.on('unmaximize', schedule)

  window.on('close', () => {
    if (timer) clearTimeout(timer)
    snapshot()
  })
}

/**
 * 窗口底色与原生外观跟随主题。
 *
 * ## 为什么要在主进程做
 *
 * 主题偏好在应用设置里，渲染层要等 IPC 回来才知道用哪套 —— 中间那一小段窗口期
 * 里，底色由主进程决定。生产档 CSP 禁止内联脚本，所以「在 head 里先设好
 * data-theme」这条路走不通（见 src/index.html 的说明）；用**窗口底色**
 * 消除闪白 / 闪黑是更干净的做法。
 *
 * 这里只需要知道主题的**亮暗**，不需要具体色值 —— 两处各存一份完整配色表
 * 必然会漂。具体色值只存在 CSS 里（styles.css 的 :root[data-theme=…]），
 * 这两行只是同一份信息的「亮暗投影」。
 *
 * nativeTheme.themeSource 一起设上：它影响的是**原生部分** —— 窗口边框、
 * 右键菜单、DevTools，以及 prefers-color-scheme 的取值。不设的话会出现
 * 「界面是浅色、原生菜单还是深色」这种割裂。
 */
/**
 * 原生窗口底色：与渲染层 theme.ts swatch[0]（canvas）对齐，
 * 避免「标题栏/启动闪一下」和主题色脱节。
 */
const THEME_BACKDROPS: Record<string, string> = {
  midnight: '#12141a',
  graphite: '#141414',
  daylight: '#f3f5f8',
  paper: '#f5f4f0',
  contrast: '#000000',
  // 旧两值
  light: '#f4f6f9',
  dark: '#12141a'
}

const DARK_BACKDROP = THEME_BACKDROPS.midnight
const LIGHT_BACKDROP = THEME_BACKDROPS.daylight

/** 主题偏好 → 亮暗。渲染层 lib/theme.ts 里的解析规则必须与这里一致。 */
function resolveThemeKind(preference: string | undefined): 'light' | 'dark' {
  if (preference === 'daylight' || preference === 'paper') return 'light'
  if (preference === 'midnight' || preference === 'graphite' || preference === 'contrast') return 'dark'
  // 兼容旧设置里的两值，以及 system / 缺失 / 未知值。
  if (preference === 'light') return 'light'
  if (preference === 'dark') return 'dark'
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

function backdropForPreference(preference: string | undefined): string {
  if (preference && THEME_BACKDROPS[preference]) return THEME_BACKDROPS[preference]
  return resolveThemeKind(preference) === 'dark' ? DARK_BACKDROP : LIGHT_BACKDROP
}

/**
 * `themeSource` 该设成什么。
 *
 * ⚠️ `system` 必须**原样**交出去，不能先解析成 light/dark 再设。
 * 第一版就是先解析的，后果是「跟随系统」被钉死：`prefers-color-scheme` 永远是
 * 启动那一刻的值，系统事后切换亮暗，渲染层的 `matchMedia` 监听再也不会触发 ——
 * 而这个失效只在用户切换系统主题时才显形。
 */
function themeSourceFor(preference: string | undefined): 'system' | 'light' | 'dark' {
  if (preference === undefined || preference === 'system') return 'system'
  if (preference === 'light' || preference === 'dark') return preference
  return resolveThemeKind(preference)
}

/**
 * 把主题应用到**原生**侧：窗口底色 + `nativeTheme.themeSource`。
 *
 * 设置变更时由 `settings-ipc` 调用；启动时由 `backdropForSettings()` 走一遍同样的规则。
 */
export function applyNativeTheme(preference: string | undefined): void {
  nativeTheme.themeSource = themeSourceFor(preference)
  const backdrop = backdropForPreference(preference)
  for (const window of BrowserWindow.getAllWindows()) window.setBackgroundColor(backdrop)
}

function backdropForSettings(): string {
  const preference = getSettings().theme
  nativeTheme.themeSource = themeSourceFor(preference)
  return backdropForPreference(preference)
}
