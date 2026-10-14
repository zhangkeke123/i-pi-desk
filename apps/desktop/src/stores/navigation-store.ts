import { create } from 'zustand'
import type { InspectorTab, RailSection } from './layout-store.js'
import { useLayoutStore } from './layout-store.js'

/** 与左栏 / 设置对应的应用级视图（非浏览器路由）。 */
export type AppView = 'projects' | 'workbench' | 'tasks' | 'settings'

export interface NavEntry {
  view: AppView
  settingsTab?: string
  railSection: RailSection
  tasksOpen: boolean
  inspectorOpen: boolean
  inspectorTab: InspectorTab
}

function shellFromLayout(): Pick<NavEntry, 'railSection' | 'tasksOpen' | 'inspectorOpen' | 'inspectorTab'> {
  const l = useLayoutStore.getState()
  return {
    railSection: l.railSection,
    tasksOpen: l.tasksOpen,
    inspectorOpen: l.inspectorOpen,
    inspectorTab: l.inspectorTab
  }
}

function viewFromShell(
  shell: Pick<NavEntry, 'railSection' | 'tasksOpen' | 'inspectorOpen' | 'inspectorTab'>,
  settingsOpen: boolean
): AppView {
  if (settingsOpen) return 'settings'
  if (shell.railSection === 'tasks' && shell.tasksOpen) return 'tasks'
  if (shell.railSection === 'workbench') return 'workbench'
  return 'projects'
}

function captureEntry(settingsOpen: boolean, settingsTab?: string): NavEntry {
  const shell = shellFromLayout()
  return {
    view: viewFromShell(shell, settingsOpen),
    settingsTab: settingsOpen ? settingsTab : undefined,
    ...shell
  }
}

function entriesEqual(a: NavEntry, b: NavEntry): boolean {
  return (
    a.view === b.view &&
    a.settingsTab === b.settingsTab &&
    a.railSection === b.railSection &&
    a.tasksOpen === b.tasksOpen &&
    a.inspectorOpen === b.inspectorOpen &&
    a.inspectorTab === b.inspectorTab
  )
}

function applyEntryToLayout(entry: NavEntry): void {
  useLayoutStore.setState({
    railSection: entry.railSection,
    tasksOpen: entry.tasksOpen,
    inspectorOpen: entry.inspectorOpen,
    inspectorTab: entry.inspectorTab
  })
}

function commitEntry(
  set: (partial: Partial<NavigationState>) => void,
  get: () => NavigationState,
  entry: NavEntry
): void {
  const { entries, index, replaying } = get()
  if (replaying) return
  const current = entries[index]
  if (current && entriesEqual(current, entry)) return
  const next = entries.slice(0, index + 1)
  next.push(entry)
  set({
    entries: next,
    index: next.length - 1,
    settingsOpen: entry.view === 'settings',
    settingsTab: entry.settingsTab
  })
  applyEntryToLayout(entry)
}

function applyHistoryIndex(
  set: (partial: Partial<NavigationState>) => void,
  get: () => NavigationState,
  nextIndex: number
): void {
  const entry = get().entries[nextIndex]
  if (!entry) return
  set({
    replaying: true,
    index: nextIndex,
    settingsOpen: entry.view === 'settings',
    settingsTab: entry.settingsTab
  })
  applyEntryToLayout(entry)
  set({ replaying: false })
}

export interface NavigationState {
  entries: NavEntry[]
  index: number
  settingsOpen: boolean
  settingsTab: string | undefined
  replaying: boolean

  seedIfEmpty: () => void
  openSettings: (settingsTab?: string) => void
  setSettingsSection: (settingsTab: string) => void
  closeSettings: () => void
  goBack: () => void
  goForward: () => void
  canGoBack: () => boolean
  canGoForward: () => boolean
  afterShellAction: () => void
}

export const useNavigationStore = create<NavigationState>((set, get) => ({
  entries: [],
  index: -1,
  settingsOpen: false,
  settingsTab: undefined,
  replaying: false,

  seedIfEmpty() {
    if (get().entries.length > 0) return
    const entry = captureEntry(false)
    set({ entries: [entry], index: 0, settingsOpen: false, settingsTab: undefined })
  },

  openSettings(settingsTab?: string) {
    const tab = settingsTab ?? 'settings-general'
    commitEntry(set, get, captureEntry(true, tab))
  },

  setSettingsSection(settingsTab: string) {
    if (!get().settingsOpen && !get().replaying) return
    commitEntry(set, get, captureEntry(true, settingsTab))
  },

  closeSettings() {
    const { entries, index } = get()
    // 设置内切换分区会堆多条 history；「返回应用」应一次退出设置，
    // 回到进入设置前的工作台 / 项目 / 会话，而不是只退一个设置分区。
    for (let i = index - 1; i >= 0; i -= 1) {
      const entry = entries[i]
      if (entry && entry.view !== 'settings') {
        applyHistoryIndex(set, get, i)
        return
      }
    }
    commitEntry(set, get, captureEntry(false))
  },

  goBack() {
    const { index } = get()
    if (index <= 0) return
    applyHistoryIndex(set, get, index - 1)
  },

  goForward() {
    const { entries, index } = get()
    if (index >= entries.length - 1) return
    applyHistoryIndex(set, get, index + 1)
  },

  canGoBack() {
    return get().index > 0
  },

  canGoForward() {
    const { entries, index } = get()
    return index >= 0 && index < entries.length - 1
  },

  afterShellAction() {
    commitEntry(set, get, captureEntry(false))
  }
}))
