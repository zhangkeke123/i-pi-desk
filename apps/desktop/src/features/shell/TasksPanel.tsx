import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, Plus, Search, Trash2 } from 'lucide-react'
import type { ScheduledTask } from '@i-pi-desk/shared'
import { call, getDesk, IpcError } from '../../lib/desk.js'
import { thinkingLabel } from '../../lib/thinking.js'
import { useAppStore } from '../../stores/app-store.js'
import {
  formatLastRunAt,
  formatTaskTime,
  repeatLabel,
  taskStatusLabel
} from './scheduled-task-labels.js'
import { ScheduledTaskModal, type ScheduledTaskDraft } from './ScheduledTaskModal.js'

/**
 * 定时任务主从视图：二级「定时任务列表」（状态 + 最近执行时间）+ 右侧「任务详情」。
 * 数据落盘 `%APPDATA%/i-pi-desk/scheduled-tasks.json`；执行调度尚未接入，
 * lastRunAt 为空时展示「尚未执行」。
 */
export function TasksPanel(): React.ReactElement {
  const providers = useAppStore((s) => s.providers)
  const [tasks, setTasks] = useState<ScheduledTask[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setLoadError(null)
    try {
      setTasks(await call(getDesk().scheduledTasks.list()))
    } catch (err) {
      setLoadError(err instanceof IpcError ? err.message : String(err))
      setTasks([])
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const persist = async (next: ScheduledTask[]): Promise<void> => {
    setSaving(true)
    setLoadError(null)
    try {
      setTasks(await call(getDesk().scheduledTasks.save(next)))
    } catch (err) {
      setLoadError(err instanceof IpcError ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const filtered = useMemo(() => {
    const list = tasks ?? []
    const q = query.trim().toLowerCase()
    if (!q) return list
    return list.filter((t) => t.description.toLowerCase().includes(q))
  }, [tasks, query])

  useEffect(() => {
    if (tasks === null) return
    if (selectedId && tasks.some((t) => t.id === selectedId)) return
    setSelectedId(filtered[0]?.id ?? tasks[0]?.id ?? null)
  }, [tasks, filtered, selectedId])

  const selected = useMemo(
    () => (tasks ?? []).find((t) => t.id === selectedId) ?? null,
    [tasks, selectedId]
  )

  const modelLabel = useCallback(
    (task: ScheduledTask): string => {
      if (!task.providerId || !task.modelId) return '未指定'
      for (const provider of providers ?? []) {
        if (provider.id !== task.providerId) continue
        const model = (provider.models ?? []).find((m) => m.id === task.modelId)
        return `${provider.label} · ${model?.label ?? task.modelId}`
      }
      return `${task.providerId} · ${task.modelId}`
    },
    [providers]
  )

  const handleCreate = (draft: ScheduledTaskDraft): void => {
    const task: ScheduledTask = {
      ...draft,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString()
    }
    void persist([...(tasks ?? []), task]).then(() => {
      setModalOpen(false)
      setSelectedId(task.id)
    })
  }

  const patchSelected = (patch: Partial<ScheduledTask>): void => {
    if (!selected || !tasks) return
    const next = tasks.map((t) => (t.id === selected.id ? { ...t, ...patch } : t))
    void persist(next)
  }

  const handleDelete = (): void => {
    if (!selected || !tasks) return
    const next = tasks.filter((t) => t.id !== selected.id)
    void persist(next).then(() => {
      setSelectedId(next[0]?.id ?? null)
    })
  }

  return (
    <>
      <div className="flex min-w-0 flex-1" data-testid="tasks-panel">
        <aside className="flex w-[300px] shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]">
          <header className="flex h-11 shrink-0 items-center gap-2 px-3">
            <p className="flex-1 text-[13px] font-semibold text-[var(--color-ink)]">定时任务列表</p>
            <button
              type="button"
              className="icon-btn h-7 w-7"
              title="搜索任务"
              aria-pressed={searchOpen}
              data-active={searchOpen ? 'true' : undefined}
              onClick={() => setSearchOpen((v) => !v)}
            >
              <Search size={14} />
            </button>
          </header>

          {searchOpen ? (
            <div className="border-b border-[var(--color-border)] px-3 pb-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="筛选任务说明…"
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-[12px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-muted)]"
                autoFocus
              />
            </div>
          ) : null}

          <div className="px-3 pb-2">
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="flex w-full items-center justify-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] py-2 text-[12px] text-[var(--color-ink)] hover:bg-[var(--color-surface-3)]"
            >
              <Plus size={14} />
              新建任务
            </button>
          </div>

          {loadError ? (
            <p className="px-3 pb-2 text-[11px] text-[var(--color-danger)]">{loadError}</p>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {tasks === null ? (
              <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-[var(--color-muted)]">
                <Loader2 size={14} className="animate-spin" />
                加载中…
              </div>
            ) : filtered.length === 0 ? (
              <p className="py-8 text-center text-[12px] text-[var(--color-muted)]">暂无已安排的任务</p>
            ) : (
              <ul className="space-y-1" role="listbox" aria-label="定时任务列表">
                {filtered.map((task) => {
                  const active = task.id === selectedId
                  return (
                    <li key={task.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={active}
                        data-active={active ? 'true' : undefined}
                        onClick={() => setSelectedId(task.id)}
                        className={`w-full rounded-lg border px-2.5 py-2 text-left transition-colors ${
                          active
                            ? 'border-[var(--color-border-strong)] bg-[var(--color-accent-soft)]'
                            : 'border-transparent bg-transparent hover:bg-[var(--color-surface-2)]'
                        }`}
                      >
                        <p className="line-clamp-2 text-[12px] leading-snug text-[var(--color-ink)]">
                          {task.description}
                        </p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-[var(--color-muted)]">
                          <span
                            className={`inline-flex items-center gap-1 ${
                              task.enabled ? 'text-[var(--color-accent)]' : ''
                            }`}
                          >
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${
                                task.enabled
                                  ? 'bg-[var(--color-accent)]'
                                  : 'bg-[var(--color-muted)]'
                              }`}
                              aria-hidden
                            />
                            状态 · {taskStatusLabel(task.enabled)}
                          </span>
                          <span className="text-[var(--color-border-strong)]">·</span>
                          <span>最近 · {formatLastRunAt(task.lastRunAt)}</span>
                        </div>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          {saving ? (
            <div className="border-t border-[var(--color-border)] px-3 py-1.5 text-[10px] text-[var(--color-muted)]">
              保存中…
            </div>
          ) : null}
        </aside>

        <section
          className="flex min-w-0 flex-1 flex-col bg-[var(--color-canvas)]"
          data-testid="task-detail"
          aria-label="任务详情"
        >
          <header className="flex h-11 shrink-0 items-center border-b border-[var(--color-border)] px-5">
            <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">任务详情</h2>
          </header>

          {!selected ? (
            <div className="flex flex-1 items-center justify-center px-6 text-[13px] text-[var(--color-muted)]">
              选择左侧任务查看详情，或新建一个定时任务
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-[var(--color-ink)]">
                {selected.description}
              </p>

              <dl className="mt-5 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
                <DetailRow label="状态">
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        selected.enabled ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-muted)]'
                      }`}
                      aria-hidden
                    />
                    {taskStatusLabel(selected.enabled)}
                  </span>
                </DetailRow>
                <DetailRow label="最近执行时间">{formatLastRunAt(selected.lastRunAt)}</DetailRow>
                <DetailRow label="重复">{repeatLabel(selected.repeat)}</DetailRow>
                <DetailRow label="时间">
                  {formatTaskTime(selected.timeLocal, selected.timezoneLabel)}
                </DetailRow>
                <DetailRow label="模型">{modelLabel(selected)}</DetailRow>
                <DetailRow label="强度">{thinkingLabel(selected.thinkingLevel)}</DetailRow>
                <DetailRow label="每次新聊天">{selected.newChatEachRun ? '是' : '否'}</DetailRow>
                <DetailRow label="创建时间">{formatLastRunAt(selected.createdAt)}</DetailRow>
              </dl>

              <div className="mt-5 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn btn-outline px-3 py-1.5 text-[12px]"
                  onClick={() => patchSelected({ enabled: !selected.enabled })}
                >
                  {selected.enabled ? '暂停任务' : '启用任务'}
                </button>
                <button
                  type="button"
                  className="btn btn-outline inline-flex items-center gap-1 px-3 py-1.5 text-[12px] text-[var(--color-danger)]"
                  onClick={handleDelete}
                >
                  <Trash2 size={13} />
                  删除
                </button>
              </div>

              <p className="mt-6 text-[11px] leading-relaxed text-[var(--color-muted)]">
                执行调度尚未接入：状态由「启用/暂停」控制；最近执行时间在调度跑通后才会写入。
              </p>
            </div>
          )}
        </section>
      </div>

      <ScheduledTaskModal open={modalOpen} onClose={() => setModalOpen(false)} onCreate={handleCreate} />
    </>
  )
}

function DetailRow({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="flex items-start justify-between gap-4 border-t border-[var(--color-border)] px-3.5 py-2.5 first:border-t-0">
      <dt className="shrink-0 text-[12px] text-[var(--color-muted)]">{label}</dt>
      <dd className="min-w-0 text-right text-[12px] text-[var(--color-ink)]">{children}</dd>
    </div>
  )
}
