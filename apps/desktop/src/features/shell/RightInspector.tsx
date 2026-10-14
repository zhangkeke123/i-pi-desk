import {
  Eye,
  FileSearch,
  FolderOpen,
  GitBranch,
  ListTodo,
  Plus,
  RefreshCw,
  SquareTerminal,
  X
} from 'lucide-react'
import { WorkspacePanel } from '../workspace/WorkspacePanel.js'
import { useLayoutStore, type InspectorTab } from '../../stores/layout-store.js'
import { SearchPanel } from './SearchPanel.js'
import { GitPanel } from './GitPanel.js'
import { TerminalSlot } from '../terminal/TerminalSlot.js'
import { useAppStore } from '../../stores/app-store.js'

type ArtifactTab = Exclude<InspectorTab, 'hub'>

const TABS: Array<{
  id: ArtifactTab
  label: string
  icon: typeof FolderOpen
}> = [
  { id: 'git', label: 'Changes', icon: Eye },
  { id: 'files', label: 'Files', icon: FolderOpen },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal },
  { id: 'search', label: 'Plan', icon: ListTodo }
]

/**
 * E · 右栏产物常驻：Changes / Files / Terminal / Plan。
 * 顶栏开关仍可折叠整栏；终端不再另占主区底栏。
 */
export function RightInspector(): React.ReactElement {
  const inspectorTab = useLayoutStore((s) => s.inspectorTab)
  const setInspectorTab = useLayoutStore((s) => s.setInspectorTab)
  const toggleInspector = useLayoutStore((s) => s.toggleInspector)
  const workspace = useAppStore((s) => s.currentWorkspace)
  const active: ArtifactTab = inspectorTab === 'hub' ? 'git' : inspectorTab
  const wide = active === 'files' || active === 'terminal'

  return (
    <aside
      className={`shell-inspector flex shrink-0 flex-col border-l bg-[var(--color-surface)] ${
        wide ? 'w-[360px]' : 'w-[320px]'
      }`}
      data-testid="right-inspector"
    >
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-[var(--color-divider)] bg-[var(--color-surface-2)] px-2">
        <p className="min-w-0 flex-1 truncate px-1 text-[12px] font-medium text-[var(--color-ink)]">
          产物
          {workspace ? (
            <span className="ml-1.5 font-mono text-[10px] font-normal text-[var(--color-muted)]">
              {workspace.name}
            </span>
          ) : null}
        </p>
        {active === 'files' && (
          <span className="mr-1 flex items-center gap-0.5 text-[var(--color-muted)]" aria-hidden>
            <Plus size={13} />
            <RefreshCw size={13} />
            <FileSearch size={13} />
          </span>
        )}
        {active === 'git' && (
          <GitBranch size={13} className="mr-1 text-[var(--color-muted)]" aria-hidden />
        )}
        <button type="button" onClick={toggleInspector} className="icon-btn h-7 w-7 shrink-0" title="关闭产物栏">
          <X size={14} />
        </button>
      </header>

      <div
        className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-[var(--color-divider)] px-1.5 py-1.5"
        role="tablist"
        aria-label="产物面板"
      >
        {TABS.map((tab) => {
          const on = active === tab.id
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={on}
              data-testid={`inspector-tab-${tab.id}`}
              onClick={() => setInspectorTab(tab.id)}
              className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[11.5px] transition-colors ${
                on
                  ? 'bg-[var(--color-surface)] text-[var(--color-ink)] shadow-sm'
                  : 'text-[var(--color-muted)] hover:bg-[var(--color-surface)]/70 hover:text-[var(--color-ink)]'
              }`}
            >
              <tab.icon size={12} />
              {tab.label}
            </button>
          )
        })}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden" role="tabpanel">
        {active === 'files' && <WorkspacePanel embedded onClose={toggleInspector} />}
        {active === 'search' && <PlanPane />}
        {active === 'git' && <GitPanel />}
        {active === 'terminal' && (
          <div className="flex min-h-0 flex-1 flex-col" data-testid="inspector-terminal">
            <TerminalSlot onClose={() => setInspectorTab('git')} />
          </div>
        )}
      </div>
    </aside>
  )
}

/** Plan：项目内搜索 + 简短指引（E 的第四页）。 */
function PlanPane(): React.ReactElement {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-[var(--color-border)] px-3 py-2">
        <p className="text-[12px] font-medium text-[var(--color-ink)]">Plan</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--color-muted)]">
          用搜索定位文件，再回对话里下指令；变更在 Changes 审阅。
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <SearchPanel projectEmptyHint />
      </div>
    </div>
  )
}
