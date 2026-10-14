import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { describePtyLoadFailure } from './pty-failure.js'
import type { IPty } from 'node-pty'
import type {
  TerminalCreateOptions,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalSession
} from '@i-pi-desk/shared'

/**
 * 交互式终端（PTY）宿主。
 *
 * ⚠️ **边界声明**：这是**用户自己的 shell**，不是 agent 的工具。agent 的 shell 能力
 * 仍然是 `bash`/`powershell` 工具，逐条走审批闸门。把交互式 shell 交给 agent 等于
 * 给它一条绕过审批的通道 —— 一旦进去，里面的每条命令都不再经过 `tool_call` 钩子。
 * 将来若要开放，必须做**会话级审批**，而不是逐命令审批。
 *
 * ## 四个必须做对的点
 *
 * 1. **原生模块懒加载**。`node-pty` 是编译型原生模块（需要 MSVC + Spectre 缓解库）。
 *    如果用顶层 import，一个装不上的模块会让**整个应用起不来**。所以这里在第一次
 *    真正用到时才 require，失败就变成一条可读的错误提示。
 * 2. **输出必须合并**。PTY 的输出是字节流：`cat` 一个大文件会瞬间产生几 MB 数据，
 *    逐块 `webContents.send` 会把 IPC 和渲染层一起打爆。这里按 16ms / 64KB 合并。
 * 3. **必须继承完整环境变量**。这是用户自己的登录 shell，不是插件子进程 ——
 *    `~`、代理、密钥链、别名全都依赖完整 env。刻意不套用「给子进程的白名单环境」。
 * 4. **不能留僵尸 shell**。三处清理缺一不可：窗口销毁、应用退出、面板卸载。
 *    Windows 上残留的 conhost/cmd 进程用户是看不见的，只会在任务管理器里越积越多。
 */

const requireNative = createRequire(import.meta.url)

type PtyModule = typeof import('node-pty')

let ptyModule: PtyModule | null = null
let ptyLoadError: string | null = null

/** 懒加载 node-pty；失败原因会被缓存，避免每次创建都重试一遍昂贵的 require。 */
function loadPty(): PtyModule {
  if (ptyModule) return ptyModule
  if (ptyLoadError) {
    throw Object.assign(new Error(ptyLoadError), { code: 'PTY_UNAVAILABLE' })
  }
  try {
    ptyModule = requireNative('node-pty') as PtyModule
    return ptyModule
  } catch (error) {
    /**
     * 归因交给 `describePtyLoadFailure`：加载失败有好几种原因，
     * **修复方式互不相同**，而最常见的那种（ABI 不匹配）最容易被原来的文案误导
     * （让人去折腾编译工具链，其实只要重编一次）。
     */
    ptyLoadError = describePtyLoadFailure(error instanceof Error ? error.message : String(error)).message
    throw Object.assign(new Error(ptyLoadError), { code: 'PTY_UNAVAILABLE' })
  }
}

/** 合并窗口：同一窗口内的输出攒成一批再发。 */
const FLUSH_INTERVAL_MS = 16
/** 攒到这个大小就立刻发，不再等定时器（避免大输出被 16ms 的节奏卡成细流）。 */
const FLUSH_THRESHOLD_BYTES = 64 * 1024

interface TerminalRecord {
  session: TerminalSession
  pty: IPty
  /** 创建这个会话的 webContents id —— 窗口关掉时据此清理。 */
  ownerId: number
  pending: string
  flushTimer: NodeJS.Timeout | null
  disposed: boolean
}

export interface TerminalHostOptions {
  onData: (payload: TerminalDataEvent) => void
  onExit: (payload: TerminalExitEvent) => void
  log?: (line: string) => void
}

/** 解析要启动的 shell。Windows 优先 COMSPEC，类 Unix 优先 $SHELL。 */
function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'cmd.exe'
  }
  return process.env.SHELL || '/bin/bash'
}

/** 校验工作目录；不存在就退回用户主目录，而不是让 spawn 抛一个难懂的错。 */
function resolveCwd(requested: string | undefined, log: (line: string) => void): string {
  if (!requested) return homedir()
  try {
    if (statSync(requested).isDirectory()) return requested
  } catch {
    // 落到下面的兜底
  }
  log(`[terminal] 工作目录不可用，退回用户主目录: ${requested}`)
  return homedir()
}

export class TerminalHost {
  readonly #records = new Map<string, TerminalRecord>()
  readonly #onData: (payload: TerminalDataEvent) => void
  readonly #onExit: (payload: TerminalExitEvent) => void
  readonly #log: (line: string) => void

  constructor(options: TerminalHostOptions) {
    this.#onData = options.onData
    this.#onExit = options.onExit
    this.#log = options.log ?? ((): void => {})
  }

