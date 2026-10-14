import { access, readdir } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import type { GitRepoInfo } from '@i-pi-desk/shared'

/**
 * 在工作区里发现多个 Git 仓库根（monorepo / 多仓工作区）。
 *
 * 只扫有限深度，并跳过依赖与构建产物目录 —— 否则打开 a3-lib 这类工作区
 * 会在 node_modules 里浪费大量 IO，UI 也等不到结果。
 */

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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function isGitRoot(dir: string): Promise<boolean> {
  return pathExists(join(dir, '.git'))
}

function toRepoRelative(workspaceRoot: string, absoluteRepoRoot: string): string {
  const rel = relative(workspaceRoot, absoluteRepoRoot)
  return rel.split(sep).join('/')
}

/**
 * @param maxDepth 相对工作区根的目录深度上限（根本身为 0）。
 */
export async function discoverGitRepos(workspaceRoot: string, maxDepth = 3): Promise<GitRepoInfo[]> {
  const repos: GitRepoInfo[] = []

  if (await isGitRoot(workspaceRoot)) {
    repos.push({
      relativePath: '',
      name: basename(workspaceRoot) || workspaceRoot
    })
  }

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return

    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue
      if (SKIP_DIRS.has(entry.name)) continue

      const child = join(dir, entry.name)

      if (await isGitRoot(child)) {
        const rel = toRepoRelative(workspaceRoot, child)
        repos.push({
          relativePath: rel,
          name: entry.name
        })
        // 已是独立仓库根，不再往里扫嵌套 .git（需要时可单独 discover）。
        continue
      }

      await walk(child, depth + 1)
    }
  }

  await walk(workspaceRoot, 1)
  return repos
}
