import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Copy,
  FolderOpen,
  FolderPlus,
  FolderTree,
  Loader2,
  MessageSquarePlus,
  Pencil,
  Pin,
  Plus,
  Search,
  Settings,
  SquareTerminal,
  Trash2,
  X,
  Zap
} from 'lucide-react'
import type { Session, SessionRunStatus } from '@i-pi-desk/shared'
import { useAppStore } from '../../stores/app-store.js'
import {
  SIDEBAR_COLORS,
  buildSessionSidebarSections,
  formatRelativeTime,
  resolveSessionStatus,
  sessionStatusLabel
} from '../../lib/session-groups.js'
import { SESSION_PAGE_SIZE, pageSessions } from '../../lib/session-page.js'

/**
 * 左侧会话栏。
 *
 * ## 为什么需要重命名与搜索
 *
 * 会话标题由首条用户消息自动派生（`deriveTitle`），这对「随手问一句」够用，
 * 但一旦开始按任务组织工作就不够了：几个会话很可能都是
 * 「帮我看看这个报错」开头的，列在一起根本分不清哪个是哪个。
 *
 * 而会话一多，滚动找就更不可行。所以这两件事要一起做：
 * 能改名（把标题变成自己认得出的东西）+ 能搜（不用滚动）。
 *
 * ## 交互上的两个选择
 *
 * - **双击标题进入重命名**，同时也提供悬停出现的铅笔按钮。
 *   双击是这类列表的通用手势（VS Code、Slack 都如此），但纯靠它不可发现，
 *   所以补一个可见入口。
 * - **搜索框只在会话数超过阈值时出现**。只有两三个会话时多一个输入框
 *   纯属噪音；搜索框的存在感应当与列表长度匹配。
 */
