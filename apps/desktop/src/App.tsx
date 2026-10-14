import { useCallback, useEffect, useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { PanelLeft, PanelRight, Search, SquareTerminal } from 'lucide-react'
import { useAppStore } from './stores/app-store.js'
import { useLayoutStore } from './stores/layout-store.js'
import { useNavigationStore } from './stores/navigation-store.js'
import { Sidebar } from './features/sidebar/Sidebar.js'
import { IconRail } from './features/shell/IconRail.js'
import { RightInspector } from './features/shell/RightInspector.js'
import { SessionStrip } from './features/shell/SessionStrip.js'
import { TasksPanel } from './features/shell/TasksPanel.js'
import { ChatView } from './features/chat/ChatView.js'
import { ProviderSettings } from './features/settings/ProviderSettings.js'
import { QuitGuard } from './features/app/QuitGuard.js'
import { RuntimeBadge } from './features/status/RuntimeBadge.js'
import { SplashScreen } from './features/brand/SplashScreen.js'
import { useApplyTheme } from './features/theme/use-theme.js'
import { Suspense, lazy } from 'react'
import type { LauncherAction } from './features/launcher/CommandPalette.js'
import { KeyboardMap } from './features/launcher/KeyboardMap.js'
import { ariaKeysFor, displayKeys, shortcutFor, tooltipWithShortcut } from './lib/shortcuts.js'
import { layoutFor } from './lib/layout.js'

/**
 * 快速启动面板按需加载。
 *
 * cmdk 会连带拖进 @radix-ui/react-dialog 等依赖 —— 实测主 chunk 因此 +131KB。
 * 面板是「偶尔按一下」的东西，没必要让每次启动都付这个成本，
 * 所以它进自己的 chunk（与编辑器、终端同一套做法，见 verify-bundle.mjs 的断言）。
 */
const CommandPalette = lazy(() =>
  import('./features/launcher/CommandPalette.js').then((mod) => ({ default: mod.CommandPalette }))
)

export default function App(): React.ReactElement {
  const booted = useAppStore((s) => s.booted)
  const bootError = useAppStore((s) => s.bootError)
  const init = useAppStore((s) => s.init)
  const info = useAppStore((s) => s.info)
  const currentWorkspace = useAppStore((s) => s.currentWorkspace)
  const inspectorOpen = useLayoutStore((s) => s.inspectorOpen)
  const inspectorTab = useLayoutStore((s) => s.inspectorTab)
  const tasksOpen = useLayoutStore((s) => s.tasksOpen)
  const terminalActive = inspectorOpen && inspectorTab === 'terminal'
  const railSection = useLayoutStore((s) => s.railSection)
  const openInspectorTab = useLayoutStore((s) => s.openInspectorTab)
  const openWorkbenchHub = useLayoutStore((s) => s.openWorkbenchHub)
  const openProjects = useLayoutStore((s) => s.openProjects)
  const openTasks = useLayoutStore((s) => s.openTasks)
  const toggleTerminal = useLayoutStore((s) => s.toggleTerminal)
  const sessionOpen = useLayoutStore((s) => s.sessionOpen)
  const setSessionOpen = useLayoutStore((s) => s.setSessionOpen)
  const toggleSessionSidebar = useLayoutStore((s) => s.toggleSessionSidebar)
  const toggleInspector = useLayoutStore((s) => s.toggleInspector)
  const syncGitRepoForWorkspace = useLayoutStore((s) => s.syncGitRepoForWorkspace)
  const settingsOpen = useNavigationStore((s) => s.settingsOpen)
  const settingsTab = useNavigationStore((s) => s.settingsTab)
  const seedNavigation = useNavigationStore((s) => s.seedIfEmpty)
  const openSettingsNav = useNavigationStore((s) => s.openSettings)
  const closeSettingsNav = useNavigationStore((s) => s.closeSettings)
  const setSettingsSection = useNavigationStore((s) => s.setSettingsSection)
  const afterShellNav = useNavigationStore((s) => s.afterShellAction)
  const navGoBack = useNavigationStore((s) => s.goBack)
  const navGoForward = useNavigationStore((s) => s.goForward)
  const navHistoryIndex = useNavigationStore((s) => s.index)
  const navHistoryLength = useNavigationStore((s) => s.entries.length)
  const [launcherOpen, setLauncherOpen] = useState(false)
  /** 闪屏到 100% 后才卸盖；与 booted 解耦，保证最短展示与百分比可见。 */
  const [splashDone, setSplashDone] = useState(false)
  const finishSplash = useCallback(() => setSplashDone(true), [])

  /**
   * 版面：窄窗口把侧栏折叠成图标条（阈值与理由见 lib/layout.ts）。
   *
   * 用 resize 监听而不是 CSS 媒体查询：侧栏的折叠要改变**渲染的 DOM**
   * （列表整个不渲染，省掉几百个节点的重算），而媒体查询只能改样式。
   */
  const [layout, setLayout] = useState(() => layoutFor(window.innerWidth))
  useEffect(() => {
    const applyWidth = (width: number) => {
      const next = layoutFor(width)
      setLayout(next)
      // 设计稿 A：会话列表始终优先展开；仅极端窄时 compact 成图标条，仍保持侧栏挂载。
      setSessionOpen(true)
      // 窄窗优先收右栏，避免把左栏压成三图标。
      if (next.preferInspectorCollapsed && useLayoutStore.getState().inspectorOpen) {
        useLayoutStore.setState({ inspectorOpen: false })
      }
    }
    const onResize = () => applyWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    applyWidth(window.innerWidth)
    return () => window.removeEventListener('resize', onResize)
  }, [setSessionOpen])

  useEffect(() => {
    syncGitRepoForWorkspace(currentWorkspace?.id)
  }, [currentWorkspace?.id, syncGitRepoForWorkspace])
  const [keyboardMapOpen, setKeyboardMapOpen] = useState(false)
  const sessions = useAppStore((s) => s.sessions)
  const selectSession = useAppStore((s) => s.selectSession)
  const newQuickSession = useAppStore((s) => s.newQuickSession)
  const newGuidedSession = useAppStore((s) => s.newGuidedSession)
  const pickWorkspace = useAppStore((s) => s.pickWorkspace)

  // 主题：设置拉回来之后应用一次；之后由这个 hook 跟随偏好与系统变化。
  useApplyTheme()

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    if (booted) seedNavigation()
  }, [booted, seedNavigation])

  /**
   * 快捷键。
   *
   * 键位全部来自 `lib/shortcuts.ts`（单一来源：键盘地图与按钮 tooltip 用的是同一张表，
   * 见 §15.19）。这里的字符串与表里的 `keys` 必须一致 —— 单测里有一条断言
   * 专门检查表里的 id 都有对应绑定（通过下面的 `BOUND_IDS` 声明）。
   *
   * react-hotkeys-hook 默认**不**在输入框里触发（`enableOnFormTags` 为 false），
   * 所以「在输入框里打字」不会被这些组合键抢走 —— 这正是我们要的行为。
   */
  /**
   * `enableOnFormTags` 是这里的关键：react-hotkeys-hook 默认**不**在输入框里触发，
   * 而对「全局」这一类来说那正好是反的 —— 用户正在输入框里打字时按 Ctrl+K，
   * 恰恰是最想叫出面板的时候。输入类快捷键（Enter/↑/Ctrl+S）不在这里注册，
   * 它们由各自的组件负责，所以不会互相抢。
   */
  const GLOBAL_KEYS = { preventDefault: true, enableOnFormTags: true } as const

  useHotkeys(shortcutFor('launcher').keys, () => setLauncherOpen(true), GLOBAL_KEYS)
  useHotkeys(shortcutFor('new-session').keys, () => void newQuickSession(), GLOBAL_KEYS)
  useHotkeys(
    shortcutFor('toggle-files').keys,
    () => {
      openInspectorTab('files')
      afterShellNav()
    },
    GLOBAL_KEYS
  )
  useHotkeys(shortcutFor('toggle-terminal').keys, () => toggleTerminal(), GLOBAL_KEYS)
  useHotkeys(
    shortcutFor('open-skills').keys,
    () => openSettingsNav('settings-skills'),
    GLOBAL_KEYS
  )
  useHotkeys(shortcutFor('open-settings').keys, () => openSettingsNav(), GLOBAL_KEYS)
  useHotkeys(shortcutFor('keyboard-map').keys, () => setKeyboardMapOpen(true), GLOBAL_KEYS)
  useHotkeys(
    shortcutFor('nav-back').keys,
    () => {
      if (navHistoryIndex > 0) navGoBack()
    },
    GLOBAL_KEYS
  )
  useHotkeys(
    shortcutFor('nav-forward').keys,
    () => {
      if (navHistoryIndex >= 0 && navHistoryIndex < navHistoryLength - 1) navGoForward()
    },
    GLOBAL_KEYS
  )
  useHotkeys(shortcutFor('toggle-session-sidebar').keys, () => toggleSessionSidebar(), GLOBAL_KEYS)

  /**
   * Esc 关掉自己的浮层。
   *
   * `enabled` 保证它**只在浮层开着时**拦截：否则会把 Esc 从别处（编辑器、关窗询问）抢走，
   * 而那种「某个全局键突然不灵了」的问题极难排查。
   */
  const overlayOpen = launcherOpen || keyboardMapOpen
  useHotkeys(
    'escape',
    () => {
      setLauncherOpen(false)
      setKeyboardMapOpen(false)
    },
    { enabled: overlayOpen, enableOnFormTags: true }
  )

  // 闪屏盖到 100%（或 boot 失败停在错误态）；未完成前不进工作台。
  if (!splashDone || bootError || !booted) {
    return <SplashScreen onFinished={finishSplash} />
  }

  return (
    <div className="flex h-full">
      <IconRail
        onWorkbench={() => {
          openWorkbenchHub()
          afterShellNav()
        }}
        onTasks={() => {
          openTasks()
          afterShellNav()
        }}
        onProjects={() => {
          openProjects()
          afterShellNav()
        }}
        onSettings={() => openSettingsNav()}
        activeWorkbench={railSection === 'workbench'}
        activeTasks={railSection === 'tasks' && tasksOpen}
        activeProjects={railSection === 'projects'}
        activeSettings={settingsOpen}
        version={info?.version}
      />

      {tasksOpen ? (
        <TasksPanel />
      ) : (
        <>
          {sessionOpen ? (
            <Sidebar
              onOpenSettings={() => openSettingsNav()}
              compact={layout.compactSidebar}
              hideChromeActions
              onToggleFiles={() => {
                openInspectorTab('files')
                afterShellNav()
              }}
              onToggleTerminal={() => toggleTerminal()}
            />
          ) : null}

          <main className="flex min-w-0 flex-1 flex-col">
            {/* PI 顶栏：左栏开关 · 中标题路径 · 右后退/前进/会话/搜索/右栏（产品名只留窗口标题） */}
            <header className="header-bar flex h-11 w-full shrink-0 items-center gap-2 px-3">
              <div className="no-drag flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  className="header-bar__icon"
                  onClick={() => toggleSessionSidebar()}
                  title={tooltipWithShortcut('显示/隐藏侧边栏', 'toggle-session-sidebar')}
                  aria-label="显示/隐藏侧边栏"
                  aria-keyshortcuts={ariaKeysFor('toggle-session-sidebar')}
                  aria-pressed={sessionOpen}
                  data-active={sessionOpen ? 'true' : undefined}
                >
                  <PanelLeft size={16} strokeWidth={1.75} />
                </button>
              </div>

              <div className="drag header-bar__title flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
                {currentWorkspace ? (
                  <>
                    <span className="header-bar__title-name truncate">
                      {workspaceName(currentWorkspace.path)}
                    </span>
                    <span className="header-bar__title-path truncate" title={currentWorkspace.path}>
                      {currentWorkspace.path}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="header-bar__title-name truncate">工作台</span>
                    <span className="header-bar__title-path truncate">未选会话 · 驾驶舱空态</span>
                  </>
                )}
              </div>

              <div
                className="no-drag ml-auto flex shrink-0 items-center gap-0.5 text-[var(--color-ink)]"
                role="toolbar"
                aria-label="窗口工具"
                data-testid="header-tools"
              >
                <RuntimeBadge compact />
                <button
                  type="button"
                  className="header-bar__icon"
                  onClick={() => {
                    toggleTerminal()
                    afterShellNav()
                  }}
                  title={tooltipWithShortcut('开合终端（右栏）', 'toggle-terminal')}
                  aria-label="开合终端"
                  aria-keyshortcuts={ariaKeysFor('toggle-terminal')}
                  aria-pressed={terminalActive}
                  data-active={terminalActive ? 'true' : undefined}
                  data-testid="header-terminal"
                >
                  <SquareTerminal size={15} strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  className="header-bar__icon"
                  onClick={() => setLauncherOpen(true)}
                  title={tooltipWithShortcut('搜索', 'launcher')}
                  aria-label="搜索"
                  aria-keyshortcuts={ariaKeysFor('launcher')}
                >
                  <Search size={15} strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  className="header-bar__icon"
                  onClick={() => {
                    toggleInspector()
                    afterShellNav()
                  }}
                  title={tooltipWithShortcut('显示/隐藏右侧面板', 'toggle-files')}
                  aria-label="显示/隐藏右侧面板"
                  aria-keyshortcuts={ariaKeysFor('toggle-files')}
                  aria-pressed={inspectorOpen}
                  data-active={inspectorOpen ? 'true' : undefined}
                >
                  <PanelRight size={15} strokeWidth={1.75} />
                </button>
              </div>
            </header>

            <SessionStrip />
            <ChatView onOpenSettings={() => openSettingsNav()} />
          </main>

          {inspectorOpen ? <RightInspector /> : null}
        </>
      )}

      {settingsOpen ? (
        <ProviderSettings
          onClose={() => closeSettingsNav()}
          settingsSectionId={settingsTab}
          onSettingsSectionChange={setSettingsSection}
        />
      ) : null}

      {/*
        快速启动面板与键盘地图。两者都是「叫出来、随手关掉」的浮层，
        放在最外层以免被面板的裁切影响。
      */}
      <Suspense fallback={null}>
        <CommandPalette
          open={launcherOpen}
          onOpenChange={setLauncherOpen}
          actions={launcherActions({
            openInspectorTab: (tab) => {
              openInspectorTab(tab)
              afterShellNav()
            },
            toggleTerminal,
            openSettingsNav,
            setKeyboardMapOpen,
            newQuickSession,
            newGuidedSession,
            pickWorkspace
          })}
          sessions={sessions}
          onSelectSession={(sessionId) => void selectSession(sessionId)}
        />
      </Suspense>
      <KeyboardMap open={keyboardMapOpen} onClose={() => setKeyboardMapOpen(false)} />

      {/* 关窗拦截：主进程拦下「有未保存改动时关窗」，这里负责问那一句。 */}
      <QuitGuard />
    </div>
  )
}

