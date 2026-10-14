import { useCallback, useEffect, useMemo, useState } from 'react'
import { FolderOpen, Loader2, Plus, Server, Trash2 } from 'lucide-react'
import type { McpServerConfigView, McpServerSaveInput, McpTransportKind } from '@i-pi-desk/shared'
import { useAppStore } from '../../stores/app-store.js'
import { call, getDesk, IpcError } from '../../lib/desk.js'

/**
 * MCP 管理：全局 / 项目级服务器；落盘后同步到 pi agentDir/mcp.json。
 */
export function McpSection(): React.ReactElement {
  const currentWorkspace = useAppStore((s) => s.currentWorkspace)
  const [scope, setScope] = useState<'all' | 'global' | 'project'>('all')
  const [servers, setServers] = useState<McpServerConfigView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<McpServerSaveInput | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      const list = await call(getDesk().mcp.list(currentWorkspace?.id))
      setServers(list)
      await call(getDesk().mcp.syncRuntime(currentWorkspace?.id))
    } catch (err) {
      setError(err instanceof IpcError ? err.message : String(err))
    }
  }, [currentWorkspace?.id])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const filtered = useMemo(() => {
    if (!servers) return null
    if (scope === 'global') return servers.filter((s) => s.scope === 'global')
    if (scope === 'project') return servers.filter((s) => s.scope === 'project')
    return servers
  }, [servers, scope])

  const globalCount = servers?.filter((s) => s.scope === 'global').length ?? 0
  const projectCount = servers?.filter((s) => s.scope === 'project').length ?? 0

  const saveDraft = async (): Promise<void> => {
    if (!draft) return
    setBusy(true)
    setError(null)
    try {
      await call(getDesk().mcp.save(draft))
      setDraft(null)
      await refresh()
    } catch (err) {
      setError(err instanceof IpcError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section id="settings-mcp" className="space-y-4" data-testid="mcp-section">
      <p className="text-xs leading-relaxed text-[var(--color-muted)]">
        管理 MCP 服务器。配置会写入运行时，并在<strong className="text-[var(--color-ink)]">新建会话</strong>
        时连接；默认以 <code className="font-mono text-2xs">direct</code> 暴露给模型。项目级需先打开工作区。
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-0.5 text-xs">
          {(
            [
              ['all', `全部 ${servers?.length ?? 0}`],
              ['global', `全局 ${globalCount}`],
              ['project', `项目 ${projectCount}`]
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setScope(id)}
              className={`rounded-md px-2.5 py-1 ${
                scope === id
                  ? 'bg-[var(--color-surface)] text-[var(--color-ink)] shadow-sm'
                  : 'text-[var(--color-muted)] hover:text-[var(--color-ink)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="ml-auto truncate font-mono text-[11px] text-[var(--color-muted)]">
          {currentWorkspace?.name ?? '未选项目'}
        </span>
        <button
          type="button"
          className="flex h-8 items-center gap-1 rounded-md border border-[var(--color-border)] px-2.5 text-xs text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-2)]"
          onClick={() => void call(getDesk().mcp.openDir())}
          title="打开配置目录"
        >
          <FolderOpen size={13} />
          目录
        </button>
        <button
          type="button"
          className="flex h-8 items-center gap-1 rounded-md bg-[var(--color-action)] px-2.5 text-xs font-medium text-[var(--color-action-ink)] disabled:opacity-50"
          disabled={scope === 'project' && !currentWorkspace}
          onClick={() =>
            setDraft({
              id: '',
              label: '',
              scope: scope === 'project' ? 'project' : 'global',
              workspaceId: scope === 'project' ? currentWorkspace?.id : undefined,
              transport: 'stdio',
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
              exposure: 'direct',
              enabled: true
            })
          }
        >
          <Plus size={13} />
          新增
        </button>
      </div>

      {error && (
        <p className="rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)] px-3 py-2 text-xs text-[var(--color-danger)]">
          {error}
        </p>
      )}

      {draft && (
        <McpDraftForm
          draft={draft}
          busy={busy}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSave={() => void saveDraft()}
        />
      )}

      {filtered === null ? (
        <p className="flex items-center gap-2 py-6 text-xs text-[var(--color-muted)]">
          <Loader2 size={14} className="animate-spin" />
          读取 MCP 配置…
        </p>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 py-10 text-center">
          <Server size={22} className="text-[var(--color-muted)]" />
          <p className="text-sm text-[var(--color-ink)]">还没有 MCP 服务</p>
          <p className="max-w-md text-xs text-[var(--color-muted)]">
            添加 stdio（本地命令）或 http（远程）服务器后，在新会话中即可使用。
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {filtered.map((server) => (
            <li
              key={`${server.scope}:${server.workspaceId ?? ''}:${server.id}`}
              className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
            >
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium text-[var(--color-ink)]">{server.label}</span>
                    <span className="chip h-[18px] px-1.5 font-mono text-2xs">{server.id}</span>
                    <span className="chip h-[18px] px-1.5 text-2xs">
                      {server.scope === 'global' ? '全局' : '项目'}
                    </span>
                    <span className="chip h-[18px] px-1.5 text-2xs">{server.transport}</span>
                    <span className="chip h-[18px] px-1.5 text-2xs">{server.exposure}</span>
                  </div>
                  <p className="mt-1 truncate font-mono text-2xs text-[var(--color-muted)]">
                    {server.transport === 'http'
                      ? server.url
                      : `${server.command ?? ''} ${(server.args ?? []).join(' ')}`.trim()}
                  </p>
                </div>
                <label className="flex shrink-0 items-center gap-1 text-2xs text-[var(--color-muted)]">
                  <input
                    type="checkbox"
                    checked={server.enabled}
                    onChange={(event) => {
                      void (async () => {
                        try {
                          await call(
                            getDesk().mcp.setEnabled({
                              id: server.id,
                              scope: server.scope,
                              workspaceId: server.workspaceId,
                              enabled: event.target.checked
                            })
                          )
                          await refresh()
                        } catch (err) {
                          setError(err instanceof IpcError ? err.message : String(err))
                        }
                      })()
                    }}
                  />
                  启用
                </label>
                <button
                  type="button"
                  className="icon-btn h-7 w-7 text-[var(--color-muted)] hover:text-[var(--color-danger)]"
                  title="删除"
                  onClick={() => {
                    void (async () => {
                      try {
                        await call(
                          getDesk().mcp.remove({
                            id: server.id,
                            scope: server.scope,
                            workspaceId: server.workspaceId
                          })
                        )
                        await refresh()
                      } catch (err) {
                        setError(err instanceof IpcError ? err.message : String(err))
                      }
                    })()
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function McpDraftForm({
  draft,
  busy,
  onChange,
  onCancel,
  onSave
}: {
  draft: McpServerSaveInput
  busy: boolean
  onChange: (draft: McpServerSaveInput) => void
  onCancel: () => void
  onSave: () => void
}): React.ReactElement {
  const setTransport = (transport: McpTransportKind): void => {
    onChange({ ...draft, transport })
  }

  return (
    <div className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/50 p-3">
      <p className="text-xs font-medium text-[var(--color-ink)]">新增 MCP 服务器</p>
      <label className="block text-2xs text-[var(--color-muted)]">
        名称（id）
        <input
          className="field mt-1 h-8 w-full font-mono"
          value={draft.id}
          onChange={(event) => onChange({ ...draft, id: event.target.value })}
          placeholder="filesystem"
        />
      </label>
      <label className="block text-2xs text-[var(--color-muted)]">
        显示名
        <input
          className="field mt-1 h-8 w-full"
          value={draft.label ?? ''}
          onChange={(event) => onChange({ ...draft, label: event.target.value })}
          placeholder="本地文件系统"
        />
      </label>
      <div className="flex gap-2 text-2xs">
        <button
          type="button"
          className={`rounded-md border px-2 py-1 ${draft.transport === 'stdio' ? 'border-[var(--color-accent)]' : 'border-[var(--color-border)]'}`}
          onClick={() => setTransport('stdio')}
        >
          stdio
        </button>
        <button
          type="button"
          className={`rounded-md border px-2 py-1 ${draft.transport === 'http' ? 'border-[var(--color-accent)]' : 'border-[var(--color-border)]'}`}
          onClick={() => setTransport('http')}
        >
          http
        </button>
      </div>
      {draft.transport === 'stdio' ? (
        <>
          <label className="block text-2xs text-[var(--color-muted)]">
            command
            <input
              className="field mt-1 h-8 w-full font-mono"
              value={draft.command ?? ''}
              onChange={(event) => onChange({ ...draft, command: event.target.value })}
              placeholder="npx"
            />
          </label>
          <label className="block text-2xs text-[var(--color-muted)]">
            args（空格分隔）
            <input
              className="field mt-1 h-8 w-full font-mono"
              value={(draft.args ?? []).join(' ')}
              onChange={(event) =>
                onChange({
                  ...draft,
                  args: event.target.value.split(/\s+/).filter(Boolean)
                })
              }
            />
          </label>
        </>
      ) : (
        <label className="block text-2xs text-[var(--color-muted)]">
          url
          <input
            className="field mt-1 h-8 w-full font-mono"
            value={draft.url ?? ''}
            onChange={(event) => onChange({ ...draft, url: event.target.value })}
            placeholder="https://example.com/mcp"
          />
        </label>
      )}
      <div className="flex gap-2 pt-1">
        <button type="button" className="btn btn-primary h-8" disabled={busy} onClick={onSave}>
          {busy && <Loader2 size={12} className="animate-spin" />}
          保存
        </button>
        <button type="button" className="btn h-8" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  )
}
