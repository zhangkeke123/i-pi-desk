import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import type { ScheduledTask, ScheduledTaskRepeat, ThinkingLevelValue } from '@i-pi-desk/shared'
import { useAppStore } from '../../stores/app-store.js'
import { COMMON_THINKING_LEVELS, thinkingLabel } from '../../lib/thinking.js'
import {
  buildTimeOptions,
  DEFAULT_TIMEZONE_LABEL,
  REPEAT_OPTIONS
} from './scheduled-task-labels.js'

export type ScheduledTaskDraft = Omit<ScheduledTask, 'id' | 'createdAt'>

export function defaultTaskDraft(settings: {
  defaultProviderId?: string
  defaultModelId?: string
  thinkingLevel?: ThinkingLevelValue
} | null): ScheduledTaskDraft {
  return {
    description: '',
    repeat: 'daily',
    timeLocal: '09:00',
    timezoneLabel: DEFAULT_TIMEZONE_LABEL,
    newChatEachRun: false,
    providerId: settings?.defaultProviderId,
    modelId: settings?.defaultModelId,
    thinkingLevel: settings?.thinkingLevel ?? 'medium',
    enabled: true
  }
}

export function ScheduledTaskModal({
  open,
  onClose,
  onCreate
}: {
  open: boolean
  onClose: () => void
  onCreate: (draft: ScheduledTaskDraft) => void
}): React.ReactElement | null {
  const settings = useAppStore((s) => s.settings)
  const providers = useAppStore((s) => s.providers)

  const [draft, setDraft] = useState<ScheduledTaskDraft>(() => defaultTaskDraft(settings ?? null))
  const [advancedOpen, setAdvancedOpen] = useState(true)

  const timeOptions = useMemo(() => buildTimeOptions(), [])

  const modelOptions = useMemo(() => {
    const rows: { providerId: string; modelId: string; label: string }[] = []
    for (const provider of providers ?? []) {
      for (const model of provider.models ?? []) {
        rows.push({
          providerId: provider.id,
          modelId: model.id,
          label: `${provider.label} · ${model.label ?? model.id}`
        })
      }
    }
    return rows
  }, [providers])

  useEffect(() => {
    if (!open) return
    setDraft(defaultTaskDraft(settings ?? null))
    setAdvancedOpen(true)
  }, [open, settings])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const modelKey =
    draft.providerId && draft.modelId ? `${draft.providerId}::${draft.modelId}` : ''
  const canCreate = draft.description.trim().length > 0

  return (
    <div
      className="fixed inset-0 z-[55] grid place-items-center bg-[var(--color-overlay)] p-6 backdrop-blur-[2px]"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        className="flex max-h-[min(90vh,720px)] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-lg)]"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="scheduled-task-modal-title"
        data-testid="scheduled-task-modal"
      >
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-4">
          <h2 id="scheduled-task-modal-title" className="text-[13px] font-medium text-[var(--color-ink)]">
            设置定时任务
          </h2>
          <button type="button" onClick={onClose} className="icon-btn ml-auto h-7 w-7" title="关闭">
            <X size={14} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <textarea
            value={draft.description}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
            placeholder="说明..."
            rows={5}
            className="w-full resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2.5 text-[13px] leading-relaxed text-[var(--color-ink)] outline-none placeholder:text-[var(--color-muted)] focus:border-[var(--color-border-strong)]"
          />

          <div className="mt-4 overflow-hidden rounded-lg border border-[var(--color-border)]">
            <FieldRow label="重复">
              <select
                value={draft.repeat}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, repeat: e.target.value as ScheduledTaskRepeat }))
                }
                className="task-select"
              >
                {REPEAT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </FieldRow>
            <FieldRow label="时间" borderTop>
              <select
                value={draft.timeLocal}
                onChange={(e) => setDraft((d) => ({ ...d, timeLocal: e.target.value }))}
                className="task-select"
              >
                {timeOptions.map((t) => (
                  <option key={t} value={t}>
                    {DEFAULT_TIMEZONE_LABEL} {t}
                  </option>
                ))}
              </select>
            </FieldRow>
          </div>

          <section className="mt-4">
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              className="flex w-full items-center gap-1 py-1 text-[12px] font-medium text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
            >
              高级
              {advancedOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>

            {advancedOpen ? (
              <div className="mt-2 overflow-hidden rounded-lg border border-[var(--color-border)]">
                <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <span className="text-[12px] text-[var(--color-ink)]">每次运行时都开启新聊天</span>
                  <ToggleSwitch
                    checked={draft.newChatEachRun}
                    onChange={(checked) => setDraft((d) => ({ ...d, newChatEachRun: checked }))}
                  />
                </div>
                <FieldRow label="模型" borderTop>
                  <select
                    value={modelKey}
                    onChange={(e) => {
                      const [providerId, modelId] = e.target.value.split('::')
                      setDraft((d) => ({ ...d, providerId, modelId }))
                    }}
                    className="task-select"
                    disabled={modelOptions.length === 0}
                  >
                    {modelOptions.length === 0 ? (
                      <option value="">未配置模型</option>
                    ) : (
                      modelOptions.map((m) => (
                        <option key={`${m.providerId}::${m.modelId}`} value={`${m.providerId}::${m.modelId}`}>
                          {m.label}
                        </option>
                      ))
                    )}
                  </select>
                </FieldRow>
                <FieldRow label="强度" borderTop>
                  <select
                    value={draft.thinkingLevel}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        thinkingLevel: e.target.value as ThinkingLevelValue
                      }))
                    }
                    className="task-select"
                  >
                    {COMMON_THINKING_LEVELS.map((value) => (
                      <option key={value} value={value}>
                        {thinkingLabel(value)}
                      </option>
                    ))}
                  </select>
                </FieldRow>
              </div>
            ) : null}
          </section>
        </div>

        <footer className="flex shrink-0 justify-end gap-2 border-t border-[var(--color-border)] px-4 py-3">
          <button type="button" onClick={onClose} className="btn btn-outline px-4 py-1.5 text-[12px]">
            取消
          </button>
          <button
            type="button"
            disabled={!canCreate}
            onClick={() => {
              if (!canCreate) return
              onCreate({ ...draft, description: draft.description.trim() })
            }}
            className="btn btn-primary px-4 py-1.5 text-[12px]"
          >
            创建
          </button>
        </footer>
      </div>
    </div>
  )
}

function FieldRow({
  label,
  children,
  borderTop
}: {
  label: string
  children: React.ReactNode
  borderTop?: boolean
}): React.ReactElement {
  return (
    <div
      className={`flex items-center justify-between gap-3 px-3 py-2.5 ${borderTop ? 'border-t border-[var(--color-border)]' : ''}`}
    >
      <span className="shrink-0 text-[12px] text-[var(--color-muted)]">{label}</span>
      <div className="min-w-0 flex-1 text-right">{children}</div>
    </div>
  )
}

function ToggleSwitch({
  checked,
  onChange
}: {
  checked: boolean
  onChange: (checked: boolean) => void
}): React.ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${
        checked
          ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
          : 'border-[var(--color-border)] bg-[var(--color-surface-2)]'
      }`}
    >
      <span
        className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-[var(--color-ink)] transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}
