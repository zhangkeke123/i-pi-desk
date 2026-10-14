import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { createInterface, type Interface } from 'node:readline'
import type { AgentEventNotification, RpcFrame, RpcMethod, RpcNotification, RuntimeStatus } from '@i-pi-desk/shared'
import type { AppError } from '@i-pi-desk/shared'

/**
 * agent sidecar 的进程监督器。
 *
 * 职责边界（刻意收窄）：
 *  - 只做「拉起进程 / 收发协议帧 / 崩溃重启 / 优雅退出」四件事。
 *  - 不懂任何 agent 语义，也不 import pi-*。这样内核换实现时这里零改动。
 *
 * 协议：stdio 上的 NDJSON。stdout 是协议流，**任何日志只能进 stderr**。
 */

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  method: RpcMethod
}

export interface SupervisorOptions {
  /** sidecar 入口 .js 的绝对路径。 */
  entry: string
  /** 传给 sidecar 的额外环境变量。 */
  env?: Record<string, string>
  /** 单次请求超时；agent 运行可能很久，所以只对控制类方法生效。 */
  controlTimeoutMs?: number
  onLog?: (line: string) => void
}

/** 这些方法会等一次完整的 agent run，不能套用控制类超时。 */
const LONG_RUNNING_METHODS: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
  'session.prompt',
  'provider.verify'
])

export class AgentSupervisor extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private reader: Interface | null = null
  private readonly pending = new Map<string, PendingCall>()
  private seq = 0
  private restarts = 0
  private stopping = false
  private restartTimer: NodeJS.Timeout | null = null
  private status: RuntimeStatus = { state: 'stopped', restarts: 0 }

  constructor(private readonly options: SupervisorOptions) {
    super()
  }

  getStatus(): RuntimeStatus {
    return this.status
  }

  start(): void {
    if (this.child) return
    this.stopping = false

    if (!existsSync(this.options.entry)) {
      this.setStatus({ state: 'crashed', restarts: this.restarts, lastError: `sidecar 入口不存在: ${this.options.entry}` })
      return
    }

    this.setStatus({ state: 'starting', restarts: this.restarts })

    // ELECTRON_RUN_AS_NODE=1 让 Electron 自带的 node 以纯 Node 模式跑这个进程，
    // 于是打包后不需要额外分发一个 node 运行时。
    const child = spawn(process.execPath, [this.options.entry], {
      env: { ...process.env, ...this.options.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    }) as ChildProcessWithoutNullStreams

    this.child = child

    this.reader = createInterface({ input: child.stdout })
    this.reader.on('line', (line) => this.handleLine(line))

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trimEnd()
      if (text) this.options.onLog?.(text)
    })

    child.on('error', (error) => {
      this.setStatus({ state: 'crashed', restarts: this.restarts, lastError: error.message })
      this.failAllPending({ code: 'SIDECAR_SPAWN_FAILED', message: error.message })
    })

    child.on('exit', (code, signal) => {
      this.reader?.close()
      this.reader = null
      this.child = null

      const reason = `sidecar 退出 code=${code ?? 'null'} signal=${signal ?? 'null'}`
      this.failAllPending({ code: 'SIDECAR_EXITED', message: reason })

      if (this.stopping) {
        this.setStatus({ state: 'stopped', restarts: this.restarts })
        return
      }

      this.setStatus({ state: 'crashed', restarts: this.restarts, lastError: reason })
      this.scheduleRestart()
    })

    // 握手：确认 sidecar 真的起来了，再对外宣布 ready。
    void this.request('ping')
      .then(() => this.setStatus({ state: 'ready', restarts: this.restarts }))
      .catch((error: unknown) => {
        this.setStatus({ state: 'crashed', restarts: this.restarts, lastError: String(error) })
      })
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const child = this.child
    if (!child) {
      this.setStatus({ state: 'stopped', restarts: this.restarts })
      return
    }
    try {
      await this.request('shutdown', undefined, 3000)
    } catch {
      // sidecar 不理我们就强杀；退出路径上不值得为它较劲。
    }
    child.kill()
  }

  /**
   * 发一个请求并等应答。
   * @param timeoutMs 显式超时；长任务方法默认不设超时（靠 abort/dispose 收尾）。
   */
  request<T = unknown>(method: RpcMethod, params?: unknown, timeoutMs?: number): Promise<T> {
    const child = this.child
    if (!child || child.killed) {
      return Promise.reject(new Error('sidecar 未运行'))
    }

    const id = String(++this.seq)
    const effectiveTimeout = timeoutMs ?? (LONG_RUNNING_METHODS.has(method) ? 0 : (this.options.controlTimeoutMs ?? 15_000))

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`sidecar 请求超时: ${method}`))
      }, effectiveTimeout === 0 ? 2_147_483_647 : effectiveTimeout)
      // 长任务不该被 timer 持有引用导致进程无法退出。
      if (effectiveTimeout === 0) timer.unref()

      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, method })
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return

    let frame: RpcFrame
    try {
      frame = JSON.parse(trimmed) as RpcFrame
    } catch {
      // 协议流里出现非 JSON，通常是 sidecar 误把日志写到了 stdout。
      this.options.onLog?.(`[supervisor] 丢弃无法解析的协议帧: ${trimmed.slice(0, 200)}`)
      return
    }

    if ('method' in frame) {
      const notification = frame as RpcNotification
      if (notification.method === 'runtime.log') {
        this.options.onLog?.(String((notification.params as { line?: string })?.line ?? ''))
        return
      }
      this.emit('event', notification.params as AgentEventNotification)
      return
    }

    const pending = this.pending.get(frame.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(frame.id)

    if ('error' in frame) {
      const error = new Error(frame.error.message) as Error & { code?: string; details?: string }
      error.code = frame.error.code
      error.details = frame.error.details
      pending.reject(error)
      return
    }
    pending.resolve(frame.result)
  }

  private failAllPending(error: AppError): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      const wrapped = new Error(error.message) as Error & { code?: string }
      wrapped.code = error.code
      pending.reject(wrapped)
      this.pending.delete(id)
    }
  }

  private scheduleRestart(): void {
    if (this.restartTimer) return
    this.restarts += 1
    // 退避：1s、2s、4s… 上限 30s。反复崩溃时不要打出重启风暴。
    const delay = Math.min(1000 * 2 ** Math.min(this.restarts - 1, 5), 30_000)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.start()
    }, delay)
  }

  private setStatus(status: RuntimeStatus): void {
    this.status = status
    this.emit('status', status)
  }
}
