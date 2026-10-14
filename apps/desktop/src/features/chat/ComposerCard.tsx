import { useEffect, useId, useRef, useState } from 'react'
import {
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  Cpu,
  Hourglass,
  ShieldCheck,
  Square
} from 'lucide-react'
import { useAppStore } from '../../stores/app-store.js'
import { PERMISSION_HINT, PERMISSION_LABEL } from '../../lib/labels.js'
import { formatElapsed } from '../../lib/run-status.js'
import {
  COMMON_THINKING_LEVELS,
  normalizeThinkingLevel,
  thinkingHint,
  thinkingLabel
} from '../../lib/thinking.js'

/** 自定义下拉：避免原生 select 系统蓝块，与 chip 视觉一体。 */
function ChipSelect({
  icon,
  label,
  title,
  value,
  options,
  testId,
  ariaLabel,
  onChange
}: {
  icon: React.ReactNode
  label: string
  title?: string
  value: string
  options: Array<{ value: string; label: string; hint?: string }>
  testId?: string
  ariaLabel: string
  onChange: (value: string) => void
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  useEffect(() => {
    if (!open) return
    const onDoc = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={rootRef} className="composer-chip-select relative">
      <button
        type="button"
        data-testid={testId}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        title={title}
        onClick={() => setOpen((v) => !v)}
        className={`chip composer-chip-select__trigger cursor-pointer gap-1 ${open ? 'composer-chip-select__trigger--open' : ''}`}
      >
        {icon}
        <span className="min-w-0 max-w-[18ch] truncate">{label}</span>
        <ChevronDown
          size={11}
          className={`shrink-0 opacity-55 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="composer-chip-select__menu"
          aria-label={ariaLabel}
        >
          {options.map((option) => {
            const selected = option.value === value
            return (
              <li key={option.value} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`composer-chip-select__option ${selected ? 'composer-chip-select__option--active' : ''}`}
                  onClick={() => {
                    onChange(option.value)
                    setOpen(false)
                  }}
                >
                  <span className="min-w-0 flex-1 truncate text-left">
                    <span className="block truncate">{option.label}</span>
                    {option.hint ? (
                      <span className="mt-0.5 block truncate text-[10.5px] text-[var(--color-muted)]">
                        {option.hint}
                      </span>
                    ) : null}
                  </span>
                  {selected ? <Check size={12} className="shrink-0 text-[var(--color-accent)]" /> : null}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function ProgressRing({
  busy,
  progress
}: {
  busy: boolean
  /** 0–1；undefined 时用不确定脉冲 */
  progress?: number
}): React.ReactElement | null {
  if (!busy) return null
  const size = 32
  const stroke = 2.5
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const indeterminate = progress === undefined || !Number.isFinite(progress)
  const clamped = indeterminate ? 0.25 : Math.min(1, Math.max(0, progress))
  const offset = c * (1 - clamped)

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={`composer-card__ring shrink-0 ${indeterminate ? 'composer-card__ring--pulse' : ''}`}
      aria-hidden
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--color-border)"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={indeterminate ? c * 0.72 : offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  )
}

export function ComposerCard({
  busy,
  blocked,
  history,
  inject,
  blocker,
  runStartedAt,
  clockNow,
  toolProgress,
  onInjected,
  onSend,
  onAbort
}: {
  busy: boolean
  blocked: boolean
  history: string[]
  inject?: { text: string; token: number } | null
  blocker?: { text: string; actionLabel: string; onAction: () => void } | null
  /** 与 ChatView 同步的 run 起点，用于进度环 */
  runStartedAt: number | null
  clockNow: number
  /** 0–1 工具步进度；undefined 则环为脉冲 */
  toolProgress?: number
  onInjected: () => void
  onSend: (text: string) => void
  onAbort: () => void
}): React.ReactElement {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const providers = useAppStore((s) => s.providers)

  const modelOptions = providers
    .filter((provider) => provider.enabled)
    .flatMap((provider) =>
      (provider.models ?? []).map((model) => ({
        providerId: provider.id,
        modelId: model.id,
        value: `${provider.id}::${model.id}`,
        label: `${provider.label || provider.id} / ${model.id}`
      }))
    )
  const modelSelectValue =
    settings?.defaultProviderId && settings?.defaultModelId
      ? `${settings.defaultProviderId}::${settings.defaultModelId}`
      : ''
  const modelLabel =
    modelOptions.find((option) => option.value === modelSelectValue)?.label ?? '选择模型'

  useEffect(() => {
    if (!inject) return
    setText(inject.text)
    setHistoryIndex(null)
    const node = textareaRef.current
    node?.focus()
    node?.setSelectionRange(inject.text.length, inject.text.length)
    onInjected()
  }, [inject, onInjected])

  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const draftRef = useRef('')

  const restorableText = useAppStore((s) => s.restorableText)
  const consumeRestorableText = useAppStore((s) => s.consumeRestorableText)

  useEffect(() => {
    if (!restorableText) return
    setText((previous) => (previous.length === 0 ? restorableText : previous))
    consumeRestorableText()
  }, [restorableText, consumeRestorableText])

  const browse = (direction: 'older' | 'newer'): void => {
    if (history.length === 0) return

    if (direction === 'older') {
      if (historyIndex === null) {
        draftRef.current = text
        setHistoryIndex(history.length - 1)
        setText(history[history.length - 1])
        return
      }
      const next = Math.max(0, historyIndex - 1)
      setHistoryIndex(next)
      setText(history[next])
      return
    }

    if (historyIndex === null) return
    if (historyIndex >= history.length - 1) {
      setHistoryIndex(null)
      setText(draftRef.current)
      return
    }
    const next = historyIndex + 1
    setHistoryIndex(next)
    setText(history[next])
  }

  const submit = (): void => {
    const value = text.trim()
    if (!value || busy) return
    setText('')
    setHistoryIndex(null)
    draftRef.current = ''
    onSend(value)
  }

  return (
    <div className="composer-card shrink-0 px-4 pb-4 pt-2">
      <div className="composer-card__inner mx-auto max-w-3xl">
        {blocker && (
          <div data-testid="composer-blocker" className="composer-card__blocker">
            <span className="min-w-0 flex-1">{blocker.text}</span>
            <button type="button" onClick={blocker.onAction} className="composer-card__blocker-link">
              {blocker.actionLabel}
            </button>
          </div>
        )}

        <div className="composer-card__box" data-blocked={blocked ? 'true' : undefined}>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(event) => {
              setText(event.target.value)
              setHistoryIndex(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                submit()
                return
              }
              if (event.shiftKey || text.includes('\n')) return
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                browse('older')
              } else if (event.key === 'ArrowDown') {
                event.preventDefault()
                browse('newer')
              }
            }}
            rows={2}
            placeholder={blocked ? '有操作等待你的确认…' : '描述任务，或粘贴报错…'}
            className="composer-card__textarea"
          />

          <div className="composer-card__foot">
            {modelOptions.length > 0 ? (
              <ChipSelect
                icon={<Cpu size={11} />}
                label={modelLabel}
                title="切换默认模型（下一轮请求生效）"
                value={modelSelectValue}
                testId="composer-model"
                ariaLabel="默认模型"
                options={modelOptions.map((option) => ({
                  value: option.value,
                  label: option.label
                }))}
                onChange={(next) => {
                  const [providerId, modelId] = next.split('::')
                  if (!providerId || !modelId) return
                  void updateSettings({ defaultProviderId: providerId, defaultModelId: modelId })
                }}
              />
            ) : (
              <span className="chip" title="请先在设置里配置可用模型">
                <Cpu size={11} />
                <span className="max-w-[16ch] truncate">未选择模型</span>
              </span>
            )}
            <span
              className={`chip ${settings?.permissionMode === 'auto' ? 'chip-warn' : 'chip-accent'}`}
              title={settings ? PERMISSION_HINT[settings.permissionMode] : undefined}
            >
              <ShieldCheck size={11} />
              {settings ? PERMISSION_LABEL[settings.permissionMode] : '权限模式'}
            </span>
            {settings && (
              <ChipSelect
                icon={<Brain size={11} />}
                label={`思考 ${thinkingLabel(settings.thinkingLevel)}`}
                title={`思考强度：${thinkingLabel(settings.thinkingLevel)} · ${thinkingHint(settings.thinkingLevel)}`}
                value={normalizeThinkingLevel(settings.thinkingLevel) ?? 'medium'}
                testId="thinking-level"
                ariaLabel="思考强度"
                options={COMMON_THINKING_LEVELS.map((level) => ({
                  value: level,
                  label: thinkingLabel(level),
                  hint: thinkingHint(level)
                }))}
                onChange={(next) =>
                  void updateSettings({ thinkingLevel: normalizeThinkingLevel(next) })
                }
              />
            )}
            {blocked && (
              <span className="chip chip-warn">
                <Hourglass size={11} />
                等待你的确认
              </span>
            )}

            <div className="composer-card__actions ml-auto flex items-center gap-1.5">
              {busy && (
                <span
                  className="hidden text-2xs text-[var(--color-muted)] sm:inline"
                  title="本次运行已用时长"
                >
                  {runStartedAt !== null && clockNow - runStartedAt >= 10_000
                    ? formatElapsed(clockNow - runStartedAt)
                    : null}
                </span>
              )}
              <ProgressRing busy={busy} progress={toolProgress} />
              {busy ? (
                <button type="button" onClick={onAbort} className="btn h-8 px-3" title="中止">
                  <Square size={13} />
                  中止
                </button>
              ) : (
                <button
                  type="button"
                  onClick={submit}
                  disabled={!text.trim()}
                  className="btn btn-primary h-8 w-8 rounded-full px-0"
                  title="发送"
                  aria-label="发送"
                >
                  <ArrowUp size={15} />
                </button>
              )}
            </div>
          </div>
        </div>

      </div>
    </div>
  )
}
