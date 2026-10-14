import { spawn } from 'node:child_process'
import { relative, sep } from 'node:path'
import type { GitDiffResult, GitStatusEntry, GitStatusResult } from '@i-pi-desk/shared'
import { resolveInWorkspace } from './workspace-fs.js'

const GIT_TIMEOUT_MS = 15_000
const MAX_DIFF_BYTES = 200 * 1024

export interface RunGitResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number | null
  error?: string
}

/** 调用 git；超时或 spawn 失败时 `ok: false` 且 `error` 有说明。 */
export function runGit(cwd: string, args: string[]): Promise<RunGitResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false

    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      env: process.env
    })

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolve({
        ok: false,
        stdout,
        stderr,
        code: null,
        error: `git 命令超时（${GIT_TIMEOUT_MS / 1000}s）`
      })
    }, GIT_TIMEOUT_MS)

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const message =
        err.code === 'ENOENT' ? '未找到 git 可执行文件，请安装 Git 并加入 PATH' : err.message
      resolve({ ok: false, stdout, stderr, code: null, error: message })
    })

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        ok: code === 0,
        stdout,
        stderr,
        code,
        error: code === 0 ? undefined : (stderr.trim() || stdout.trim() || `git 退出码 ${code}`)
      })
    })
  })
}

function parsePorcelain(stdout: string): { branch?: string; entries: GitStatusEntry[] } {
  const entries: GitStatusEntry[] = []
  let branch: string | undefined

  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line) continue

    if (line.startsWith('## ')) {
      const rest = line.slice(3).trim()
      const head = rest.split('...')[0]?.trim() ?? ''
      if (head && head !== 'HEAD' && !head.startsWith('(')) {
        branch = head
      }
      continue
    }

    if (line.length < 4) continue

    const indexStatus = line[0] ?? ' '
    const workTreeStatus = line[1] ?? ' '
    let path = line.slice(3).trim()
    const arrow = path.indexOf(' -> ')
    if (arrow !== -1) {
      path = path.slice(arrow + 4).trim()
    }
    path = path.split(sep).join('/')

    entries.push({ path, indexStatus, workTreeStatus })
  }

  return { branch, entries }
}

function repoRelativePathField(repoRelativePath: string): string {
  return (repoRelativePath ?? '').replace(/\\/g, '/').trim()
}

export async function gitStatusInWorkspace(
  workspaceRoot: string,
  repoRelativePath: string
): Promise<GitStatusResult> {
  const repoField = repoRelativePathField(repoRelativePath)
  let repoAbs: string
  try {
    repoAbs = resolveInWorkspace(workspaceRoot, repoField || '.')
  } catch (err) {
    return {
      repoRelativePath: repoField,
      entries: [],
      error: err instanceof Error ? err.message : String(err)
    }
  }

  const run = await runGit(repoAbs, ['status', '--porcelain=v1', '-b'])
  if (!run.ok) {
    return {
      repoRelativePath: repoField,
      entries: [],
      error: run.error ?? (run.stderr.trim() || 'git status 失败')
    }
  }

  const parsed = parsePorcelain(run.stdout)
  return {
    repoRelativePath: repoField,
    branch: parsed.branch,
    entries: parsed.entries
  }
}

export async function gitDiffInWorkspace(
  workspaceRoot: string,
  repoRelativePath: string,
  filePath: string,
  staged = false
): Promise<GitDiffResult> {
  let useStaged = staged
  const repoField = repoRelativePathField(repoRelativePath)
  /**
   * `git status --porcelain` 给出的是**相对仓库根**的路径。
   * UI 原样回传，所以这里必须先拼到工作区相对路径，再做越界校验；
   * 传给 `git diff` 的仍是仓库内相对路径。
   */
  const fileInRepo = (filePath ?? '').replace(/\\/g, '/').replace(/^\.?\//, '').trim()
  if (!fileInRepo || fileInRepo.includes('..')) {
    return {
      repoRelativePath: repoField,
      filePath: fileInRepo,
      staged,
      diff: '',
      error: '非法文件路径'
    }
  }

  const fileInWorkspace = repoField ? `${repoField}/${fileInRepo}` : fileInRepo

  let repoAbs: string
  let fileAbs: string
  try {
    repoAbs = resolveInWorkspace(workspaceRoot, repoField || '.')
    fileAbs = resolveInWorkspace(workspaceRoot, fileInWorkspace)
  } catch (err) {
    return {
      repoRelativePath: repoField,
      filePath: fileInRepo,
      staged,
      diff: '',
      error: err instanceof Error ? err.message : String(err)
    }
  }

  const relInRepo = relative(repoAbs, fileAbs).split(sep).join('/')
  if (relInRepo.startsWith('..') || relInRepo.includes(':')) {
    return {
      repoRelativePath: repoField,
      filePath: fileInRepo,
      staged,
      diff: '',
      error: '文件不在该 Git 仓库内'
    }
  }

  const args = useStaged ? ['diff', '--cached', '--', relInRepo] : ['diff', '--', relInRepo]
  const run = await runGit(repoAbs, args)
  if (!run.ok) {
    return {
      repoRelativePath: repoField,
      filePath: fileInRepo,
      staged: useStaged,
      diff: '',
      error: run.error ?? (run.stderr.trim() || 'git diff 失败')
    }
  }

  let diff = run.stdout
  /**
   * 工作区 clean、变更只在 index 时，普通 `git diff` 为空。
   * 此时回退看 `--cached`，并把结果标成 staged，避免右栏一片空白。
   */
  if (!useStaged && !diff.trim()) {
    const cached = await runGit(repoAbs, ['diff', '--cached', '--', relInRepo])
    if (cached.ok && cached.stdout.trim()) {
      diff = cached.stdout
      useStaged = true
    }
  }

  const bytes = Buffer.byteLength(diff, 'utf8')
  if (bytes > MAX_DIFF_BYTES) {
    diff = diff.slice(0, MAX_DIFF_BYTES) + '\n\n…（diff 已截断）\n'
  }

  return {
    repoRelativePath: repoField,
    filePath: fileInRepo,
    staged: useStaged,
    diff
  }
}
