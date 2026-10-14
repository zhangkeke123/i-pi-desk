import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkspaceFacts } from '@i-pi-desk/shared'

/**
 * 工作区的「事实」：为了让空状态的起手任务**基于真实情况**，而不是写死的三条。
 *
 * ## 为什么放在主进程
 *
 * 渲染层不许碰文件系统（这是本项目的硬性分工），所以要读目录只能在这里做，
 * 而且必须**一次问清**：如果让渲染层逐个文件去问，打开一个目录会变成几百次 IPC。
 *
 * ## 为什么必须有界
 *
 * 打开目录是用户随时会做的动作，不能让它在 `node_modules` 或一个巨大的 monorepo 上卡住。
 * 因此这里有四道闸：深度、文件数、读取文件数、单文件字节。超出的部分**不假装知道** ——
 * 返回的计数是「扫到的」，界面上也会照着这个措辞说（见 lib/starters.ts 的 why 字段）。
 */

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  'vendor',
  '.idea',
  '.vscode'
])

const SOURCE_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.svelte',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.rb',
  '.php',
  '.cs',
  '.swift',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.lua',
  '.sh'
])

const MAX_DEPTH = 5
const MAX_FILES = 600
const MAX_READS = 60
const MAX_FILE_BYTES = 128 * 1024

function isTestFile(name: string): boolean {
  return /\.(test|spec)\.[^.]+$/.test(name) || /\.[^.]+\.(test|spec)$/.test(name) || /^(test|tests|__tests__)$/.test(name)
}

/** 从锁文件推断包管理器 —— 起手任务里要说「跑一遍 pnpm test」而不是笼统的「跑测试」。 */
async function detectPackageManager(root: string): Promise<WorkspaceFacts['packageManager']> {
  const candidates: [string, WorkspaceFacts['packageManager']][] = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm']
  ]
  for (const [file, manager] of candidates) {
    try {
      await stat(join(root, file))
      return manager
    } catch {
      // 没有这个锁文件，继续看下一个。
    }
  }
  return undefined
}

export async function inspectWorkspace(root: string): Promise<WorkspaceFacts> {
  const facts: WorkspaceFacts = {
    root,
    sourceFiles: 0,
    testFiles: 0,
    todoCount: 0,
    scannedFiles: 0,
    scripts: [],
    topLevelDirs: [],
    hasReadme: false,
    hasGit: false,
    truncated: false,
    todoPartial: false
  }

  try {
    facts.packageManager = await detectPackageManager(root)

    const entries = await readdir(root, { withFileTypes: true })
    facts.topLevelDirs = entries
      .filter((entry) => entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .slice(0, 12)
    facts.hasGit = entries.some((entry) => entry.isDirectory() && entry.name === '.git')
    facts.hasReadme = entries.some((entry) => /^readme(\.md|\.markdown|\.txt)?$/i.test(entry.name))

    if (entries.some((entry) => entry.name === 'package.json')) {
      const raw = await readFile(join(root, 'package.json'), 'utf8')
      const parsed = JSON.parse(raw) as { scripts?: Record<string, string> }
      facts.scripts = Object.keys(parsed.scripts ?? {}).slice(0, 12)
    }

    for (const candidate of ['src', 'app', 'lib', 'packages']) {
      if (entries.some((entry) => entry.isDirectory() && entry.name === candidate)) {
        facts.srcDir = candidate
        break
      }
    }

    /**
     * 广度优先、逐层展开，遇到任何一道闸就停下并打上 `truncated`。
     * 计数与 TODO 都在这一趟里完成 —— 不为统计多走一遍目录树。
     */
    const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
    const sourcePaths: string[] = []

    while (queue.length > 0) {
      const current = queue.shift()
      if (!current) break
      if (facts.scannedFiles >= MAX_FILES) {
        facts.truncated = true
        break
      }

      let children
      try {
        children = await readdir(current.dir, { withFileTypes: true })
      } catch {
        continue
      }

      for (const child of children) {
        const full = join(current.dir, child.name)
        if (child.isDirectory()) {
          if (SKIP_DIRS.has(child.name) || child.name.startsWith('.')) continue
          if (current.depth + 1 <= MAX_DEPTH) queue.push({ dir: full, depth: current.depth + 1 })
          continue
        }
        if (!child.isFile()) continue

        const ext = child.name.slice(child.name.lastIndexOf('.'))
        const isSource = SOURCE_EXT.has(ext)
        const isTest = isTestFile(child.name)
        if (isTest) facts.testFiles += 1
        if (isSource) {
          facts.sourceFiles += 1
          sourcePaths.push(full)
        }
        facts.scannedFiles += 1
      }
    }

    // 读取有上限只影响 TODO 统计，**不影响源文件计数** —— 两者分开标记。
    if (sourcePaths.length > MAX_READS) facts.todoPartial = true
    for (const file of sourcePaths.slice(0, MAX_READS)) {
      try {
        const info = await stat(file)
        if (info.size > MAX_FILE_BYTES) continue
        const text = await readFile(file, 'utf8')
        facts.todoCount += (text.match(/\b(TODO|FIXME)\b/g) ?? []).length
      } catch {
        // 单个文件读不了不影响整体结论。
      }
    }
  } catch {
    /**
     * 目录不存在、没权限、package.json 是坏的 JSON —— 都可能发生。
     * 这时**返回已知的部分**而不是抛错：空状态会退回通用起手任务，
     * 比让整个界面报一个 fs 错误好得多。
     */
    facts.truncated = true
  }

  return facts
}
