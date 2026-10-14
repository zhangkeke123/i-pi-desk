import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { GitRepoInfo, GitStatusEntry } from '@i-pi-desk/shared'
import { useAppStore } from '../../stores/app-store.js'
import { useLayoutStore } from '../../stores/layout-store.js'
import { call, getDesk, IpcError } from '../../lib/desk.js'

function formatStatus(entry: GitStatusEntry): string {
  const i = entry.indexStatus === ' ' ? '' : entry.indexStatus
  const w = entry.workTreeStatus === ' ' ? '' : entry.workTreeStatus
  return (i + w).trim() || '?'
}

/**
 * 多 git 仓只读视图：发现子仓 → status → 点文件看 diff。
 */
export function GitPanel(): React.ReactElement {
  const workspace = useAppStore((s) => s.currentWorkspace)
  const selectedGitRepo = useLayoutStore((s) => s.selectedGitRepo)
  const setSelectedGitRepo = useLayoutStore((s) => s.setSelectedGitRepo)

  const [repos, setRepos] = useState<GitRepoInfo[]>([])
  const [files, setFiles] = useState<GitStatusEntry[]>([])
  const [branch, setBranch] = useState<string | undefined>()
  const [diffText, setDiffText] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const git = getDesk().git

  const loadRepos = useCallback(async (): Promise<void> => {
    if (!workspace) {
      setRepos([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      const list = await call(git.discover(workspace.id))
      const normalized = list.length > 0 ? list : [{ relativePath: '', name: '工作区根' }]
      setRepos(normalized)
      if (!normalized.some((r) => r.relativePath === selectedGitRepo)) {
        setSelectedGitRepo(normalized[0]?.relativePath ?? '')
      }
    } catch (err) {
      setError(err instanceof IpcError ? err.message : String(err))
      setRepos([])
    } finally {
      setLoading(false)
    }
  }, [workspace, git, selectedGitRepo, setSelectedGitRepo])

  const loadStatus = useCallback(async (): Promise<void> => {
    if (!workspace) return
    setLoading(true)
    setError(null)
    setDiffText(null)
    setSelectedFile(null)
    try {
      const data = await call(git.status({ workspaceId: workspace.id, repoRelativePath: selectedGitRepo }))
      if (data.error) {
        setError(data.error)
        setFiles([])
        setBranch(undefined)
        return
      }
      setBranch(data.branch)
      setFiles(data.entries ?? [])
    } catch (err) {
      setError(err instanceof IpcError ? err.message : String(err))
      setFiles([])
    } finally {
      setLoading(false)
    }
  }, [workspace, git, selectedGitRepo])

  useEffect(() => {
    void loadRepos()
  }, [loadRepos])

  useEffect(() => {
    if (repos.length > 0) void loadStatus()
  }, [loadStatus, repos.length, selectedGitRepo])

  const openDiff = async (entry: GitStatusEntry): Promise<void> => {
    if (!workspace) return
    setSelectedFile(entry.path)
    setDiffText(null)
    /**
     * porcelain：index 有改、工作区干净 → 看 staged；
     * 否则优先看工作区 diff（与「正在改的文件」直觉一致）。
     */
    const preferStaged = entry.indexStatus !== ' ' && entry.workTreeStatus === ' '
    try {
      const data = await call(
        git.diff({
          workspaceId: workspace.id,
          repoRelativePath: selectedGitRepo,
          filePath: entry.path,
          staged: preferStaged
        })
      )
      if (data.error) {
        setDiffText(data.error)
        return
      }
      const label = data.staged ? '（已暂存）\n' : ''
      setDiffText(label + (data.diff ?? ''))
    } catch (err) {
      setDiffText(err instanceof IpcError ? err.message : String(err))
    }
  }

  if (!workspace) {
    return (
      <p className="px-3 py-6 text-center text-xs text-[var(--color-muted)]">请先选择工作目录</p>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-[var(--color-border)] px-2 py-2">
        <label className="mb-1 block text-[10px] text-[var(--color-muted)]">Git 仓库</label>
        <select
          value={selectedGitRepo}
          onChange={(e) => setSelectedGitRepo(e.target.value)}
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs text-[var(--color-ink)] outline-none"
        >
          {repos.map((repo) => (
            <option key={repo.relativePath || '__root'} value={repo.relativePath}>
              {repo.name || repo.relativePath || '工作区根'}
            </option>
          ))}
        </select>
        {branch && (
          <p className="mt-1 font-mono text-[10px] text-[var(--color-muted)]">
            分支 {branch}
          </p>
        )}
        {error && <p className="mt-1.5 text-[10px] text-[var(--color-danger)]">{error}</p>}
      </div>

      <div className="grid min-h-0 flex-1 grid-rows-[1fr_auto]">
        <div className="min-h-0 overflow-y-auto px-1 py-1">
          {loading && files.length === 0 && (
            <div className="flex items-center justify-center gap-2 py-6 text-xs text-[var(--color-muted)]">
              <Loader2 size={14} className="animate-spin" />
              读取状态…
            </div>
          )}
          {!loading && files.length === 0 && !error && (
            <p className="py-6 text-center text-xs text-[var(--color-muted)]">工作区干净，或暂无变更</p>
          )}
          <ul className="space-y-0.5">
            {files.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  onClick={() => void openDiff(file)}
                  className={`flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-xs hover:bg-[var(--color-surface-2)] ${
                    selectedFile === file.path ? 'bg-[var(--color-accent-soft)] text-[var(--color-ink)]' : 'text-[var(--color-muted)]'
                  }`}
                >
                  <span className="shrink-0 font-mono text-[10px] text-[var(--color-accent)]">{formatStatus(file)}</span>
                  <span className="min-w-0 truncate font-mono">{file.path}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        {diffText !== null && (
          <div className="max-h-40 shrink-0 border-t border-[var(--color-border)] bg-[var(--color-canvas)] p-2">
            <p className="mb-1 truncate font-mono text-[10px] text-[var(--color-muted)]">{selectedFile}</p>
            <pre className="max-h-32 overflow-auto font-mono text-[10px] leading-relaxed text-[var(--color-ink-soft)] whitespace-pre-wrap">
              <code>{diffText || '（空 diff）'}</code>
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}
