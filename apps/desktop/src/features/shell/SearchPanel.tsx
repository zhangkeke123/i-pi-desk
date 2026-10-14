import { useCallback, useEffect, useState } from 'react'
import { Loader2, Search } from 'lucide-react'
import type { FsSearchHit } from '@i-pi-desk/shared'
import { useAppStore } from '../../stores/app-store.js'
import { call, getDesk, IpcError } from '../../lib/desk.js'

/**
 * 工作区全文 / 文件名搜索（走主进程 `desk.fs.search`）。
 * `projectEmptyHint`：PI「项目文件」空态文案。
 */
export function SearchPanel({ projectEmptyHint = false }: { projectEmptyHint?: boolean }): React.ReactElement {
  const workspace = useAppStore((s) => s.currentWorkspace)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<FsSearchHit[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const runSearch = useCallback(async (): Promise<void> => {
    const q = query.trim()
    if (!workspace || q.length === 0) {
      setHits([])
      setTruncated(false)
      return
    }

    setLoading(true)
    setError(null)
    try {
      const result = await call(getDesk().fs.search({ workspaceId: workspace.id, query: q }))
      setHits(result.hits ?? [])
      setTruncated(result.truncated)
    } catch (err) {
      setError(err instanceof IpcError ? err.message : String(err))
      setHits([])
    } finally {
      setLoading(false)
    }
  }, [query, workspace])

  if (!workspace) {
    return (
      <p className="px-3 py-6 text-center text-xs text-[var(--color-muted)]">请先选择工作目录</p>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-[var(--color-border)] px-2 py-2">
        <div className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1">
          <Search size={12} className="shrink-0 text-[var(--color-muted)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runSearch()
            }}
            placeholder="搜索文件名或内容…"
            className="min-w-0 flex-1 bg-transparent text-xs text-[var(--color-ink)] outline-none placeholder:text-[var(--color-muted)]"
          />
          <button
            type="button"
            onClick={() => void runSearch()}
            disabled={loading || query.trim().length === 0}
            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] disabled:opacity-40"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : '搜索'}
          </button>
        </div>
        {error && <p className="mt-1.5 text-[10px] text-[var(--color-danger)]">{error}</p>}
        {truncated && (
          <p className="mt-1 text-[10px] text-[var(--color-muted)]">结果已截断，请缩小关键词</p>
        )}
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {hits.length === 0 && !loading && query.trim().length === 0 && projectEmptyHint && (
          <li className="grid min-h-[12rem] place-items-center px-4 text-center text-[13px] text-[var(--color-muted)]">
            输入关键词以搜索整个项目。
          </li>
        )}
        {hits.length === 0 && !loading && query.trim().length > 0 && (
          <li className="py-6 text-center text-xs text-[var(--color-muted)]">无匹配</li>
        )}
        {hits.map((hit) => (
          <li
            key={`${hit.kind}:${hit.path}:${hit.line ?? ''}`}
            className="border-b border-[var(--color-border)]/50 py-1.5 last:border-0"
          >
            <p className="truncate font-mono text-xs text-[var(--color-ink)]">{hit.path}</p>
            {hit.line !== undefined && (
              <p className="text-[10px] text-[var(--color-muted)]">
                行 {hit.line}
                {hit.preview ? ` · ${hit.preview}` : ''}
              </p>
            )}
            {hit.kind === 'name' && hit.preview && hit.line === undefined && (
              <p className="text-[10px] text-[var(--color-muted)]">文件名匹配</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
