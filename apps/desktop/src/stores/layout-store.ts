import { create } from 'zustand'
import { useAppStore } from './app-store.js'

/**
 * 右栏产物视图（AEI · E）。
 * - git：Changes（审阅）
 * - files：文件管理器
 * - terminal：嵌入式终端
 * - search：Plan（搜索 + 指引）
 * - hub：兼容旧导航入口，打开时落到 git
 */
export type InspectorTab = 'hub' | 'files' | 'search' | 'git' | 'terminal'

/** 左栏主入口：聊天侧栏 / 工作台 / 定时任务。 */
export type RailSection = 'projects' | 'workbench' | 'tasks'

const selectedGitRepoByWorkspace = new Map<string, string>()

function persistGitRepo(workspaceId: string | undefined, repoRelativePath: string): void {
  if (!workspaceId) return
  selectedGitRepoByWorkspace.set(workspaceId, repoRelativePath)
}

function readGitRepo(workspaceId: string | undefined): string {
  if (!workspaceId) return ''
  return selectedGitRepoByWorkspace.get(workspaceId) ?? ''
}

function normalizeTab(tab: InspectorTab): InspectorTab {
  return tab === 'hub' ? 'git' : tab
}

export interface LayoutState {
  sessionOpen: boolean
  inspectorOpen: boolean
  inspectorTab: InspectorTab
  /** @deprecated 终端改在右栏 tab；保留字段以免导航历史回放崩。 */
  terminalOpen: boolean
  tasksOpen: boolean
  railSection: RailSection
  selectedGitRepo: string

  setSessionOpen: (open: boolean) => void
  toggleSessionSidebar: () => void
  setInspectorTab: (tab: InspectorTab) => void
  openInspectorTab: (tab: InspectorTab) => void
  /** 回到工作台首页（不强制打开右栏）。 */
  openWorkbenchHub: () => void
  openProjects: () => void
  openTasks: () => void
  closeTasks: () => void
  toggleInspector: () => void
  /** 开合右栏 Terminal tab（顶栏「终端」按钮）。 */
  toggleTerminal: () => void
  setSelectedGitRepo: (repoRelativePath: string) => void
  syncGitRepoForWorkspace: (workspaceId: string | undefined) => void
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  sessionOpen: true,
  /** 产物栏默认隐藏；顶栏按钮 / 快捷键按需打开。 */
  inspectorOpen: false,
  inspectorTab: 'git',
  terminalOpen: false,
  tasksOpen: false,
  /** 默认首页 = 工作台（聊天主区），不是「项目」。 */
  railSection: 'workbench',
  selectedGitRepo: '',

  setSessionOpen(open) {
    set({ sessionOpen: open })
  },

  toggleSessionSidebar() {
    set({ sessionOpen: !get().sessionOpen })
  },

  setInspectorTab(tab) {
    const next = normalizeTab(tab)
    set({
      inspectorTab: next,
      inspectorOpen: true,
      tasksOpen: false,
      railSection: 'workbench',
      terminalOpen: next === 'terminal'
    })
  },

  openInspectorTab(tab) {
    const next = normalizeTab(tab)
    const { inspectorOpen, inspectorTab } = get()
    if (inspectorOpen && normalizeTab(inspectorTab) === next) {
      set({ inspectorOpen: false, terminalOpen: false, railSection: 'workbench' })
      return
    }
    set({
      inspectorOpen: true,
      inspectorTab: next,
      tasksOpen: false,
      railSection: 'workbench',
      terminalOpen: next === 'terminal'
    })
  },

  /** 回到工作台：侧栏开；右栏保持用户当前开合状态。 */
  openWorkbenchHub() {
    set({
      railSection: 'workbench',
      tasksOpen: false,
      sessionOpen: true,
      inspectorTab: normalizeTab(get().inspectorTab)
    })
  },

  openProjects() {
    set({
      railSection: 'projects',
      sessionOpen: true,
      tasksOpen: false
    })
  },

  openTasks() {
    const { tasksOpen, railSection } = get()
    if (railSection === 'tasks' && tasksOpen) {
      set({ tasksOpen: false, railSection: 'workbench' })
      return
    }
    // 定时任务走主从布局（二级列表 + 右侧详情）；会话侧栏由 App 在 tasksOpen 时整体替换，不改 sessionOpen。
    set({
      tasksOpen: true,
      inspectorOpen: false,
      railSection: 'tasks',
      terminalOpen: false
    })
  },

  closeTasks() {
    set({ tasksOpen: false, railSection: 'workbench' })
  },

  toggleInspector() {
    const next = !get().inspectorOpen
    set({
      inspectorOpen: next,
      tasksOpen: next ? false : get().tasksOpen,
      railSection: 'workbench',
      terminalOpen: next && normalizeTab(get().inspectorTab) === 'terminal'
    })
  },

  toggleTerminal() {
    get().openInspectorTab('terminal')
  },

  setSelectedGitRepo(repoRelativePath) {
    const workspaceId = useAppStore.getState().currentWorkspace?.id
    persistGitRepo(workspaceId, repoRelativePath)
    set({ selectedGitRepo: repoRelativePath })
  },

  syncGitRepoForWorkspace(workspaceId) {
    set({ selectedGitRepo: readGitRepo(workspaceId) })
  }
}))
