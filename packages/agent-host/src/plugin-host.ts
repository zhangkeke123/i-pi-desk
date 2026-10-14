import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface, type Interface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type { PluginManifest, PluginPermission } from '@i-pi-desk/shared'

/**
 * 插件宿主：把插件跑在**独立子进程**里，并把它们贡献的工具代理给 agent。
 *
 * ## 为什么必须是独立进程
 *
 * 插件是任意代码。放进主进程或 sidecar 里跑，它就能：
 *  - 崩掉整个 agent 会话（一次 `process.exit()` 或内存泄漏）；
 *  - 直接摸到我们内存里的 provider 密钥；
 *  - 阻塞事件循环，让所有会话卡住。
 *
 * 独立进程解决前两条与第三条的一部分。**但它不是沙箱** —— 子进程仍拥有与应用同级的
 * 操作系统权限。我们不假装有沙箱，见 shared/plugin.ts 里关于 `permissions` 的说明。
 *
 * ## 唯一真实的运行时保护：最小环境变量
 *
 * 子进程**不继承** `process.env`，只拿到一份白名单。这是这里能拿到的**唯一**
 * 实质性保护：用户 shell 里的令牌、代理凭据、CI 密钥都不会顺手流进插件。
 *
 * ## 一个必须记住的坑
 *
 * sidecar 自己就是「electron 以 Node 模式」在跑，所以 `process.execPath` 是 electron.exe。
 * 用它在子进程里跑一个 Node 脚本，**子进程也必须带 `ELECTRON_RUN_AS_NODE=1`**，
 * 否则它会试图开一个 Electron 窗口而不是执行脚本。
 */

const here = fileURLToPath(new URL('.', import.meta.url))
/** 运行器与编译产物同目录（build 与 bundle 都会把它拷过去）。 */
const RUNNER_PATH = `${here}plugin-runner.mjs`

/** 工具调用超时。插件里一个死循环不该把 agent 永久挂住。 */
const DEFAULT_TOOL_TIMEOUT_MS = 60_000
/** 激活超时。 */
const ACTIVATE_TIMEOUT_MS = 15_000

export interface PluginToolResult {
  content: string
  isError: boolean
}

export interface PluginRuntimeInfo {
  id: string
  state: 'inactive' | 'activating' | 'active' | 'failed'
  tools: string[]
  lastError?: string
  /** 子进程是否还活着。`state` 与它**可以不一致**，所以要分开看。 */
  running: boolean
  /** 子进程 pid（只在活着时有）。 */
  pid?: number
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface PluginRecord {
  manifest: PluginManifest
  dir: string
  child: ChildProcessWithoutNullStreams | null
  reader: Interface | null
  pending: Map<string, PendingCall>
  seq: number
  state: PluginRuntimeInfo['state']
  tools: string[]
  lastError?: string
}

export interface PluginHostOptions {
  log?: (line: string) => void
  toolTimeoutMs?: number
}

export class PluginHost {
  readonly #records = new Map<string, PluginRecord>()
  readonly #log: (line: string) => void
  readonly #toolTimeoutMs: number

  constructor(options: PluginHostOptions = {}) {
    this.#log = options.log ?? ((): void => {})
    this.#toolTimeoutMs = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
  }

  /** 登记一个插件（不启动）。 */
  register(manifest: PluginManifest, dir: string): void {
    if (this.#records.has(manifest.id)) return
    this.#records.set(manifest.id, {
      manifest,
      dir,
      child: null,
      reader: null,
      pending: new Map(),
      seq: 0,
      state: 'inactive',
      tools: []
    })
  }

