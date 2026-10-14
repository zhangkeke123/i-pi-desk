import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import type { FsSearchHit, FsSearchResult } from '@i-pi-desk/shared'

/**
 * 工作区内文件名 / 内容搜索（只读）。
 *
 * 优先 ripgrep：快且能带行号；没有 rg 时退化为遍历文件名 ——
 * 仍比让渲染层自己 walk 安全（路径边界在主进程）。
 */

const DEFAULT_MAX_HITS = 80
const MAX_WALK_FILES = 5000

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'release',
  '.wt',
  'target',
  'build'
])

function toWorkspaceRelative(workspaceRoot: string, absolute: string): string {
  return relative(workspaceRoot, absolute).split(sep).join('/')
}

function rgGlobArgs(): string[] {
  const args: string[] = []
  for (const dir of SKIP_DIRS) {
    args.push('--glob', `!${dir}/**`)
  }
  for (const dir of SKIP_DIRS) {
    args.push('--glob', `!**/${dir}/**`)
  }
  return args
}

let rgAvailable: boolean | undefined

async function checkRg(): Promise<boolean> {
  if (rgAvailable !== undefined) return rgAvailable

  const found = await new Promise<boolean>((resolve) => {
    const child = spawn('rg', ['--version'], { windowsHide: true })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
    setTimeout(() => {
      child.kill()
      resolve(false)
    }, 3000)
  })
  rgAvailable = found
  return found
}

function runRg(
  workspaceRoot: string,
  args: string[]
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const child = spawn('rg', args, { cwd: workspaceRoot, windowsHide: true })
    child.on('error', () => resolve({ ok: false, stdout, stderr }))
    child.stdout.on('data', (c: Buffer | string) => {
      stdout += c.toString()
    })
    child.stderr.on('data', (c: Buffer | string) => {
      stderr += c.toString()
    })
    child.on('close', (code) => resolve({ ok: code === 0 || code === 1, stdout, stderr }))
    setTimeout(() => {
      child.kill()
      resolve({ ok: false, stdout, stderr })
    }, 30_000)
  })
}

async function searchContentRg(
  workspaceRoot: string,
  query: string,
  maxHits: number
): Promise<{ hits: FsSearchHit[]; truncated: boolean }> {
  const args = [
    '--json',
    '--line-number',
    '--fixed-strings',
    '--max-count',
    String(Math.max(maxHits, 1)),
    ...rgGlobArgs(),
    '--',
    query
  ]
  const run = await runRg(workspaceRoot, args)
  if (!run.ok && !run.stdout.trim()) {
    return { hits: [], truncated: false }
  }

  const hits: FsSearchHit[] = []
  let truncated = false

  for (const line of run.stdout.split('\n')) {
    if (!line.trim()) continue
    let parsed: { type?: string; data?: Record<string, unknown> }
    try {
      parsed = JSON.parse(line) as { type?: string; data?: Record<string, unknown> }
    } catch {
      continue
    }
    if (parsed.type !== 'match' || !parsed.data) continue

    const pathObj = parsed.data.path as { text?: string } | undefined
    const linesObj = parsed.data.lines as { text?: string } | undefined
    const lineNumber = parsed.data.line_number as number | undefined
    const absPath = pathObj?.text
    if (!absPath || lineNumber === undefined) continue

    hits.push({
      path: toWorkspaceRelative(workspaceRoot, absPath),
      kind: 'content',
      line: lineNumber,
      preview: (linesObj?.text ?? '').trimEnd().slice(0, 240)
    })
    if (hits.length >= maxHits) {
      truncated = true
      break
    }
  }

  return { hits, truncated }
}

async function searchFilenameRg(
  workspaceRoot: string,
  query: string,
  maxHits: number,
  existing: Set<string>
): Promise<{ hits: FsSearchHit[]; truncated: boolean }> {
  const lower = query.toLowerCase()
  const args = ['--files', ...rgGlobArgs()]
  const run = await runRg(workspaceRoot, args)
  if (!run.ok && !run.stdout.trim()) {
    return { hits: [], truncated: false }
  }

  const hits: FsSearchHit[] = []
  let truncated = false

  for (const line of run.stdout.split('\n')) {
    const abs = line.trim()
    if (!abs) continue
    const rel = toWorkspaceRelative(workspaceRoot, abs)
    const name = basename(abs)
    if (!name.toLowerCase().includes(lower)) continue
    const key = `name:${rel}`
    if (existing.has(key)) continue
    existing.add(key)
    hits.push({ path: rel, kind: 'name', preview: name })
    if (hits.length >= maxHits) {
      truncated = true
      break
    }
  }

  return { hits, truncated }
}

async function searchWalk(
  workspaceRoot: string,
  query: string,
  maxHits: number
): Promise<FsSearchResult> {
  const lower = query.toLowerCase()
  const hits: FsSearchHit[] = []
  let scanned = 0
  let truncated = false

  async function walk(dir: string): Promise<void> {
    if (hits.length >= maxHits || scanned >= MAX_WALK_FILES) {
      truncated = true
      return
    }

    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (hits.length >= maxHits || scanned >= MAX_WALK_FILES) {
        truncated = true
        return
      }

      const name = entry.name
      if (name.startsWith('.')) continue

      const full = join(dir, name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue
        await walk(full)
        continue
      }

      if (!entry.isFile()) continue
      scanned += 1

      if (name.toLowerCase().includes(lower)) {
        hits.push({
          path: toWorkspaceRelative(workspaceRoot, full),
          kind: 'name',
          preview: name
        })
      }
    }
  }

  await walk(workspaceRoot)
  if (scanned >= MAX_WALK_FILES) truncated = true

  return { hits, truncated }
}

export async function searchInWorkspace(
  workspaceRoot: string,
  query: string,
  maxHits = DEFAULT_MAX_HITS
): Promise<FsSearchResult> {
  const q = (query ?? '').trim()
  if (!q) {
    return { hits: [], truncated: false }
  }

  const limit = Math.max(1, Math.min(maxHits, 500))

  if (await checkRg()) {
    const seen = new Set<string>()
    const content = await searchContentRg(workspaceRoot, q, limit)
    for (const h of content.hits) {
      seen.add(`${h.kind}:${h.path}:${h.line ?? ''}`)
    }

    const room = limit - content.hits.length
    let nameHits: FsSearchHit[] = []
    let nameTruncated = false
    if (room > 0) {
      const names = await searchFilenameRg(workspaceRoot, q, room, seen)
      nameHits = names.hits
      nameTruncated = names.truncated
    }

    return {
      hits: [...content.hits, ...nameHits],
      truncated: content.truncated || nameTruncated || content.hits.length + nameHits.length >= limit
    }
  }

  return searchWalk(workspaceRoot, q, limit)
}

/** 供测试：判断目录是否应跳过。 */
export function shouldSkipDirName(name: string): boolean {
  return name.startsWith('.') || SKIP_DIRS.has(name)
}

/** 供测试：walk 扫描上限。 */
export { MAX_WALK_FILES }
