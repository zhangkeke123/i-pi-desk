import { Briefcase, CalendarClock, FolderKanban, Settings } from 'lucide-react'

export interface IconRailProps {
  onWorkbench: () => void
  onTasks: () => void
  onProjects: () => void
  onSettings: () => void
  activeWorkbench: boolean
  activeTasks: boolean
  activeProjects: boolean
  activeSettings?: boolean
  version?: string
}

/**
 * 左栏导航：工作台 / 定时任务 / 项目置顶；设置沉底。
 * 选中态沿用 `.icon-btn` 方块底色，不与会话预览轨的横线指示混用。
 */
export function IconRail({
  onWorkbench,
  onTasks,
  onProjects,
  onSettings,
  activeWorkbench,
  activeTasks,
  activeProjects,
  activeSettings = false,
  version
}: IconRailProps): React.ReactElement {
  return (
    <nav
      className="shell-rail flex shrink-0 flex-col items-center border-r bg-[var(--color-sidebar)] py-2"
      aria-label="主导航"
    >
      <div className="drag h-3 w-full shrink-0" aria-hidden />
      <div className="no-drag flex flex-col items-center gap-1">
        <RailButton title="工作台" onClick={onWorkbench} active={activeWorkbench}>
          <Briefcase size={18} />
        </RailButton>
        <RailButton title="定时任务" onClick={onTasks} active={activeTasks}>
          <CalendarClock size={18} />
        </RailButton>
        <RailButton title="项目" onClick={onProjects} active={activeProjects}>
          <FolderKanban size={18} />
        </RailButton>
      </div>
      <div className="no-drag mt-auto flex flex-col items-center gap-1 pt-2">
        <RailButton title="设置" onClick={onSettings} active={activeSettings}>
          <Settings size={18} />
        </RailButton>
        {version ? (
          <span className="font-mono text-[9px] leading-none text-[var(--color-muted)] opacity-70">
            {version}
          </span>
        ) : null}
      </div>
    </nav>
  )
}

function RailButton({
  title,
  onClick,
  active,
  children
}: {
  title: string
  onClick: () => void
  active: boolean
  children: React.ReactNode
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className="icon-btn flex h-auto w-11 flex-col items-center gap-0.5 px-1 py-1.5"
      data-active={active ? 'true' : undefined}
      title={title}
      aria-label={title}
      aria-pressed={active}
    >
      {children}
      <span className="max-w-full truncate text-[9px] leading-tight text-[var(--color-muted)]">
        {title === '定时任务' ? '定时' : title}
      </span>
    </button>
  )
}
