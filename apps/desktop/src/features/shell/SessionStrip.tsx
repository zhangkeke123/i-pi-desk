import { Plus } from 'lucide-react'
import type { Session } from '@i-pi-desk/shared'
import { useAppStore } from '../../stores/app-store.js'
import {
  formatRelativeTime,
  resolveSessionStatus,
  sessionStatusLabel
} from '../../lib/session-groups.js'

/**
 * I · 会话摘要条：当前项目内会话横滑切换，日常少回左栏翻列表。
 */
export function SessionStrip(): React.ReactElement | null {
  const currentWorkspace = useAppStore((s) => s.currentWorkspace)
  const currentSessionId = useAppStore((s) => s.currentSessionId)
  const sessions = useAppStore((s) => s.sessions)
  const pendingApprovals = useAppStore((s) => s.pendingApprovals)
  const busy = useAppStore((s) => s.busy)
  const selectSession = useAppStore((s) => s.selectSession)
  const newSession = useAppStore((s) => s.newSession)

  if (!currentWorkspace) return null

  const projectSessions = sessions
    .filter((session) => session.workspaceId === currentWorkspace.id)
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  if (projectSessions.length === 0) return null

  return (
    <div
      className="session-strip flex shrink-0 gap-2 overflow-x-auto border-b border-[var(--color-divider)] bg-[var(--color-canvas)] px-3 py-2"
      data-testid="session-strip"
      role="list"
      aria-label="当前项目会话摘要"
    >
      {projectSessions.map((session) => (
        <StripCard
          key={session.id}
          session={session}
          active={session.id === currentSessionId}
          awaitsApproval={Boolean(pendingApprovals[session.id])}
          busy={busy && session.id === currentSessionId}
          onSelect={() => void selectSession(session.id)}
        />
      ))}
      <button
        type="button"
        role="listitem"
        className="session-strip__card session-strip__card--new flex min-w-[140px] shrink-0 flex-col items-start gap-0.5 rounded-[var(--radius-md)] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 py-2 text-left transition-colors hover:bg-[var(--color-surface-2)]"
        onClick={() => void newSession()}
        title="在此项目新建会话"
      >
        <span className="flex items-center gap-1 text-xs font-medium text-[var(--color-ink)]">
          <Plus size={12} />
          新会话
        </span>
        <span className="font-mono text-2xs text-[var(--color-muted)]">在此项目</span>
      </button>
    </div>
  )
}

function StripCard({
  session,
  active,
  awaitsApproval,
  busy,
  onSelect
}: {
  session: Session
  active: boolean
  awaitsApproval: boolean
  busy: boolean
  onSelect: () => void
}): React.ReactElement {
  const status = resolveSessionStatus(session, { busy, awaitsApproval })
  const label = awaitsApproval ? '待确认' : sessionStatusLabel(status)
  const blurb = sessionBlurb(session, label)

  return (
    <button
      type="button"
      role="listitem"
      data-testid="session-strip-card"
      data-active={active ? 'true' : undefined}
      onClick={onSelect}
      className={`session-strip__card flex min-w-[168px] max-w-[220px] shrink-0 flex-col items-start gap-0.5 rounded-[var(--radius-md)] border px-2.5 py-2 text-left transition-colors ${
        active
          ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
          : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)]'
      }`}
      title={session.title}
    >
      <span className="w-full truncate text-xs font-medium text-[var(--color-ink)]">{session.title}</span>
      <span className="w-full truncate font-mono text-2xs text-[var(--color-muted)]">{blurb}</span>
    </button>
  )
}

function sessionBlurb(session: Session, statusLabel: string): string {
  const time = formatRelativeTime(session.updatedAt)
  if (session.pinned) return `${statusLabel} · 置顶${time ? ` · ${time}` : ''}`
  return time ? `${statusLabel} · ${time}` : statusLabel
}