/**
 * 快速启动面板里的动作。
 *
 * 顺序有意固定：面板与终端在前（用得最多），工作目录与设置在后。
 * `hint` 直接用同一张快捷键表 —— 面板里显示的键与按下去生效的键是同一个来源。
 */
function launcherActions(handlers: {
  openInspectorTab: (tab: 'files' | 'search' | 'git' | 'hub' | 'terminal') => void
  toggleTerminal: () => void
  openSettingsNav: (settingsTab?: string) => void
  setKeyboardMapOpen: (open: boolean) => void
  newQuickSession: () => Promise<unknown>
  newGuidedSession: () => Promise<unknown>
  pickWorkspace: () => Promise<unknown>
}): LauncherAction[] {
  return [
    {
      id: 'toggle-files',
      label: '开合文件管理器',
      hint: displayKeys(shortcutFor('toggle-files').keys),
      run: () => handlers.openInspectorTab('files')
    },
    {
      id: 'toggle-git',
      label: '开合 Changes（审阅）',
      run: () => handlers.openInspectorTab('git')
    },
    {
      id: 'toggle-terminal',
      label: '开合终端（右栏）',
      hint: displayKeys(shortcutFor('toggle-terminal').keys),
      run: () => handlers.toggleTerminal()
    },
    {
      id: 'new-session',
      label: '新建临时会话',
      hint: displayKeys(shortcutFor('new-session').keys),
      run: () => void handlers.newQuickSession()
    },
    {
      id: 'new-guided-session',
      label: '新建普通会话（选项目）',
      run: () => void handlers.newGuidedSession()
    },
    {
      id: 'open-skills',
      label: '技能',
      hint: displayKeys(shortcutFor('open-skills').keys),
      run: () => handlers.openSettingsNav('settings-skills')
    },
    {
      id: 'open-settings',
      label: '模型与设置',
      hint: displayKeys(shortcutFor('open-settings').keys),
      run: () => handlers.openSettingsNav()
    },
    {
      id: 'pick-workspace',
      label: '切换工作目录',
      run: () => void handlers.pickWorkspace()
    },
    {
      id: 'keyboard-map',
      label: '查看键盘快捷键',
      hint: displayKeys(shortcutFor('keyboard-map').keys),
      run: () => handlers.setKeyboardMapOpen(true)
    }
  ]
}

/** 路径的末段作为工作区显示名（Windows 与 POSIX 分隔符都认）。 */
function workspaceName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const last = trimmed.split(/[\\/]/).pop()
  return last && last.length > 0 ? last : trimmed
}