  list(): PluginRuntimeInfo[] {
    return [...this.#records.values()].map((record) => {
      const info: PluginRuntimeInfo = {
        id: record.manifest.id,
        state: record.state,
        tools: [...record.tools],
        /**
         * 子进程是否还活着。
         *
         * 单独暴露这一个字段，是因为「状态」和「进程」**可以不一致**：
         * 状态被标成 `failed` 时进程未必已经收掉（早期版本就是如此），
         * 而只断言状态的测试永远发现不了那种泄漏 —— 用户那边表现为
         * 每次开关插件都留下一个 Node 进程，还删不掉插件目录。
         * 有这个名字之后，`verify-plugin-failure.mjs` 才能直接钉住「失败即收尸」。
         */
        running: record.child !== null && record.child.exitCode === null
      }
      if (record.lastError) info.lastError = record.lastError
      if (record.child?.pid !== undefined) info.pid = record.child.pid
      return info
    })
  }

  /** 该插件声明贡献的所有工具名（不看进程是否已启动）。 */
  contributedTools(): Array<{ pluginId: string; toolName: string; description: string; parameters: unknown }> {
    const out: Array<{ pluginId: string; toolName: string; description: string; parameters: unknown }> = []
    for (const record of this.#records.values()) {
      for (const tool of record.manifest.contributes?.agentTools ?? []) {
        out.push({
          pluginId: record.manifest.id,
          toolName: tool.name,
          description: tool.description,
          parameters: tool.parameters ?? { type: 'object', properties: {} }
        })
      }
    }
    return out
  }

  async activate(pluginId: string): Promise<{ tools: string[] }> {
    const record = this.#require(pluginId)
    if (record.state === 'active') return { tools: record.tools }

    if (!existsSync(RUNNER_PATH)) {
      throw new Error(`插件运行器不存在：${RUNNER_PATH}（构建时未拷贝？）`)
    }

    record.state = 'activating'
    const child = spawn(process.execPath, [RUNNER_PATH], {
      cwd: record.dir,
      env: minimalPluginEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    }) as ChildProcessWithoutNullStreams

    record.child = child
    record.reader = createInterface({ input: child.stdout })
    record.reader.on('line', (line) => this.#handleLine(record, line))

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text) this.#log(`[plugin:${pluginId}] ${text}`)
    })

    child.on('exit', (code, signal) => {
      record.reader?.close()
      record.reader = null
      record.child = null
      const reason = `插件进程退出 code=${code ?? 'null'} signal=${signal ?? 'null'}`
      this.#failPending(record, reason)
      if (record.state !== 'inactive') {
        /**
         * 已经因为别的原因标过 `failed` 时，**不要**用「进程退出」覆盖掉更有信息量的原因。
         *
         * 场景：激活时抛错 → 我们主动把子进程收掉（见下面的 catch）→ 退出事件随后到达。
         * 若这里无条件覆盖，UI 上看到的就从「夹具：激活时故意炸了」变成
         * 「插件进程退出 code=null signal=SIGTERM」—— 病因被替换成了收尸记录。
         */
        if (record.state !== 'failed' || !record.lastError) record.lastError = reason
        record.state = 'failed'
        this.#log(`[plugin:${pluginId}] ${reason}`)
      }
    })

    try {
      const result = (await this.#request(
        record,
        'activate',
        {
          pluginId,
          pluginDir: record.dir,
          main: record.manifest.main,
          permissions: record.manifest.permissions ?? []
        },
        ACTIVATE_TIMEOUT_MS
      )) as { tools?: string[] }

      record.tools = Array.isArray(result?.tools) ? result.tools : []
      record.state = 'active'
      record.lastError = undefined
      this.#log(`[plugin:${pluginId}] 已激活，工具：${record.tools.join(', ') || '（无）'}`)
      return { tools: record.tools }
    } catch (error) {
      record.state = 'failed'
      record.lastError = error instanceof Error ? error.message : String(error)
      /**
       * **失败之后必须把子进程收掉。**
       *
       * 这不是洁癖：激活可能是**超时**失败的（插件卡住、永远不回应），
       * 而子进程的 cwd 是插件目录 —— 于是它会一直活着、
       * 用户既看不到它，也删不掉那个插件目录（Windows 上目录被进程占着，`rmdir` 直接 EPERM）。
       * 这条是被 `verify-plugin-failure.mjs` 抓出来的：自测收尾删临时目录时 EPERM，
       * 才暴露出「失败路径漏杀进程」。
       */
      this.#stopChild(record)
      this.#log(`[plugin:${pluginId}] 激活失败：${record.lastError}`)
      throw error
    }
  }

  /**
   * 收掉子进程并结算挂起的请求。
   *
   * 与 `deactivateAll` 里的内联逻辑同源，区别是不碰 `state` ——
   * 调用方（失败路径 / 停用）自己决定状态怎么写。
   */
  #stopChild(record: PluginRecord): void {
    record.reader?.close()
    record.reader = null
    const child = record.child
    record.child = null
    this.#failPending(record, '插件已停止')
    if (child && child.exitCode === null && !child.killed) child.kill()
  }

  /** 激活所有已登记的插件；单个失败不影响其余。 */
  async activateAll(): Promise<Map<string, string>> {
    const failures = new Map<string, string>()
    for (const pluginId of this.#records.keys()) {
      try {
        await this.activate(pluginId)
      } catch (error) {
        failures.set(pluginId, error instanceof Error ? error.message : String(error))
      }
    }
    return failures
  }

  /**
   * 调用插件工具。
   *
   * 失败一律转成 `isError: true` 的结果而不是抛异常 —— 因为它的调用者是模型：
   * 把「工具失败了」作为工具结果回给模型，它才有机会换个做法；
   * 抛异常则会中断整轮，让一次可恢复的失败变成一次失败的会话。
   */
  async callTool(pluginId: string, toolName: string, args: unknown, cwd: string): Promise<PluginToolResult> {
    const record = this.#records.get(pluginId)
    if (!record) return { content: `插件不存在：${pluginId}`, isError: true }

    if (record.state !== 'active') {
      try {
        await this.activate(pluginId)
      } catch (error) {
        return { content: `插件未就绪：${error instanceof Error ? error.message : String(error)}`, isError: true }
      }
    }

    try {
      const result = (await this.#request(
        record,
        'tool.call',
        { tool: toolName, args, cwd },
        this.#toolTimeoutMs
      )) as { content?: string; isError?: boolean }

      return {
        content: typeof result?.content === 'string' ? result.content : '',
        isError: result?.isError === true
      }
    } catch (error) {
      return { content: error instanceof Error ? error.message : String(error), isError: true }
    }
  }

  async deactivateAll(): Promise<void> {
    for (const record of this.#records.values()) {
      if (!record.child) {
        record.state = 'inactive'
        continue
      }
      try {
        await this.#request(record, 'deactivate', undefined, 3000)
      } catch {
        // 插件不理会就不等了，下面直接杀。
      }
      record.state = 'inactive'
      this.#stopChild(record)
    }
  }

  #require(pluginId: string): PluginRecord {
    const record = this.#records.get(pluginId)
    if (!record) throw new Error(`未登记的插件：${pluginId}`)
    return record
  }

  /**
   * 发一个请求并等应答。
   *
   * 超时后**不移除** pending 项以外的任何东西：插件可能只是慢，稍后的应答会被忽略
   * （按 id 找不到 pending 就丢弃），不会串到别的调用上。
   */
  #request(record: PluginRecord, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const child = record.child
    if (!child) return Promise.reject(new Error('插件进程未运行'))

    const id = String(++record.seq)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        record.pending.delete(id)
        reject(new Error(`插件调用超时（${method}，${timeoutMs}ms）`))
      }, timeoutMs)
      timer.unref?.()

      record.pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return
        clearTimeout(timer)
        record.pending.delete(id)
        reject(error)
      })
    })
  }

  #handleLine(record: PluginRecord, line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return

    let frame: { id?: string; result?: unknown; error?: { message?: string }; method?: string; params?: { message?: string } }
    try {
      frame = JSON.parse(trimmed)
    } catch {
      this.#log(`[plugin:${record.manifest.id}] 丢弃无法解析的帧：${trimmed.slice(0, 200)}`)
      return
    }

    if (frame.method === 'log') {
      this.#log(`[plugin:${record.manifest.id}] ${frame.params?.message ?? ''}`)
      return
    }

    if (!frame.id) return
    const pending = record.pending.get(frame.id)
    if (!pending) return
    clearTimeout(pending.timer)
    record.pending.delete(frame.id)

    if (frame.error) pending.reject(new Error(frame.error.message ?? '插件返回错误'))
    else pending.resolve(frame.result)
  }

  #failPending(record: PluginRecord, reason: string): void {
    for (const [id, pending] of record.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
      record.pending.delete(id)
    }
  }
}

/**
 * 插件子进程的环境变量白名单。
 *
 * **不继承 `process.env`** 是这里唯一实质性的运行时保护：用户 shell 里的
 * API 令牌、代理凭据、CI 密钥不会顺手流进插件（细节见文件头）。
 *
 * `ELECTRON_RUN_AS_NODE=1` 是必需的：sidecar 自己跑在 electron 下，
 * `process.execPath` 是 electron.exe，不带这个变量子进程会去开窗口而不是执行脚本。
 */
function minimalPluginEnv(): Record<string, string> {
  const whitelist = [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'SystemDrive',
    'windir',
    'COMSPEC',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'LANG',
    'LC_ALL',
    'NODE_OPTIONS'
  ]
  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1' }
  for (const name of whitelist) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  // 插件不该继承调试端口之类的设置。
  delete env.NODE_OPTIONS
  return env
}

/** 供 UI 与日志用：把权限声明转成人类可读的一行。 */
export function describePermissions(permissions: PluginPermission[] | undefined): string {
  if (!permissions || permissions.length === 0) return '（未声明任何权限）'
  return permissions.join(', ')
}
