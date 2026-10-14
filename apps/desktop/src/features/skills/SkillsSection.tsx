import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  FolderOpen,
  Loader2,
  Plus,
  RefreshCw,
  Trash2
} from 'lucide-react'
import type { InstalledSkill, SessionInspectResult, SkillView } from '@i-pi-desk/shared'
import { useAppStore } from '../../stores/app-store.js'
import { call, getDesk, IpcError } from '../../lib/desk.js'

const TEMPLATE = `---
name: my-skill
description: 一句话说清这个技能做什么、以及什么时候该用它（这句决定模型会不会选中它）。
---

# 我的技能

在这里写具体规范。可以直接引用同目录下的文件，例如：

- 先读 \`references/checklist.md\`
- 提交前跑 \`scripts/check.sh\`
`

/**
 * 设置页「技能」分区：安装 / 删除 / 打开目录；是否生效看当前会话 inspect。
 */
export function SkillsSection(): React.ReactElement {
  const currentSessionId = useAppStore((s) => s.currentSessionId)

  const [installed, setInstalled] = useState<InstalledSkill[] | null>(null)
  const [inspect, setInspect] = useState<SessionInspectResult | null>(null)
  const [inspectError, setInspectError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<{ name: string; content: string } | null>(null)
  const [showPrompt, setShowPrompt] = useState(false)
  const [query, setQuery] = useState('')

  const refresh = useCallback(async () => {
    setError(null)
    setInspectError(null)
    try {
      setInstalled(await call(getDesk().skills.list()))
      if (!currentSessionId) {
        setInspect(null)
        return
      }
      try {
        setInspect(await call(getDesk().agent.inspect(currentSessionId)))
      } catch (err) {
        setInspect(null)
        setInspectError(err instanceof IpcError ? err.message : String(err))
      }
    } catch (err) {
      setError(err instanceof IpcError ? err.message : String(err))
    }
  }, [currentSessionId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const loaded = useMemo(() => {
    const map = new Map<string, SkillView>()
    for (const skill of inspect?.skills ?? []) map.set(skill.name, skill)
    return map
  }, [inspect])

  const filtered = useMemo(() => {
    if (!installed) return null
    const q = query.trim().toLowerCase()
    if (!q) return installed
    return installed.filter(
      (skill) =>
        skill.name.toLowerCase().includes(q) ||
        (skill.description ?? '').toLowerCase().includes(q)
    )
  }, [installed, query])

  const save = async (): Promise<void> => {
    if (!draft) return
    setBusy(true)
    setError(null)
    try {
      await call(getDesk().skills.install(draft))
      setDraft(null)
      await refresh()
    } catch (err) {
      setError(err instanceof IpcError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (name: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await call(getDesk().skills.remove(name))
      await refresh()
    } catch (err) {
      setError(err instanceof IpcError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section id="settings-skills" className="space-y-4" data-testid="skills-section">
      <p className="text-xs leading-relaxed text-[var(--color-muted)]">
        技能是可复用的团队规范与操作手册。系统提示里只放名字和描述，全文由 agent
        按需读取。下列对照「磁盘上有什么」与「当前会话内核是否已加载」。
      </p>

      {error && <Banner tone="danger" text={error} />}
      {inspectError && (
        <Banner
          tone="warn"
          text={`无法读取内核的技能加载结果：${inspectError}（磁盘列表仍然可信）`}
        />
      )}

      {draft ? (
        <SkillEditor
          draft={draft}
          busy={busy}
          onChange={setDraft}
          onSave={() => void save()}
          onCancel={() => setDraft(null)}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索技能…"
              aria-label="搜索技能"
              className="h-8 min-w-[12rem] flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-xs outline-none focus:border-[var(--color-accent)]"
            />
            <button
              type="button"
              onClick={() => void refresh()}
              className="grid h-8 w-8 place-items-center rounded-md border border-[var(--color-border)] text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]"
              title="刷新"
            >
              <RefreshCw size={14} />
            </button>
            <button
              type="button"
              onClick={() => void call(getDesk().skills.openDir())}
              className="flex h-8 items-center gap-1 rounded-md border border-[var(--color-border)] px-2.5 text-xs hover:bg-[var(--color-surface-2)]"
            >
              <FolderOpen size={13} />
              打开目录
            </button>
            <button
              type="button"
              onClick={() => setDraft({ name: '', content: TEMPLATE })}
              className="flex h-8 items-center gap-1 rounded-md bg-[var(--color-action)] px-2.5 text-xs font-medium text-[var(--color-action-ink)] hover:bg-[var(--color-action-hover)]"
            >
              <Plus size={13} />
              新增
            </button>
          </div>

          {inspect && (
            <p className="text-[11px] text-[var(--color-muted)]">
              内核已加载 {inspect.skills.length} 个 · 当前模型 {inspect.model}
              {!currentSessionId ? ' · 打开会话后可核对是否生效' : ''}
            </p>
          )}

          {filtered === null ? (
            <Spinner text="读取技能目录…" />
          ) : filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted)]">
              {installed?.length === 0 ? '还没有技能。点「新增」写第一条团队规范。' : '没有匹配的技能。'}
            </p>
          ) : (
            <ul className="space-y-2">
              {filtered.map((skill) => (
                <SkillRow
                  key={skill.name}
                  skill={skill}
                  loaded={loaded.get(skill.name)}
                  canJudge={Boolean(inspect)}
                  busy={busy}
                  onRemove={() => void remove(skill.name)}
                />
              ))}
            </ul>
          )}

          {(inspect?.diagnostics.length ?? 0) > 0 && (
            <section>
              <h3 className="mb-2 text-xs uppercase tracking-wide text-[var(--color-muted)]">
                内核诊断（{inspect?.diagnostics.length}）
              </h3>
              <ul className="space-y-1">
                {inspect?.diagnostics.map((diagnostic, index) => (
                  <li
                    key={index}
                    className="rounded border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/8 px-2 py-1.5 text-[11px]"
                  >
                    <span className="font-mono uppercase opacity-70">{diagnostic.type}</span>{' '}
                    {diagnostic.message}
                    {diagnostic.path && (
                      <span className="block truncate font-mono opacity-60">{diagnostic.path}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {inspect && (
            <section className="border-t border-[var(--color-border)] pt-3">
              <button
                type="button"
                onClick={() => setShowPrompt((value) => !value)}
                className="flex items-center gap-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]"
              >
                <ChevronRight
                  size={13}
                  className={showPrompt ? 'rotate-90 transition-transform' : 'transition-transform'}
                />
                查看 agent 实际收到的系统提示（{inspect.systemPrompt.length} 字）
              </button>
              {showPrompt && (
                <>
                  <p className="mt-2 text-[11px] text-[var(--color-muted)]">
                    生效工具：{inspect.activeTools.join(', ')}
                  </p>
                  <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded border border-[var(--color-border)] bg-[var(--color-canvas)] p-2 font-mono text-[11px]">
                    {inspect.systemPrompt}
                  </pre>
                </>
              )}
            </section>
          )}
        </>
      )}
    </section>
  )
}

function SkillRow({
  skill,
  loaded,
  canJudge,
  busy,
  onRemove
}: {
  skill: InstalledSkill
  loaded: SkillView | undefined
  canJudge: boolean
  busy: boolean
  onRemove: () => void
}): React.ReactElement {
  const notLoaded = canJudge && !loaded
  const nameMismatch = skill.declaredName !== undefined && skill.declaredName !== skill.name

  return (
    <li className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm">{skill.name}</span>
        <span className="rounded px-1.5 py-0.5 text-[10px] text-[var(--color-muted)] bg-[var(--color-surface-2)]">
          全局
        </span>

        {!skill.frontmatterOk && (
          <span className="flex items-center gap-1 text-[10px] text-[var(--color-danger)]">
            <AlertTriangle size={11} />
            frontmatter 无法解析
          </span>
        )}
        {skill.frontmatterOk && !skill.description && (
          <span className="flex items-center gap-1 text-[10px] text-[var(--color-warn)]">
            <AlertTriangle size={11} />
            缺 description，内核不会加载
          </span>
        )}
        {notLoaded && skill.frontmatterOk && skill.description && (
          <span className="flex items-center gap-1 text-[10px] text-[var(--color-warn)]">
            <AlertTriangle size={11} />
            未生效
          </span>
        )}
        {loaded && (
          <span className="flex items-center gap-1 text-[10px] text-[var(--color-ok)]">
            <CheckCircle2 size={11} />
            已生效
          </span>
        )}

        <button
          type="button"
          onClick={onRemove}
          disabled={busy}
          className="ml-auto grid h-6 w-6 place-items-center rounded text-[var(--color-muted)] hover:text-[var(--color-danger)] disabled:opacity-40"
          title="删除技能"
        >
          <Trash2 size={13} />
        </button>
      </div>

      {skill.description && (
        <p className="mt-1 text-xs text-[var(--color-muted)]">{skill.description}</p>
      )}
      {nameMismatch && (
        <p className="mt-1 text-[10px] text-[var(--color-warn)]">
          frontmatter 里声明的名字是「{skill.declaredName}」，与目录名不一致。
        </p>
      )}
      <p className="mt-1 truncate font-mono text-[10px] text-[var(--color-muted)]">{skill.filePath}</p>
    </li>
  )
}

function SkillEditor({
  draft,
  busy,
  onChange,
  onSave,
  onCancel
}: {
  draft: { name: string; content: string }
  busy: boolean
  onChange: (draft: { name: string; content: string }) => void
  onSave: () => void
  onCancel: () => void
}): React.ReactElement {
  return (
    <div className="space-y-3">
      <label className="block">
        <span className="text-xs text-[var(--color-muted)]">技能名</span>
        <input
          value={draft.name}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          placeholder="team-conventions"
          className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-canvas)] px-2.5 py-1.5 font-mono text-sm outline-none focus:border-[var(--color-accent)]"
        />
      </label>
      <label className="block">
        <span className="text-xs text-[var(--color-muted)]">SKILL.md 内容</span>
        <textarea
          value={draft.content}
          onChange={(event) => onChange({ ...draft, content: event.target.value })}
          rows={16}
          spellCheck={false}
          className="mt-1 w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-canvas)] px-2.5 py-1.5 font-mono text-[12px] leading-relaxed outline-none focus:border-[var(--color-accent)]"
        />
      </label>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onSave}
          disabled={busy || !draft.name.trim()}
          className="flex items-center gap-1.5 rounded-md bg-[var(--color-action)] px-3 py-1.5 text-xs font-medium text-[var(--color-action-ink)] hover:bg-[var(--color-action-hover)] disabled:opacity-40"
        >
          {busy && <Loader2 size={12} className="animate-spin" />}
          保存
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="ml-auto rounded-md px-3 py-1.5 text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]"
        >
          取消
        </button>
      </div>
    </div>
  )
}

function Banner({ tone, text }: { tone: 'warn' | 'danger'; text: string }): React.ReactElement {
  const color = tone === 'danger' ? 'var(--color-danger)' : 'var(--color-warn)'
  return (
    <div
      className="flex items-start gap-2 rounded-lg border px-3 py-2 text-xs"
      style={{
        borderColor: `color-mix(in srgb, ${color} 40%, transparent)`,
        background: `color-mix(in srgb, ${color} 8%, transparent)`
      }}
    >
      <AlertTriangle size={13} className="mt-0.5 shrink-0" style={{ color }} />
      <span className="min-w-0 flex-1">{text}</span>
    </div>
  )
}

function Spinner({ text }: { text: string }): React.ReactElement {
  return (
    <p className="flex items-center justify-center gap-2 py-6 text-xs text-[var(--color-muted)]">
      <Loader2 size={12} className="animate-spin" />
      {text}
    </p>
  )
}