export function Sidebar({
  onOpenSettings,
  compact = false,
  onToggleFiles,
  onToggleTerminal,
  /** 为 true 时底部设置/文件/终端入口交给 IconRail，侧栏只留会话与工作区。 */
  hideChromeActions = false
}: {
  onOpenSettings: () => void
  /**
   * 窄窗口下折叠成图标条（见 lib/layout.ts 的阈值说明）。
   *
   * 折叠掉的是**列表**而不是功能：新建会话、打开文件面板、终端、设置都还在，
   * 只是换成了图标。这样窄窗口下聊天区能拿回 ~200px，而不是让用户去关面板。
   */
  compact?: boolean
  onToggleFiles?: () => void
  onToggleTerminal?: () => void
  hideChromeActions?: boolean
}): React.ReactElement {
  const workspaces = useAppStore((s) => s.workspaces)
  const currentWorkspace = useAppStore((s) => s.currentWorkspace)
  const sessions = useAppStore((s) => s.sessions)
  const currentSessionId = useAppStore((s) => s.currentSessionId)
  const pickWorkspace = useAppStore((s) => s.pickWorkspace)
  const openWorkspace = useAppStore((s) => s.openWorkspace)
  const newQuickSession = useAppStore((s) => s.newQuickSession)
  const newGuidedSession = useAppStore((s) => s.newGuidedSession)
  const newSessionInWorkspace = useAppStore((s) => s.newSessionInWorkspace)
  const selectSession = useAppStore((s) => s.selectSession)
  const removeSession = useAppStore((s) => s.removeSession)
  const duplicateSession = useAppStore((s) => s.duplicateSession)

  const [query, setQuery] = useState('')
  /** 正在重命名的会话 id（同一时刻只允许一个）。 */
  const [editingId, setEditingId] = useState<string | null>(null)
  /**
   * 会话列表分页（参考上游的「加载更多（N 条）」）。
   *
   * 默认 30：端到端跑完一轮会在夹具目录里留下近 20 个会话，取 30 能保证测试里
   * 所有会话都可见，于是那些「按标题找某一行」的断言不会因为分页失效
   * （分页本身仍然被断言覆盖）。
   */
  const [showAllSessions, setShowAllSessions] = useState(false)

  const editorDirty = useAppStore((s) => s.editorDirty)
  const busy = useAppStore((s) => s.busy)
  const pendingApprovals = useAppStore((s) => s.pendingApprovals)
  const workspaceError = useAppStore((s) => s.workspaceError)
  const clearWorkspaceError = useAppStore((s) => s.clearWorkspaceError)
  const forgetWorkspace = useAppStore((s) => s.forgetWorkspace)
  const setWorkspaceColor = useAppStore((s) => s.setWorkspaceColor)
  /**
   * 有未保存改动时，用户想切去的那个工作区（`'pick'` 表示要开目录选择框）。
   *
   * 切工作区会把整棵文件树与预览一起重置 —— 也就是**未保存的改动会消失**。
   * 之前这里是直接切的，连问都不问（和上一轮修掉的另外几条路是同一类问题）。
   *
   * `thenCreate`：D 版项目行内「＋」—— 切过去后再立刻建普通会话。
   */
  const [pendingWorkspace, setPendingWorkspace] = useState<
    { path: string; name: string; workspaceId?: string; thenCreate?: boolean } | 'pick' | null
  >(null)

  /** 切换工作区统一走这里：有未保存改动就先问一句。 */
  const requestWorkspace = (
    target: { path: string; name: string; workspaceId?: string; thenCreate?: boolean } | 'pick'
  ): void => {
    if (editorDirty) {
      setPendingWorkspace(target)
      return
    }
    if (target === 'pick') {
      void pickWorkspace()
      return
    }
    if (target.thenCreate && target.workspaceId) {
      void newSessionInWorkspace(target.workspaceId)
      return
    }
    void openWorkspace(target.path)
  }

  const confirmWorkspace = (): void => {
    const target = pendingWorkspace
    setPendingWorkspace(null)
    if (!target) return
    if (target === 'pick') {
      void pickWorkspace()
      return
    }
    if (target.thenCreate && target.workspaceId) {
      void newSessionInWorkspace(target.workspaceId)
      return
    }
    void openWorkspace(target.path)
  }

  /** D：在指定项目行内「＋」开会话（可能先切工作区）。 */
  const requestCreateInProject = (project: {
    workspaceId: string
    path: string
    name: string
  }): void => {
    requestWorkspace({
      path: project.path,
      name: project.name,
      workspaceId: project.workspaceId,
      thenCreate: true
    })
  }

  const normalizedQuery = query.trim().toLowerCase()
  const defaultWorkspacePath = useAppStore((s) => s.settings?.defaultWorkspacePath)
  /**
   * 跨项目列表（ZCode 哲学）：临时 / 置顶 / 按项目。
   * 点别的项目会话时由 selectSession 先切工作区，避免 cwd 错位。
   */
  const searchable = normalizedQuery
    ? sessions.filter((session) => session.title.toLowerCase().includes(normalizedQuery))
    : sessions
  const sections = useMemo(
    () => buildSessionSidebarSections(searchable, workspaces, defaultWorkspacePath),
    [searchable, workspaces, defaultWorkspacePath]
  )
  const totalListed =
    sections.temporary.length +
    sections.pinned.length +
    sections.projects.reduce((n, p) => n + p.items.length, 0)
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({})
  const [colorPickerFor, setColorPickerFor] = useState<
    { kind: 'session'; id: string } | { kind: 'project'; id: string } | null
  >(null)
  /** 项目行删除二次确认（workspaceId）。 */
  const [confirmRemoveProjectId, setConfirmRemoveProjectId] = useState<string | null>(null)

  /**
   * 紧凑模式：只剩图标。
   *
   * 宽度取 SIDEBAR_RAIL_WIDTH（与 lib/layout.ts 同一来源），不在这里写死数字 ——
   * 否则「版面算出来是 52，界面画成 56」这种分叉迟早出现。
   */
  if (compact) {
    return (
      <aside
        data-testid="sidebar-rail"
        className="shell-session flex w-[52px] shrink-0 flex-col items-center gap-1 border-r bg-[var(--color-sidebar)] py-2 text-[var(--color-sidebar-ink)]"
      >
        <button
          type="button"
          onClick={() => void newQuickSession()}
          className="icon-btn h-8 w-8"
          title="新建临时会话"
        >
          <Zap size={15} />
        </button>
        <button
          type="button"
          onClick={() => void newGuidedSession()}
          className="icon-btn h-8 w-8"
          title="新建普通会话（选项目）"
        >
          <MessageSquarePlus size={15} />
        </button>
        <button type="button" onClick={() => requestWorkspace('pick')} className="icon-btn h-8 w-8" title="新建项目 / 打开目录">
          <FolderPlus size={15} />
        </button>
        {!hideChromeActions && onToggleFiles && (
          <button type="button" onClick={onToggleFiles} className="icon-btn h-8 w-8" title="工作区文件">
            <FolderTree size={15} />
          </button>
        )}
        {!hideChromeActions && onToggleTerminal && (
          <button type="button" onClick={onToggleTerminal} className="icon-btn h-8 w-8" title="终端">
            <SquareTerminal size={15} />
          </button>
        )}
        {!hideChromeActions && (
          <button type="button" onClick={onOpenSettings} className="icon-btn mt-auto h-8 w-8" title="模型与设置">
            <Settings size={15} />
          </button>
        )}
      </aside>
    )
  }

  /**
   * 分页只作用在「普通会话」扁平化后的条数提示上；置顶 / 临时始终全显。
   * （派生值，不是 hook —— 紧凑模式提前 return 之后不能再加 hook。）
   */
  const flatNormal = sections.projects.flatMap((p) => p.items)
  const sessionPage = pageSessions(flatNormal, SESSION_PAGE_SIZE, showAllSessions)
  const hiddenSessions = sessionPage.hiddenCount
  const shownNormalIds = new Set(sessionPage.shown.map((s) => s.id))

  const renderSession = (session: Session, accent?: string): React.ReactElement =>
    editingId === session.id ? (
      <RenameRow session={session} onDone={() => setEditingId(null)} />
    ) : (
      <SessionRow
        session={session}
        active={session.id === currentSessionId}
        awaitsApproval={Boolean(pendingApprovals[session.id])}
        accentColor={session.color || accent}
        busy={busy && session.id === currentSessionId}
        onSelect={() => void selectSession(session.id)}
        onRename={() => setEditingId(session.id)}
        onDuplicate={() => void duplicateSession(session.id)}
        onRemove={() => void removeSession(session.id)}
        colorPickerOpen={colorPickerFor?.kind === 'session' && colorPickerFor.id === session.id}
        onToggleColorPicker={() =>
          setColorPickerFor((prev) =>
            prev?.kind === 'session' && prev.id === session.id ? null : { kind: 'session', id: session.id }
          )
        }
      />
    )

  /**
   * D 版「项目」段：有会话的项目组 + 已登记但尚无会话的目录。
   * 默认工作区只出现在「临时」段，不重复进项目列表。
   */
  const defaultPathNorm = defaultWorkspacePath?.trim().replace(/\\/g, '/').toLowerCase()
  const projectRows = (() => {
    const seen = new Set(sections.projects.map((p) => p.workspaceId))
    const extras = workspaces
      .filter((workspace) => {
        if (seen.has(workspace.id)) return false
        if (
          defaultPathNorm &&
          workspace.path.replace(/\\/g, '/').toLowerCase() === defaultPathNorm
        ) {
          return false
        }
        return true
      })
      .map((workspace) => ({
        workspaceId: workspace.id,
        name: workspace.name,
        path: workspace.path,
        color: workspace.color,
        items: [] as Session[]
      }))
    return [...sections.projects, ...extras]
  })()

  return (
    <aside className="shell-session flex w-[264px] shrink-0 flex-col border-r bg-[var(--color-sidebar)] text-[var(--color-sidebar-ink)]">
      {/* 拖拽条：产品名只保留窗口标题，侧栏不再重复贴牌 */}
      <div className="drag h-3 w-full shrink-0" aria-hidden />

      {/* D · 顶区只留「打开目录」；临时 / 普通会话入口跟层级走 */}
      <div className="px-2 pb-2">
        <button
          type="button"
          onClick={() => requestWorkspace('pick')}
          className="btn mt-0 w-full justify-start border border-dashed border-[var(--color-border-strong)] bg-transparent font-medium text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]"
          title="打开本地目录并登记为项目"
        >
          <FolderOpen size={14} />
          打开目录
        </button>
        {currentWorkspace && (
          <p className="mt-1.5 truncate px-1 font-mono text-2xs text-[var(--color-muted)]" title={currentWorkspace.path}>
            当前 · {currentWorkspace.name}
          </p>
        )}
      </div>

      {/*
        打开目录失败的提示。
        放在最上面（而不是贴着被点的那一项）：两个入口（选择目录 / 最近目录）都可能失败，
        位置固定才不会「点了没反应，不知道去哪看」。
      */}
      {workspaceError && (
        <div className="mx-2 mb-2 rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5 p-2">
          <p className="mb-1 text-[11px] leading-relaxed text-[var(--color-danger)]">
            打不开「{workspaceError.name || workspaceError.path}」
          </p>
          <p className="mb-2 text-[10px] leading-relaxed text-[var(--color-muted)]">{workspaceError.message}</p>
          <div className="flex items-center gap-2">
            {(() => {
              /**
               * 只在这个路径确实在最近列表里时才给「移除」——
               * 目录打不开最常见的原因就是它被删了/改名了，
               * 而一条永远打不开的记录留在列表里只会一直误点。
               */
              const stale = workspaces.find((workspace) => workspace.path === workspaceError.path)
              if (!stale) return null
              /**
               * 说清楚「移除」到底移除了什么。
               *
               * 移除只是把它从最近列表里去掉，**那个目录下的会话一条都不会删** ——
               * 重新打开同一目录就会原样回来（按路径复用同一条记录，所以 id 不变）。
               * 不写这一句的话，用户很容易以为「移除」等于「连同对话一起扔掉」，
               * 于是宁可留一条打不开的记录也不敢点。
               */
              const affected = sessions.filter((session) => session.workspaceId === stale.id).length
              return (
                <div className="flex flex-col gap-1">
                  {affected > 0 && (
                    <p className="text-[10px] leading-relaxed text-[var(--color-muted)]">
                      移除只是从列表里去掉：该目录下的 {affected} 个会话会保留，重新打开同一目录即可看到。
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => void forgetWorkspace(stale.id)}
                    className="self-start rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-ink)] hover:bg-[var(--color-surface-2)]"
                    title="从最近目录里移除"
                  >
                    从列表移除
                  </button>
                </div>
              )
            })()}
            <button
              type="button"
              onClick={clearWorkspaceError}
              className="rounded-md px-2 py-1 text-[11px] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
              title="知道了"
            >
              知道了
            </button>
          </div>
        </div>
      )}

      {/*
        切工作区前的确认。放在最上面（而不是贴着被点的那个按钮）：
        两个入口（选择目录 / 最近目录）都会走到这里，位置固定才不会「点了没反应」。
      */}
      {pendingWorkspace && (
        <div className="mx-2 mb-2 rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5 p-2">
          <p className="mb-2 text-[11px] leading-relaxed text-[var(--color-warn)]">
            有未保存的改动，切换工作区会丢弃它们
            {pendingWorkspace !== 'pick' ? `（前往「${pendingWorkspace.name}」）` : ''}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={confirmWorkspace}
              className="rounded-md border border-[var(--color-danger)]/50 px-2 py-1 text-[11px] text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10"
              title="丢弃改动并切换"
            >
              丢弃并切换
            </button>
            <button
              type="button"
              onClick={() => setPendingWorkspace(null)}
              className="rounded-md px-2 py-1 text-[11px] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
              title="取消切换"
            >
              取消
            </button>
          </div>
        </div>
      )}

      <div className="px-2 pb-2">
        <div className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2 py-1">
          <Search size={12} className="shrink-0 text-[var(--color-muted)]" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索会话 / 总结"
            aria-label="搜索会话"
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-[var(--color-muted)]"
          />
          {query.length > 0 && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="grid h-4 w-4 shrink-0 place-items-center rounded text-[var(--color-muted)] hover:text-[var(--color-ink)]"
              title="清空搜索"
            >
              <X size={11} />
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2" data-testid="session-sidebar-sections">
        {hiddenSessions > 0 && (
          <div className="flex justify-end px-2 pb-1 pt-1">
            <button
              type="button"
              onClick={() => setShowAllSessions(true)}
              className="font-mono text-2xs text-[var(--color-muted)] underline-offset-2 hover:text-[var(--color-ink)] hover:underline"
              title="展开全部会话"
            >
              加载更多（{hiddenSessions}）
            </button>
          </div>
        )}

        {sessions.length > 0 && totalListed === 0 && (
          <p className="px-2 py-6 text-center text-xs text-[var(--color-muted)]">
            没有匹配「{query.trim()}」的会话。
          </p>
        )}

        {sections.pinned.length > 0 && (
          <div data-testid="section-pinned">
            <p className="px-2 pb-0.5 pt-2 font-mono text-2xs uppercase tracking-[0.14em] text-[var(--color-muted)]">
              置顶 <span className="normal-case tracking-normal opacity-70">{sections.pinned.length}</span>
            </p>
            <ul className="space-y-0.5">
              {sections.pinned.map((session) => (
                <li key={session.id}>{renderSession(session)}</li>
              ))}
            </ul>
          </div>
        )}

        {/* D · 临时会话入口在「会话」段内 */}
        <div data-testid="section-temporary">
          <p className="px-2 pb-0.5 pt-2 font-mono text-2xs uppercase tracking-[0.14em] text-[var(--color-muted)]">
            会话 <span className="normal-case tracking-normal opacity-70">临时</span>
          </p>
          {sections.temporary.length === 0 ? (
            <button
              type="button"
              onClick={() => void newQuickSession()}
              className="mx-1 mb-1 flex w-[calc(100%-8px)] items-start gap-2 rounded-[var(--radius-md)] border border-dashed border-[var(--color-accent)]/45 bg-[var(--color-accent-soft)]/60 px-2.5 py-2 text-left transition-colors hover:bg-[var(--color-accent-soft)]"
              title="在默认工作空间新建临时会话"
              data-testid="create-temporary-session"
            >
              <Zap size={13} className="mt-0.5 shrink-0 text-[var(--color-accent)]" />
              <span className="min-w-0">
                <span className="block text-xs text-[var(--color-ink)]">暂无临时对话</span>
                <span className="mt-0.5 block text-2xs text-[var(--color-accent)]">＋ 新建临时</span>
              </span>
            </button>
          ) : (
            <>
              <ul className="space-y-0.5">
                {sections.temporary.map((session) => (
                  <li key={session.id}>{renderSession(session)}</li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => void newQuickSession()}
                className="mx-1 mt-0.5 flex w-[calc(100%-8px)] items-center gap-1.5 rounded-[var(--radius-sm)] px-2 py-1 text-2xs text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]"
                title="再建一条临时会话"
              >
                <Plus size={11} />
                新建临时
              </button>
            </>
          )}
        </div>

        {/* D · 普通会话：项目行内 ＋；新建项目在段底 */}
        <div data-testid="section-projects">
          <p className="px-2 pb-0.5 pt-3 font-mono text-2xs uppercase tracking-[0.14em] text-[var(--color-muted)]">
            项目
          </p>
          {projectRows.length === 0 && (
            <p className="px-2 py-2 text-2xs leading-relaxed text-[var(--color-muted)]">
              还没有项目。用下方「新建项目」打开本地目录。
            </p>
          )}
          {projectRows.map((project) => {
            const collapsed = collapsedProjects[project.workspaceId] === true
            const items = showAllSessions
              ? project.items
              : project.items.filter((s) => shownNormalIds.has(s.id) || project.items.length === 0)
            const isCurrent = project.workspaceId === currentWorkspace?.id
            const canCreate = Boolean(project.path)
            return (
              <div key={project.workspaceId} className="mb-0.5" data-testid="project-group">
                <div
                  className={`group/project flex items-center gap-1 rounded-[var(--radius-sm)] px-1.5 py-1 hover:bg-[var(--color-surface-2)] ${
                    isCurrent ? 'bg-[var(--color-accent-soft)]/70' : ''
                  }`}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    onClick={() => {
                      if (project.items.length === 0 && project.path) {
                        requestWorkspace({ path: project.path, name: project.name })
                        return
                      }
                      setCollapsedProjects((prev) => ({
                        ...prev,
                        [project.workspaceId]: !collapsed
                      }))
                    }}
                    title={project.path || project.name}
                  >
                    {project.items.length > 0 ? (
                      collapsed ? (
                        <ChevronRight size={12} className="shrink-0 text-[var(--color-muted)]" />
                      ) : (
                        <ChevronDown size={12} className="shrink-0 text-[var(--color-muted)]" />
                      )
                    ) : (
                      <span className="w-3 shrink-0" aria-hidden />
                    )}
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ background: project.color || 'var(--color-muted)' }}
                      aria-hidden
                    />
                    <span
                      className={`min-w-0 flex-1 truncate text-xs font-medium ${
                        isCurrent ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-soft)]'
                      }`}
                    >
                      {project.name}
                    </span>
                    <span className="shrink-0 font-mono text-2xs text-[var(--color-muted)] opacity-70">
                      {project.items.length > 0 ? project.items.length : '…'}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="hidden h-5 w-5 shrink-0 place-items-center rounded text-[var(--color-muted)] hover:text-[var(--color-ink)] group-hover/project:grid"
                    title="设置项目颜色"
                    onClick={() =>
                      setColorPickerFor((prev) =>
                        prev?.kind === 'project' && prev.id === project.workspaceId
                          ? null
                          : { kind: 'project', id: project.workspaceId }
                      )
                    }
                  >
                    <span
                      className="h-2.5 w-2.5 rounded-full border border-[var(--color-border)]"
                      style={{ background: project.color || 'transparent' }}
                    />
                  </button>
                  {confirmRemoveProjectId === project.workspaceId ? (
                    <span className="flex shrink-0 items-center gap-0.5 text-[10px]">
                      <button
                        type="button"
                        className="rounded border border-[var(--color-danger)]/50 px-1 py-0.5 text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10"
                        title="确认从列表移除（不删磁盘与会话）"
                        data-testid="project-row-remove-confirm"
                        onClick={() => {
                          setConfirmRemoveProjectId(null)
                          void forgetWorkspace(project.workspaceId)
                        }}
                      >
                        移除
                      </button>
                      <button
                        type="button"
                        className="rounded px-1 py-0.5 text-[var(--color-muted)] hover:text-[var(--color-ink)]"
                        onClick={() => setConfirmRemoveProjectId(null)}
                      >
                        取消
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="hidden h-5 w-5 shrink-0 place-items-center rounded text-[var(--color-muted)] hover:text-[var(--color-danger)] group-hover/project:grid"
                      title="从列表移除项目（会话保留）"
                      data-testid="project-row-remove"
                      onClick={() => setConfirmRemoveProjectId(project.workspaceId)}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                  {/* ＋ 固定最右侧：在此项目下新建会话；删除悬停出现在其左侧 */}
                  <button
                    type="button"
                    className="grid h-5 w-5 shrink-0 place-items-center rounded border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-ink)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-40"
                    title={canCreate ? `在「${project.name}」新建普通会话` : '缺少目录路径，无法建会话'}
                    disabled={!canCreate}
                    data-testid="project-row-new-session"
                    onClick={() =>
                      requestCreateInProject({
                        workspaceId: project.workspaceId,
                        path: project.path,
                        name: project.name
                      })
                    }
                  >
                    <Plus size={12} />
                  </button>
                </div>
                {confirmRemoveProjectId === project.workspaceId && (
                  <p className="px-2 pb-1 text-[10px] leading-relaxed text-[var(--color-muted)]">
                    只从列表去掉「{project.name}」：磁盘目录与会话都会保留，重新打开即可看到。
                  </p>
                )}
                {colorPickerFor?.kind === 'project' && colorPickerFor.id === project.workspaceId && (
                  <ColorSwatches
                    current={project.color}
                    onPick={(color) => {
                      void setWorkspaceColor(project.workspaceId, color)
                      setColorPickerFor(null)
                    }}
                  />
                )}
                {!collapsed && items.length > 0 && (
                  <ul className="space-y-0.5 pl-1">
                    {items.map((session) => (
                      <li key={session.id}>{renderSession(session, project.color)}</li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
          <div className="px-1 pb-3 pt-1">
            <button
              type="button"
              onClick={() => requestWorkspace('pick')}
              className="btn w-full justify-center border border-dashed border-[var(--color-border-strong)] bg-transparent text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]"
              title="打开本地目录并登记为项目"
              data-testid="create-project"
            >
              <FolderPlus size={14} />
              新建项目
            </button>
          </div>
        </div>
      </div>

      {!hideChromeActions && (
        <div className="border-t border-[var(--color-border)] p-2">
          <button
            type="button"
            onClick={onOpenSettings}
            className="flex w-full items-center gap-2 rounded-[var(--radius-md)] px-2 py-2 text-xs text-[var(--color-muted)] transition-colors hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]"
          >
            <Settings size={14} />
            模型与设置
          </button>
        </div>
      )}
    </aside>
  )
}

function StatusIcon({ status }: { status: SessionRunStatus }): React.ReactElement {
  const common = 'shrink-0'
  switch (status) {
    case 'new':
      return <Circle size={12} className={`${common} text-[var(--color-muted)]`} aria-label="新建" />
    case 'running':
      return (
        <Loader2
          size={12}
          className={`${common} animate-spin text-[var(--color-accent)]`}
          aria-label="进行中"
        />
      )
    case 'done':
      return (
        <CheckCircle2 size={12} className={`${common} text-[var(--color-ok)]`} aria-label="已完成" />
      )
    case 'error':
      return (
        <AlertTriangle size={12} className={`${common} text-[var(--color-warn)]`} aria-label="异常" />
      )
  }
}

function ColorSwatches({
  current,
  onPick
}: {
  current?: string
  onPick: (color: string | undefined) => void
}): React.ReactElement {
  return (
    <div className="mb-1 flex flex-wrap items-center gap-1 px-2 py-1" data-testid="color-swatches">
      {SIDEBAR_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          className={`h-4 w-4 rounded-full border ${
            current === color ? 'border-[var(--color-ink)]' : 'border-transparent'
          }`}
          style={{ background: color }}
          title={color}
          onClick={() => onPick(color)}
        />
      ))}
      <button
        type="button"
        className="rounded px-1 text-[10px] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
        onClick={() => onPick(undefined)}
        title="清除颜色"
      >
        清除
      </button>
    </div>
  )
}

function SessionRow({
  session,
  active,
  awaitsApproval,
  accentColor,
  busy,
  onSelect,
  onRename,
  onDuplicate,
  onRemove,
  colorPickerOpen,
  onToggleColorPicker
}: {
  session: Session
  active: boolean
  awaitsApproval: boolean
  accentColor?: string
  busy?: boolean
  onSelect: () => void
  onRename: () => void
  onDuplicate: () => void
  onRemove: () => void
  colorPickerOpen: boolean
  onToggleColorPicker: () => void
}): React.ReactElement {
  const [confirming, setConfirming] = useState(false)
  const setPinned = useAppStore((s) => s.setPinned)
  const patchSession = useAppStore((s) => s.patchSession)
  const status = resolveSessionStatus(session, { busy, awaitsApproval })

  return (
    <div
      className={`group relative rounded-[var(--radius-md)] transition-colors ${
        active
          ? 'bg-[var(--color-accent-soft)] text-[var(--color-ink)]'
          : 'text-[var(--color-muted)] hover:bg-[var(--color-surface-2)]'
      }`}
      onMouseLeave={() => setConfirming(false)}
    >
      <div className="relative flex items-start gap-1.5 py-1.5 pl-3 pr-2">
        {(active || accentColor) && (
          <span
            aria-hidden
            className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full"
            style={{ background: accentColor || 'var(--color-accent)' }}
          />
        )}
        <span className="mt-0.5">
          <StatusIcon status={status} />
        </span>
        <button
          type="button"
          onClick={onSelect}
          onDoubleClick={onRename}
          className="min-w-0 flex-1 text-left"
          title={`${session.title}（双击重命名）`}
        >
          <span className="block truncate text-xs">{session.title}</span>
          <span className="mt-0.5 block truncate font-mono text-2xs opacity-60">
            {awaitsApproval ? '待确认' : sessionStatusLabel(status)}
            {session.messageCount > 0 ? ` · ${session.messageCount} 条` : ''}
          </span>
        </button>
        <span className="mt-0.5 shrink-0 font-mono text-2xs opacity-50 group-hover:hidden">
          {status === 'running' ? '进行中' : formatRelativeTime(session.updatedAt)}
        </span>
        {awaitsApproval && (
          <span
            className="shrink-0 animate-pulse rounded px-1 text-[10px] text-[var(--color-warn)]"
            title="有操作等待你的确认，切回这个会话即可处理"
            data-testid="awaiting-approval"
          >
            待确认
          </span>
        )}
        <button
          type="button"
          onClick={() => void setPinned(session.id, session.pinned !== true)}
          className={`h-6 w-6 shrink-0 place-items-center rounded text-[var(--color-muted)] hover:text-[var(--color-ink)] ${
            session.pinned === true ? 'grid text-[var(--color-accent)]' : 'hidden group-hover:grid'
          }`}
          title={session.pinned === true ? '取消置顶' : '置顶会话'}
          data-testid="pin-session"
        >
          <Pin size={12} />
        </button>
        <button
          type="button"
          onClick={onRename}
          className="hidden h-6 w-6 shrink-0 place-items-center rounded text-[var(--color-muted)] hover:text-[var(--color-ink)] group-hover:grid"
          title="重命名"
          data-testid="rename-session"
        >
          <Pencil size={12} />
        </button>
        <button
          type="button"
          onClick={onDuplicate}
          className="hidden h-6 w-6 shrink-0 place-items-center rounded text-[var(--color-muted)] hover:text-[var(--color-ink)] group-hover:grid"
          title="复制会话"
          data-testid="duplicate-session"
        >
          <Copy size={12} />
        </button>
        {confirming ? (
          <span className="flex shrink-0 items-center gap-1 text-[11px]">
            <button
              type="button"
              onClick={() => {
                setConfirming(false)
                onRemove()
              }}
              className="rounded border border-[var(--color-danger)]/50 px-1.5 py-0.5 text-[var(--color-danger)] hover:bg-[var(--color-danger)]/20"
              title="确认删除会话"
            >
              删除
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded border border-[var(--color-border)] px-1.5 py-0.5 hover:bg-[var(--color-surface-2)]"
              title="取消删除会话"
            >
              取消
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="hidden h-6 w-6 shrink-0 place-items-center rounded text-[var(--color-muted)] hover:text-[var(--color-danger)] group-hover:grid"
            title="删除会话"
            data-testid="delete-session"
          >
            <Trash2 size={13} />
          </button>
        )}
        <button
          type="button"
          onClick={onToggleColorPicker}
          className="hidden h-6 w-6 shrink-0 place-items-center rounded text-[var(--color-muted)] hover:text-[var(--color-ink)] group-hover:grid"
          title="设置会话颜色"
        >
          <span
            className="h-2.5 w-2.5 rounded-full border border-[var(--color-border)]"
            style={{ background: session.color || accentColor || 'transparent' }}
          />
        </button>
      </div>
      {colorPickerOpen && (
        <ColorSwatches
          current={session.color}
          onPick={(color) => {
            void patchSession(session.id, { color: color ?? null })
            onToggleColorPicker()
          }}
        />
      )}
    </div>
  )
}

/**
 * 重命名输入行。
 *
 * 关键点是**自动聚焦并全选**：用户点了「重命名」就是要改名，
 * 让他还要再点一次输入框、再手动选掉旧标题，是最容易让人放弃的那种摩擦。
 */
function RenameRow({ session, onDone }: { session: Session; onDone: () => void }): React.ReactElement {
  const renameSession = useAppStore((s) => s.renameSession)
  const [draft, setDraft] = useState(session.title)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const commit = async (): Promise<void> => {
    const trimmed = draft.trim()
    // 没改动就直接收起；空标题同样收起（不改名），见 store 里的说明。
    if (trimmed === session.title || trimmed.length === 0) {
      onDone()
      return
    }
    try {
      await renameSession(session.id, trimmed)
      onDone()
    } catch (err) {
      // 失败时**留在编辑态并显示原因**：收起输入框会让人以为改成功了。
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="rounded-md bg-[var(--color-surface-2)] px-1.5 py-1">
      <input
        ref={inputRef}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
          setError(null)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            void commit()
          }
          // Esc 撤销本次编辑（不保存），这是输入框的通用预期。
          if (event.key === 'Escape') {
            event.preventDefault()
            onDone()
          }
        }}
        aria-label="会话标题"
        className="w-full bg-transparent text-[13px] text-[var(--color-ink)] outline-none"
      />
      <div className="mt-1 flex items-center gap-1">
        <button
          type="button"
          onClick={() => void commit()}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--color-ok)] hover:bg-[var(--color-surface)]"
        >
          <Check size={11} />
          保存
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded px-1.5 py-0.5 text-[11px] text-[var(--color-muted)] hover:bg-[var(--color-surface)]"
        >
          取消
        </button>
        <span className="ml-auto text-[10px] text-[var(--color-muted)]">Enter 保存 · Esc 取消</span>
      </div>
      {error && <p className="mt-1 text-[11px] text-[var(--color-danger)]">{error}</p>}
    </div>
  )
}
