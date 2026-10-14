import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  FolderOpen,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  X
} from 'lucide-react'
import type { InstalledSkill, SessionInspectResult, SkillView } from '@i-pi-desk/shared'
import { useAppStore } from '../../stores/app-store.js'
import { call, getDesk, IpcError } from '../../lib/desk.js'

/**
 * 技能面板。
 *
 * ## 为什么必须同时显示「磁盘上有什么」和「内核加载了什么」
 *
 * pi 的技能机制是**渐进式披露**：系统提示里只放每个技能的名字、描述和路径，
 * 全文等模型自己按需读取。这套机制很省 token，但有个副作用 ——
 * **用户完全看不到自己的规范有没有生效**。
 *
 * 而内核会静默丢弃不少技能：缺 description 的、命名不合规的、frontmatter 损坏的。
 * 如果 UI 只列目录，用户会以为规范生效了，实际模型根本没看到它。
 *
 * 所以这里把两个视角并排显示，并对「在磁盘上但内核没加载」的技能明确标注。
 */

const TEMPLATE = `---
name: my-skill
description: 一句话说清这个技能做什么、以及什么时候该用它（这句决定模型会不会选中它）。
---

# 我的技能

在这里写具体规范。可以直接引用同目录下的文件，例如：

- 先读 \`references/checklist.md\`
- 提交前跑 \`scripts/check.sh\`
`

export function SkillsDialog({ onClose }: { onClose: () => void }): React.ReactElement {
  const currentSessionId = useAppStore((s) => s.currentSessionId)

  const [installed, setInstalled] = useState<InstalledSkill[] | null>(null)
  const [inspect, setInspect] = useState<SessionInspectResult | null>(null)
  const [inspectError, setInspectError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<{ name: string; content: string } | null>(null)
  const [showPrompt, setShowPrompt] = useState(false)

  const refresh = useCallback(async () => {
    setError(null)
    setInspectError(null)
    try {
      setInstalled(await call(getDesk().skills.list()))

      if (!currentSessionId) {
        // 没有会话就没法问内核（会话是技能加载的载体）。
        // 这不是错误，UI 应当说明原因而不是报错。
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !draft) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, draft])

  /** 内核真正加载的技能，按名字索引，用于与磁盘列表比对。 */
  const loaded = useMemo(() => {
    const map = new Map<string, SkillView>()
    for (const skill of inspect?.skills ?? []) map.set(skill.name, skill)
    return map
  }, [inspect])

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
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-[var(--color-overlay)] p-6 backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-4">
          <Sparkles size={16} className="text-[var(--color-muted)]" />
          <h2 className="text-sm font-medium">技能（Skills）</h2>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => void refresh()}
              className="grid h-7 w-7 place-items-center rounded-md text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]"
              title="刷新"
            >
              <RefreshCw size={14} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="grid h-7 w-7 place-items-center rounded-md text-[var(--color-muted)] hover:bg-[var(--color-surface-2)]"
            >
              <X size={15} />
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <p className="mb-4 text-xs leading-relaxed text-[var(--color-muted)]">
            技能是可复用的团队规范与操作手册。系统提示里只放它的名字和描述，全文由 agent
            在需要时自行读取 —— 所以你写的规范越多，也不会越占上下文。
          </p>

          {error && <Banner tone="danger" text={error} />}
          {inspectError && (
            <Banner
              tone="warn"
              text={`无法读取内核的技能加载结果：${inspectError}（磁盘列表仍然可信，但「是否生效」暂时未知）`}
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
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setDraft({ name: '', content: TEMPLATE })}
                  className="flex items-center gap-1 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs hover:bg-[var(--color-surface-2)]"
                >
                  <Plus size={13} />
                  新建技能
                </button>
                <button
                  type="button"
                  onClick={() => void call(getDesk().skills.openDir())}
                  className="flex items-center gap-1 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs hover:bg-[var(--color-surface-2)]"
                >
                  <FolderOpen size={13} />
                  打开技能目录
                </button>
                {inspect && (
                  <span className="ml-auto text-[11px] text-[var(--color-muted)]">
                    内核已加载 {inspect.skills.length} 个 · 当前模型 {inspect.model}
                  </span>
                )}
              </div>

              {installed === null ? (
                <Spinner text="读取技能目录…" />
              ) : installed.length === 0 ? (
                <p className="py-6 text-center text-sm text-[var(--color-muted)]">
                  还没有技能。点「新建技能」写第一条团队规范。
                </p>
              ) : (
                <ul className="space-y-2">
                  {installed.map((skill) => (
                    <SkillRow
                      key={skill.name}
                      skill={skill}
                      loaded={loaded.get(skill.name)}
                      // 没有会话时无法判断是否生效，就不要显示「未生效」误导用户。
                      canJudge={Boolean(inspect)}
                      busy={busy}
                      onRemove={() => void remove(skill.name)}
                    />
                  ))}
                </ul>
              )}

              {(inspect?.diagnostics.length ?? 0) > 0 && (
                <section className="mt-4">
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
                <section className="mt-4 border-t border-[var(--color-border)] pt-3">
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
        </div>
      </div>
    </div>
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
    <li className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm">{skill.name}</span>

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
          其它 Agent Skills 实现可能要求两者一致，建议改成同名。
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
        <span className="text-xs text-[var(--color-muted)]">
          技能名 <span className="opacity-60">（小写字母、数字、连字符；也是 /skill:&lt;name&gt; 的名字）</span>
        </span>
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
          className="flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40"
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
      className="mb-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs"
      style={{ borderColor: `color-mix(in srgb, ${color} 40%, transparent)`, background: `color-mix(in srgb, ${color} 8%, transparent)` }}
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
