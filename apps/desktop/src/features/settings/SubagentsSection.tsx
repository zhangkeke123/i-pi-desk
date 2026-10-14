import { useCallback, useEffect, useState } from 'react'
import { Bot, Loader2, Plus, Trash2 } from 'lucide-react'
import type { SubagentDefinition, SubagentSaveInput, SubagentToolProfile } from '@i-pi-desk/shared'
import { call, getDesk, IpcError } from '../../lib/desk.js'

/**
 * 子智能体管理：内置预设开关 + 自定义创建；启用列表同步到运行时供 run_subagent 使用。
 */
export function SubagentsSection(): React.ReactElement {
  const [items, setItems] = useState<SubagentDefinition[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<SubagentSaveInput | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      setItems(await call(getDesk().subagents.list()))
    } catch (err) {
      setError(err instanceof IpcError ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const builtins = items?.filter((i) => i.builtin) ?? []
  const customs = items?.filter((i) => !i.builtin) ?? []

  const saveDraft = async (): Promise<void> => {
    if (!draft) return
    setBusy(true)
    setError(null)
    try {
      await call(getDesk().subagents.save(draft))
      setDraft(null)
      await refresh()
    } catch (err) {
      setError(err instanceof IpcError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section id="settings-subagents" className="space-y-4" data-testid="subagents-section">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-xl text-xs leading-relaxed text-[var(--color-muted)]">
          子智能体用于专项委派。启用后模型可通过工具{' '}
          <code className="font-mono text-2xs">run_subagent</code> 调用。内置项可开关；自定义可增删。
        </p>
        <button
          type="button"
          className="flex h-8 items-center gap-1 rounded-md bg-[var(--color-action)] px-2.5 text-xs font-medium text-[var(--color-action-ink)]"
          onClick={() =>
            setDraft({
              name: '',
              description: '',
              systemPrompt: '',
              tools: 'readonly',
              enabled: true
            })
          }
        >
          <Plus size={13} />
          新建子智能体
        </button>
      </div>

      {error && (
        <p className="rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)] px-3 py-2 text-xs text-[var(--color-danger)]">
          {error}
        </p>
      )}

      {draft && (
        <div className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/50 p-3">
          <label className="block text-2xs text-[var(--color-muted)]">
            名称
            <input
              className="field mt-1 h-8 w-full"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label className="block text-2xs text-[var(--color-muted)]">
            简介
            <input
              className="field mt-1 h-8 w-full"
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </label>
          <label className="block text-2xs text-[var(--color-muted)]">
            人设 / 系统提示
            <textarea
              className="field mt-1 h-24 w-full resize-y py-1.5"
              value={draft.systemPrompt}
              onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })}
            />
          </label>
          <label className="block text-2xs text-[var(--color-muted)]">
            工具档
            <select
              className="field mt-1 h-8 w-full"
              value={draft.tools ?? 'readonly'}
              onChange={(event) =>
                setDraft({ ...draft, tools: event.target.value as SubagentToolProfile })
              }
            >
              <option value="readonly">只读</option>
              <option value="full">全量</option>
              <option value="none">无工具</option>
            </select>
          </label>
          <div className="flex gap-2">
            <button type="button" className="btn btn-primary h-8" disabled={busy} onClick={() => void saveDraft()}>
              {busy && <Loader2 size={12} className="animate-spin" />}
              保存
            </button>
            <button type="button" className="btn h-8" onClick={() => setDraft(null)}>
              取消
            </button>
          </div>
        </div>
      )}

      {items === null ? (
        <p className="flex items-center gap-2 py-6 text-xs text-[var(--color-muted)]">
          <Loader2 size={14} className="animate-spin" />
          读取子智能体…
        </p>
      ) : (
        <>
          <div className="space-y-2">
            <p className="font-mono text-2xs uppercase tracking-[0.08em] text-[var(--color-muted)]">内置</p>
            <ul className="space-y-2">
              {builtins.map((item) => (
                <SubagentCard
                  key={item.id}
                  item={item}
                  onToggle={async (enabled) => {
                    try {
                      await call(getDesk().subagents.setEnabled({ id: item.id, enabled }))
                      await refresh()
                    } catch (err) {
                      setError(err instanceof IpcError ? err.message : String(err))
                    }
                  }}
                />
              ))}
            </ul>
          </div>

          <div className="space-y-2">
            <p className="font-mono text-2xs uppercase tracking-[0.08em] text-[var(--color-muted)]">自定义</p>
            {customs.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 py-10 text-center">
                <Bot size={22} className="text-[var(--color-muted)]" />
                <p className="text-sm text-[var(--color-ink)]">还没有自定义子智能体</p>
              </div>
            ) : (
              <ul className="space-y-2">
                {customs.map((item) => (
                  <SubagentCard
                    key={item.id}
                    item={item}
                    onToggle={async (enabled) => {
                      try {
                        await call(getDesk().subagents.setEnabled({ id: item.id, enabled }))
                        await refresh()
                      } catch (err) {
                        setError(err instanceof IpcError ? err.message : String(err))
                      }
                    }}
                    onRemove={async () => {
                      try {
                        await call(getDesk().subagents.remove(item.id))
                        await refresh()
                      } catch (err) {
                        setError(err instanceof IpcError ? err.message : String(err))
                      }
                    }}
                  />
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  )
}

function SubagentCard({
  item,
  onToggle,
  onRemove
}: {
  item: SubagentDefinition
  onToggle: (enabled: boolean) => void | Promise<void>
  onRemove?: () => void | Promise<void>
}): React.ReactElement {
  return (
    <li className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium">{item.name}</span>
            <span className="chip h-[18px] px-1.5 font-mono text-2xs">{item.id}</span>
            <span className="chip h-[18px] px-1.5 text-2xs">{item.tools}</span>
            {item.builtin && <span className="chip h-[18px] px-1.5 text-2xs">内置</span>}
          </div>
          <p className="mt-1 text-xs text-[var(--color-muted)]">{item.description}</p>
        </div>
        <label className="flex shrink-0 items-center gap-1 text-2xs text-[var(--color-muted)]">
          <input
            type="checkbox"
            checked={item.enabled}
            onChange={(event) => void onToggle(event.target.checked)}
          />
          启用
        </label>
        {onRemove && (
          <button
            type="button"
            className="icon-btn h-7 w-7 text-[var(--color-muted)] hover:text-[var(--color-danger)]"
            title="删除"
            onClick={() => void onRemove()}
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
    </li>
  )
}