  /** 终端是否可用（原生模块能否加载）。UI 据此决定是禁用入口还是显示错误。 */
  probe(): { available: boolean; message?: string } {
    try {
      loadPty()
      return { available: true }
    } catch (error) {
      return { available: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  create(options: TerminalCreateOptions, ownerId: number): TerminalSession {
    const pty = loadPty()
    const cols = clampDimension(options.cols, 80)
    const rows = clampDimension(options.rows, 24)
    const cwd = resolveCwd(options.cwd, this.#log)
    const shell = options.shell && existsSync(options.shell) ? options.shell : defaultShell()

    const spawned = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      // 完整继承（见文件头第 3 条）。这一行是有意为之，不是疏忽。
      env: process.env as Record<string, string>
    })

    const session: TerminalSession = {
      id: randomUUID(),
      shell,
      cwd,
      cols,
      rows,
      createdAt: new Date().toISOString()
    }

    const record: TerminalRecord = {
      session,
      pty: spawned,
      ownerId,
      pending: '',
      flushTimer: null,
      disposed: false
    }
    this.#records.set(session.id, record)

    spawned.onData((data) => this.#buffer(record, data))
    spawned.onExit(({ exitCode, signal }) => {
      this.#flush(record)
      this.#records.delete(session.id)
      this.#log(`[terminal] 会话退出 id=${session.id} code=${exitCode}`)
      this.#onExit({ id: session.id, exitCode, signal })
    })

    this.#log(`[terminal] 会话已创建 id=${session.id} shell=${shell} cwd=${cwd} ${cols}x${rows}`)
    return session
  }

  write(id: string, data: string): void {
    const record = this.#require(id)
    if (typeof data !== 'string') return
    record.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const record = this.#require(id)
    const nextCols = clampDimension(cols, record.session.cols)
    const nextRows = clampDimension(rows, record.session.rows)
    if (nextCols === record.session.cols && nextRows === record.session.rows) return
    try {
      record.pty.resize(nextCols, nextRows)
      record.session.cols = nextCols
      record.session.rows = nextRows
    } catch (error) {
      // 会话可能刚好退出。resize 失败不该打断 UI（用户拖动窗口时这很常见）。
      this.#log(`[terminal] resize 失败 id=${id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  dispose(id: string): void {
    const record = this.#records.get(id)
    if (!record) return
    this.#records.delete(id)
    this.#teardown(record)
  }

  /** 窗口销毁时调用：把这扇窗创建的所有终端都收掉，绝不留僵尸 shell。 */
  disposeByOwner(ownerId: number): number {
    let count = 0
    for (const [id, record] of [...this.#records]) {
      if (record.ownerId !== ownerId) continue
      this.#records.delete(id)
      this.#teardown(record)
      count += 1
    }
    return count
  }

  disposeAll(): number {
    const count = this.#records.size
    for (const [id, record] of [...this.#records]) {
      this.#records.delete(id)
      this.#teardown(record)
    }
    return count
  }

  list(): string[] {
    return [...this.#records.keys()]
  }

  /** 供 ping/诊断使用。 */
  describe(id: string): TerminalSession | undefined {
    return this.#records.get(id)?.session
  }

  #require(id: string): TerminalRecord {
    const record = this.#records.get(id)
    if (!record) {
      throw Object.assign(new Error(`终端会话不存在: ${id}`), { code: 'TERMINAL_NOT_FOUND' })
    }
    return record
  }

  #buffer(record: TerminalRecord, data: string): void {
    record.pending += data
    // 大输出立刻发：等到 16ms 后一起发会让 `cat` 这种场景出现明显的整块停顿。
    if (record.pending.length >= FLUSH_THRESHOLD_BYTES) {
      this.#flush(record)
      return
    }
    if (record.flushTimer) return
    record.flushTimer = setTimeout(() => {
      record.flushTimer = null
      this.#flush(record)
    }, FLUSH_INTERVAL_MS)
    // 定时器不该阻止进程退出。
    record.flushTimer.unref?.()
  }

  #flush(record: TerminalRecord): void {
    if (record.flushTimer) {
      clearTimeout(record.flushTimer)
      record.flushTimer = null
    }
    if (!record.pending) return
    const data = record.pending
    record.pending = ''
    this.#onData({ id: record.session.id, data })
  }

  #teardown(record: TerminalRecord): void {
    if (record.disposed) return
    record.disposed = true
    if (record.flushTimer) {
      clearTimeout(record.flushTimer)
      record.flushTimer = null
    }
    try {
      record.pty.kill()
    } catch (error) {
      // 进程可能已经自己退了。这里吞掉异常是可接受的：退出路径上再抛错只会
      // 掩盖真正的失败原因，而该做的清理（从 map 移除、清定时器）都已完成。
      this.#log(`[terminal] kill 失败 id=${record.session.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** 终端尺寸的合法范围。0 或负数会让 ConPTY 抛错，超大值也没有意义。 */
function clampDimension(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(1000, Math.max(1, Math.floor(value)))
}
