/**
 * 会话注册表 + pi 集成。
 *
 * 职责边界（这是本文件最重要的设计约束）：
 *  - **主进程是会话持久化的唯一权威**。这里只用 `SessionManager.inMemory()`，
 *    内核永远不写会话文件；进程重启后历史由主进程回灌（`session.load` 只是把
 *    当前内存里的 pi 消息回读出来）。
 *  - pi 是「当前选用的内核实现」，它的事件一律经 `translate.ts` 归一化后再出门，
 *    本文件是除 translate 外唯一允许 import pi 的地方。
 *
 * ## 已核实的 pi 1.1.0 行为（实测，勿凭文档猜）
 *
 *  1. `createAgentSession` **不会**自动调用 `bindExtensions()`，但 `tool_call` 扩展处理器
 *     **仍然会被触发**：`AgentSession` 构造函数里的 `_buildRuntime()` 已经创建了
 *     `ExtensionRunner` 并调用了 `_bindExtensionCore()` / `_applyExtensionBindings()`
 *     （`docs/sdk.md` 只说了 bindExtensions 提供 uiContext/mode 等绑定）。
 *     实测见 `dist/core/agent-session.js:327` 的 `_beforeToolCall` —— 它直接读
 *     `this._extensionRunner` 并 `hasHandlers("tool_call")`。
 *     为了拿到 `session_start` 语义与文档一致的绑定，这里仍然显式调用
 *     `bindExtensions({ mode: "print" })`，但**不依赖它**来保证拦截生效。
 *  2. `agent_end` 之后还可能自动重试/继续，**不能**当「这轮结束」；
 *     `agent_settled`（`AgentSessionEvent` 独有，带 `aborted: boolean`）才是终点信号。
 *     `translate.ts` 已改成 `agent_end → null` / `agent_settled → run.finished`。
 *  3. `thinkingLevel` 的默认值实际是 `medium`（`DEFAULT_THINKING_LEVEL`），
 *     README 里写的 `off` 已过期。这里不显式指定，走 pi 默认。
 *  4. 工具集只能通过 `tools: string[]` 传入；`createCodingTools()` 返回的 `AgentTool[]`
 *     是给 `AgentSessionConfig.baseToolsOverride`（直接 `new AgentSession`）用的，
 *     `createAgentSession` 不吃。`+name`/`-name` 与普通名混用会 throw。
 *  5. **skills 只有在 `read` 和 `bash` 同时出现在工具集里时才会注入系统提示**
 *     （`core/skills.ts` 的注入条件）—— 所以只读模式裁掉 bash 的代价是 skills 文案消失。
 *  6. 扩展 handler 抛错 = 阻断工具执行（fail-safe）。审批超时因此必须**显式**
 *     resolve 成 `deny`，绝不能靠抛错来表达「不批准」。
 *  7. `session.prompt()` 返回 `Promise<void>`，**不返回 stopReason**；stopReason 只能
 *     从事件流（`agent_settled.aborted`）或最后一次 assistant 消息推断。
 *  8. pi 1.1.0 里**没有** maxSteps / maxTurns 之类选项（全量 dist grep 无命中），
 *     协议里的 `PromptParams.maxSteps` 只能由本文件自己兜底计数 + 主动 abort。
 */

import { randomUUID } from 'node:crypto'
import { basename, resolve } from 'node:path'
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager
} from '@earendil-works/pi-coding-agent'
import type { AgentSession, AgentSessionEvent, ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { approvalFingerprint, createApprovalExtension } from './approval.js'
import type { ApprovalDecision, ApprovalRequest } from './approval.js'
import { buildApprovalPreview } from './approval-preview.js'
import { PI_AGENT_DIR_ENV, PI_SESSION_DIR_ENV } from './isolation.js'
import { toPiHistory } from './history.js'
import { PluginHost } from './plugin-host.js'
import { describeError, registerPiProvider, verifyProvider } from './provider.js'
import { toChatMessage, translateEvent } from './translate.js'
import { readFileSync, existsSync } from 'node:fs'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import type {
  AgentEvent,
  ChatMessage,
  PermissionMode,
  PluginManifest,
  PromptParams,
  ProviderVerifyParams,
  ProviderVerifyResult,
  ResolveApprovalParams,
  RunStopReason,
  Session,
  SessionCreateParams,
  SessionInspectResult,
  SessionSnapshot,
  ThinkingLevelValue
} from '@i-pi-desk/shared'
import { APPROVAL_TIMEOUT_MS, validatePluginManifest } from '@i-pi-desk/shared'

/**
 * 工具集（只用名字，见文件头第 4 条）。
 *
 * `bash` 是**必须保留**的，不是偏好问题：pi 的 skills 注入条件是 `read` + `bash`
 * 同时在集合里（文件头第 5 条），换成 `powershell` 会静默丢掉全部 skills 文案。
 * 它也是 pi 自己的 `DEFAULT_TOOL_NAMES` 默认值。
 *
 * Windows 上额外补 `powershell`，而不是二选一：
 * native Windows 的 `bash` 需要 Git for Windows（`docs/windows.md` 的解析顺序是
 * settings.shellPath → Program Files 下的 Git Bash → PATH）。装了 Git 的机器两套都能用；
 * 没装的机器上 `bash` 会失败，但模型能看到失败信息并改用 `powershell` ——
 * 这比「一开始就没有可用 shell」好得多，也比「为了兼容 Windows 而全局砍掉 skills」划算。
 *
 * 非 Windows 不加：那些平台上 `powershell` 一定不存在，加进去只会给模型一个必然失败的工具。
 */
const FULL_TOOLS: readonly string[] = [
  'read',
  'grep',
  'find',
  'ls',
  'write',
  'edit',
  'bash',
  ...(process.platform === 'win32' ? ['powershell'] : [])
]
/** 只读模式暴露给模型的工具（审批闸门仍是硬保证，这里是第二道）。 */
const READONLY_TOOLS: readonly string[] = ['read', 'grep', 'find', 'ls']

/**
 * 审批等待超时；超时按 deny 处理，避免 run 永久挂住。
 *
 * 导出是为了让自测能断言「默认确实是 5 分钟」—— 这条逻辑平时不会被触发，
 * 改了默认值如果没有断言盯着，就只能靠人去读代码才发现。
 * （`verify-approval-timeout.mjs --real` 会用这个真实默认值跑一次完整的 5 分钟。）
 */
/**
 * 等用户裁决的默认超时。
 *
 * 数值来自 `@i-pi-desk/shared` —— 渲染层的倒计时用的是同一个常量，
 * 不再各写一份（见 shared 里的说明）。这里保留这个名字，是因为它已经被
 * 多处 import，改名的收益不抵风险。
 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = APPROVAL_TIMEOUT_MS
/** 主进程没给 maxSteps 时的兜底上限（与 shared 的 DEFAULT_SETTINGS.maxSteps 对齐）。 */
const DEFAULT_MAX_STEPS = 40

/** 带错误码的运行时错误；`protocol.toRpcError()` 会把 code/details 提到协议帧上。 */
export class RuntimeFailure extends Error {
  readonly code: string
  readonly details: string | undefined

  constructor(code: string, message: string, details?: string) {
    super(message)
    this.name = 'RuntimeFailure'
    this.code = code
    this.details = details
  }
}

function fail(code: string, message: string): never {
  throw new RuntimeFailure(code, message)
}

function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_PARAMS', `${what} 必须是对象`)
  }
  return value as Record<string, unknown>
}

function requireString(source: Record<string, unknown>, key: string, what: string): string {
  const value = source[key]
  if (typeof value !== 'string' || value.length === 0) {
    fail('INVALID_PARAMS', `${what} 缺少必填字符串字段 "${key}"`)
  }
  return value
}

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void
  timer: ReturnType<typeof setTimeout>
}

/** sidecar 内存里活着的会话。pi 侧是**懒创建**的：`session.create` 拿不到 agentDir。 */
interface SessionRecord {
  sessionId: string
  workspaceId: string
  cwd: string
  agentDir: string | undefined
  createdAt: string
  updatedAt: string
  title: string
  providerId: string | undefined
  modelId: string | undefined
  apiKey: string | undefined
  messageCount: number
  permissionMode: PermissionMode
  maxSteps: number
  /**
   * 本轮生效的思考强度（缺省表示交给内核默认）。
   *
   * 存在记录上、而不是当作一次性的参数丢掉，是因为它要在 `prepareRequest` 里被读到 ——
   * 那个回调在**每次 provider 请求前**都会跑，而它只能看到会话记录，拿不到本次调用的参数。
   */
  thinkingLevel: ThinkingLevelValue | undefined
  /** pi 会话；在第一次 prompt 时创建（那时才拿得到 agentDir / provider / model）。 */
  pi: AgentSession | undefined
  modelRuntime: ModelRuntime | undefined
  /**
   * 会话的资源加载器。
   *
   * 留着它是因为它是**技能与扩展的唯一权威**：`getSkills()` 给出的就是 agent 真正
   * 看到的那份清单（含解析失败的 diagnostics）。UI 要展示「哪些 skill 真的生效了」，
   * 就不能靠自己去扫目录 —— 那会与内核的判断不一致（比如缺 description 的 skill
   * 内核不加载，自己扫目录却会把它列出来）。
   */
  resourceLoader: DefaultResourceLoader | undefined
  /**
   * 插件贡献的工具名。
   *
   * 单独存在这里是因为「注册」与「激活」是两步：会话创建时用 customTools 注册，
   * 但要让模型真正看到它们，还得把名字并进 `setActiveToolsByName` 的生效集合。
   */
  pluginToolNames: string[]
  unsubscribe: (() => void) | undefined
  providerSignature: string | undefined
  /** 当前 run 是否被 abort 请求标记过（translate 的 ctx.aborted 用）。 */
  aborted: boolean
  /** 当前 run 的 id；没有 run 时为 undefined。 */
  runId: string | undefined
  /** 本 run 是否收到过 agent_settled。 */
  settled: boolean
  /** agent_settled.aborted —— 权威的「这轮为什么结束」。 */
  settledAborted: boolean
  /** 超过 maxSteps 时由我们自己覆盖 stopReason。 */
  stopReasonOverride: RunStopReason | undefined
  /**
   * provider 在本轮里报出的错误文本（不是抛异常，而是随消息回来的那种）。
   * 见 `prompt()` 里关于「为什么不能只看 agent_settled」的说明。
   */
  providerError: string | undefined
  toolCallsThisRun: number
  running: boolean
  /** allow-always 之后的指纹白名单（按会话存）。 */
  alwaysAllowed: Set<string>
  pendingApprovals: Map<string, PendingApproval>
  closing: boolean
}

export interface AgentRuntimeOptions {
  /** 事件出口：把翻译后的 AgentEvent 推给主进程（必须是 stdout 协议流）。 */
  writeEvent: (sessionId: string, event: AgentEvent) => void
  /** 日志出口：必须写 stderr。默认丢弃（库形态不强制输出）。 */
  log?: (line: string) => void
  /** 审批等待超时，默认 5 分钟。 */
  approvalTimeoutMs?: number
  /** 单次 run 的工具调用上限兜底，默认 40。 */
  defaultMaxSteps?: number
  /** verify 的上游超时，默认 20s。 */
  verifyTimeoutMs?: number
}

/**
 * 会话注册表 + pi 集成。
 *
 * 线程/并发模型：单进程单事件循环，一次只服务一个 RPC（Node 的 readline 已经是串行的）。
 * 同一会话上并发 `session.prompt` 会直接报 `SESSION_BUSY`，而不是让 pi 去排队 ——
 * 排队会让「哪个 prompt 对应哪个 runId」变得不可判定。
 */
export class AgentRuntime {
  readonly #records = new Map<string, SessionRecord>()
  readonly #writeEvent: (sessionId: string, event: AgentEvent) => void
  readonly #log: (line: string) => void
  readonly #approvalTimeoutMs: number
  readonly #defaultMaxSteps: number
  readonly #verifyTimeoutMs: number
  /** 进程级唯一的 agentDir：第一次拿到的值生效，之后变化报错（不静默混用）。 */
  #boundAgentDir: string | undefined
  /**
   * 插件宿主。
   *
   * 它是**进程级**的（插件在 sidecar 生命周期内一直活着），而不是按会话创建 ——
   * 每个会话都重启一遍插件进程既慢又会丢插件的内部状态。
   */
  readonly #plugins: PluginHost
  #shutdown = false

  constructor(options: AgentRuntimeOptions) {
    this.#writeEvent = options.writeEvent
    this.#log = options.log ?? ((): void => {})
    this.#approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
    this.#defaultMaxSteps = options.defaultMaxSteps ?? DEFAULT_MAX_STEPS
    this.#verifyTimeoutMs = options.verifyTimeoutMs ?? 20_000
    this.#plugins = new PluginHost({ log: this.#log })
  }

  /** 存活会话数（ping 用）。 */
  get sessionCount(): number {
    return this.#records.size
  }

  /** 已绑定的 agentDir（ping / 诊断用）。 */
  get agentDir(): string | undefined {
    return this.#boundAgentDir
  }

  async ping(): Promise<Record<string, unknown>> {
    return {
      ok: true,
      pid: process.pid,
      node: process.version,
      platform: process.platform,
      sessions: this.#records.size,
      agentDir: this.#boundAgentDir ?? null
    }
  }

  // ───────────────────────────── provider.verify ─────────────────────────────

  async verifyProvider(params: ProviderVerifyParams): Promise<ProviderVerifyResult> {
    const raw = requireObject(params, 'provider.verify 参数')
    if (raw.provider === null || typeof raw.provider !== 'object') {
      fail('INVALID_PARAMS', 'provider.verify 缺少 provider')
    }
    return verifyProvider(params, { timeoutMs: this.#verifyTimeoutMs })
  }

  // ───────────────────────────── 会话生命周期 ─────────────────────────────

  /**
   * 建立会话记录。
   *
   * **这里不创建 pi 会话**：`SessionCreateParams` 没有 `agentDir`，而 pi 需要它来决定
   * 配置/会话/快捷键等一切落盘位置（传错的代价是污染用户 `~/.pi`）。
   * pi 会话在第一次 `session.prompt` 时创建 —— 那时 `PromptParams` 里
   * cwd / agentDir / provider / modelId / apiKey / permissionMode 一应俱全。
   */
  createSession(params: SessionCreateParams): Session {
    const raw = requireObject(params, 'session.create 参数')
    const sessionId = requireString(raw, 'sessionId', 'session.create')
    const workspaceId = requireString(raw, 'workspaceId', 'session.create')
    const cwd = requireString(raw, 'cwd', 'session.create')

    const existing = this.#records.get(sessionId)
    if (existing) {
      if (resolve(existing.cwd) !== resolve(cwd)) {
        fail('SESSION_EXISTS', `会话 ${sessionId} 已存在，且工作目录不同（${existing.cwd} != ${cwd}）`)
      }
      return this.#toSession(existing)
    }

    const now = new Date().toISOString()
    const record: SessionRecord = {
      sessionId,
      workspaceId,
      cwd,
      agentDir: undefined,
      createdAt: now,
      updatedAt: now,
      title: basename(cwd) || workspaceId,
      providerId: typeof raw.provider === 'object' && raw.provider !== null ? String((raw.provider as { id?: unknown }).id ?? '') || undefined : undefined,
      modelId: typeof raw.modelId === 'string' ? raw.modelId : undefined,
      apiKey: undefined,
      messageCount: 0,
      permissionMode: 'ask',
      thinkingLevel: undefined,
      maxSteps: this.#defaultMaxSteps,
      pi: undefined,
      modelRuntime: undefined,
      unsubscribe: undefined,
      providerSignature: undefined,
    resourceLoader: undefined,
    pluginToolNames: [],
      aborted: false,
      runId: undefined,
      settled: false,
      settledAborted: false,
      stopReasonOverride: undefined,
    providerError: undefined,
      toolCallsThisRun: 0,
      running: false,
      alwaysAllowed: new Set<string>(),
      pendingApprovals: new Map<string, PendingApproval>(),
      closing: false
    }
    this.#records.set(sessionId, record)
    this.#log(`[runtime] 会话已登记 ${sessionId} (cwd=${cwd})，pi 会话将在首次 prompt 时创建`)
    return this.#toSession(record)
  }

  /** sidecar 内存里的会话清单。持久化权威在主进程，这里只报「活着」的。 */
  listSessions(): Session[] {
    return [...this.#records.values()].map((record) => this.#toSession(record))
  }

  /** 把 pi 内存里的消息回读成快照。进程重启后历史由主进程从库里回灌。 */
  loadSession(sessionId: string): SessionSnapshot {
    const record = this.#requireRecord(sessionId)
    return { session: this.#toSession(record), messages: this.#snapshotMessages(record) }
  }

  /** 关闭一个会话：清订阅、把待裁决审批立刻判 deny、dispose pi 会话。 */
  async disposeSession(sessionId: string): Promise<{ disposed: boolean }> {
    const record = this.#records.get(sessionId)
    if (!record) return { disposed: false }
    await this.#destroyRecord(record)
    return { disposed: true }
  }

  // ───────────────────────────── 运行 ─────────────────────────────

  /**
   * 解析 `session.prompt` 与 `session.inspect` 共用的那部分参数。
   *
   * 抽出来是为了**防止两条路径的校验漂移**：它们接受同一组「运行上下文」
   * （会话、工作目录、agent 目录、provider、模型、权限），如果各写一份，
   * 迟早会出现「prompt 校验了 agentDir、inspect 忘了」这类不一致 ——
   * 而 agentDir 恰恰是 home 隔离的关键参数。
   */
  #parseRunParams(
    params: unknown,
    method: string
  ): {
    sessionId: string
    cwd: string
    agentDir: string
    modelId: string
    provider: PromptParams['provider']
    permissionMode: PermissionMode
    thinkingLevel: ThinkingLevelValue | undefined
    raw: Record<string, unknown>
  } {
    const raw = requireObject(params, `${method} 参数`)
    const sessionId = requireString(raw, 'sessionId', method)
    const cwd = requireString(raw, 'cwd', method)
    const agentDir = requireString(raw, 'agentDir', method)
    const modelId = requireString(raw, 'modelId', method)

    const provider = raw.provider
    if (provider === null || typeof provider !== 'object') {
      fail('INVALID_PARAMS', `${method} 缺少 provider`)
    }

    const permissionMode = raw.permissionMode
    if (permissionMode !== 'readonly' && permissionMode !== 'ask' && permissionMode !== 'auto') {
      fail('INVALID_PARAMS', `${method} 的 permissionMode 必须是 readonly | ask | auto`)
    }

    /**
     * 思考强度是可选的（不传就按内核默认）。
     *
     * 传了就**必须**是七个已知值之一：这里不「容错地」忽略非法值 ——
     * 静默退化会让用户以为自己调了档位，实际一直是默认的。
     */
    const thinkingLevel = raw.thinkingLevel
    if (
      thinkingLevel !== undefined &&
      thinkingLevel !== 'off' &&
      thinkingLevel !== 'minimal' &&
      thinkingLevel !== 'low' &&
      thinkingLevel !== 'medium' &&
      thinkingLevel !== 'high' &&
      thinkingLevel !== 'xhigh' &&
      thinkingLevel !== 'max'
    ) {
      fail('INVALID_PARAMS', `${method} 的 thinkingLevel 必须是 off | minimal | low | medium | high | xhigh | max`)
    }

    return {
      sessionId,
      cwd,
      agentDir,
      modelId,
      provider: provider as PromptParams['provider'],
      permissionMode,
      thinkingLevel,
      raw
    }
  }

  /**
   * 跑一轮。返回 `{ stopReason }`。
   *
   * 失败语义：模型/网络/配置错误**不**作为 RPC 错误抛出，而是发一条 `run.failed` 事件
   * 并让 RPC 正常返回 `stopReason: 'error'` —— run 的生命周期归事件流所有，
   * 主进程据此把错误显示在对话里。只有协议层问题（参数非法、会话不存在）才走 RPC error。
   */
  async prompt(params: PromptParams): Promise<{ stopReason: RunStopReason }> {
    const { sessionId, cwd, agentDir, modelId, provider, permissionMode, thinkingLevel, raw } =
      this.#parseRunParams(params, 'session.prompt')
    const text = requireString(raw, 'text', 'session.prompt')
    const maxSteps = typeof raw.maxSteps === 'number' && Number.isFinite(raw.maxSteps) ? raw.maxSteps : this.#defaultMaxSteps

    const record = this.#ensureRecord(sessionId, cwd)
    this.#bindAgentDir(agentDir)

    /**
     * 思考强度：内核只在**建会话**时收这个值（`createAgentSession({ thinkingLevel })`，
     * 已由类型检查确认），没有「改现有会话档位」的接口。
     *
     * 所以这里的做法是：档位变了就**丢掉内核会话**，让下一条消息按新档位重建。
     * 这样做是安全的 —— 历史落盘在主进程、重建时按 `seeded` 重放（见 #ensureSession），
     * 丢掉的只是内核里的内存态。语义也因此很清楚：**改档位从下一条消息开始生效**。
     *
     * 运行中不允许这么干：丢掉正在跑的会话会让那一轮悬空。上面那条 SESSION_BUSY
     * 检查会先拦住，这里只是不制造「边跑边换」的模糊状态。
     */
    if (record.pi && record.thinkingLevel !== thinkingLevel) {
      this.#log(
        `[runtime] 思考强度变化（${record.thinkingLevel ?? '默认'} → ${thinkingLevel ?? '默认'}），丢弃内核会话以便下一条消息重建`
      )
      record.pi = undefined
    }
    record.thinkingLevel = thinkingLevel

    if (record.running) {
      fail('SESSION_BUSY', `会话 ${sessionId} 正在运行中，请先 abort 或等待本轮结束`)
    }

    /**
     * 明文密钥：只活在内存里（硬性安全要求）。
     *  - 绝不写进任何文件；
     *  - 绝不放进 `process.env`（pi `models.json` 的 `${ENV}` 占位符路线已废弃，
     *    provider 配置整体走 `ModelRuntime.registerProvider`，见 provider.ts 文件头）；
     *  - 本轮 `apiKey` 缺省时**沿用上一次**：主进程「只在第一次带上 key」是合理用法，
     *    按缺省清空会表现成「第一轮能用、第二轮 401」这种极难查的故障。
     */
    if (typeof raw.apiKey === 'string') record.apiKey = raw.apiKey
    const apiKey = record.apiKey

    const providerConfig = provider as PromptParams['provider']
    record.permissionMode = permissionMode
    record.maxSteps = maxSteps > 0 ? maxSteps : 0
    record.providerId = providerConfig.id
    record.modelId = modelId
    record.updatedAt = new Date().toISOString()

    const pi = await this.#ensurePiSession(
      record,
      cwd,
      agentDir,
      providerConfig,
      modelId,
      apiKey,
      raw.plugins as PromptParams['plugins'],
      // 历史只在新建内核会话时用得上；已有内核会话时 runtime 会自行忽略（见 §history 的说明）。
      raw.history as ChatMessage[] | undefined
    )
    this.#applyToolPolicy(record, pi)

    const runId = randomUUID()
    record.runId = runId
    record.aborted = false
    record.settled = false
    record.settledAborted = false
    record.stopReasonOverride = undefined
    record.toolCallsThisRun = 0
    record.providerError = undefined
    record.running = true

    this.#log(`[runtime] prompt 开始 session=${sessionId} run=${runId} model=${providerConfig.id}/${modelId}`)
    try {
      await pi.prompt(text)
    } catch (error) {
      const failure = new RuntimeFailure('PROMPT_FAILED', describeError(error))
      this.#emit(record, { type: 'run.failed', runId, error: { code: failure.code, message: failure.message } })
      this.#log(`[runtime] prompt 失败 session=${sessionId} run=${runId}: ${failure.message}`)
      return { stopReason: 'error' }
    } finally {
      record.running = false
      // 待裁决审批不允许跨 run 存活：否则下一轮会看到一个已经没人等的 id。
      this.#denyAllPending(record, 'run 已结束，审批请求自动作废')
    }

    /**
     * provider 在流里报的错（例如 401 鉴权失败、连接被拒）**不会抛异常** ——
     * pi 把它变成一条带 `errorMessage` 的 assistant 消息，然后照常结束这一轮。
     *
     * 所以只看 `agent_settled` 会把「模型调用失败」误判成 `end_turn`：
     * 界面上是一条带错误文本的空消息，而审计却记成 `run.completed` ——
     * 用户配错 key 时，用量统计与成功率统计全是假的。这里显式认领这种结束方式。
     *
     * ⚠️ **但用户中止时不算失败**：中止会让在途请求断开，于是 provider 报一个
     * 连接错误 —— 那是中止的**预期副作用**，不是真故障。把它记成 `run.failed`
     * 会让审计里「用户主动停止」看起来像「模型调用失败」。
     */
    if (record.providerError && !record.stopReasonOverride && !record.settledAborted && !record.aborted) {
      const failure = new RuntimeFailure('PROVIDER_ERROR', record.providerError)
      this.#emit(record, { type: 'run.failed', runId, error: { code: failure.code, message: failure.message } })
      this.#log(`[runtime] provider 出错 session=${sessionId} run=${runId}: ${failure.message}`)
      record.updatedAt = new Date().toISOString()
      return { stopReason: 'error' }
    }

    /**
     * stopReason 的优先级：兜底的 max_steps > **中止** > provider 报错 > end_turn。
     *
     * 中止必须排在 provider 报错前面（理由同上）。而且这里的判据必须与
     * `translate.ts` 里 `run.finished` 的判据**一致** —— 两处各算一次是曾经真实发生过的
     * 缺陷：事件流说 `aborted`，而返回值说 `error`，于是界面上「已中止」的提示不出现，
     * 审计里却多了一条失败。
     */
    const aborted = record.settledAborted || record.aborted
    const stopReason: RunStopReason =
      record.stopReasonOverride ?? (aborted ? 'aborted' : record.providerError ? 'error' : 'end_turn')
    if (!record.settled) {
      // 没等到 agent_settled 却正常返回了：pi 的语义里这不该发生，但真发生时要留下证据，
      // 否则「run.finished 少了」会变成一个查不出来的 UI 卡死。
      this.#log(`[runtime] 警告：run=${runId} 在 prompt 返回时仍未收到 agent_settled`)
    }
    record.updatedAt = new Date().toISOString()
    this.#log(`[runtime] prompt 结束 session=${sessionId} run=${runId} stopReason=${stopReason}`)
    return { stopReason }
  }

  /**
   * 检视会话：agent 真正看到的系统提示、生效的工具集、以及**已加载的技能清单**。
   *
   * 两个用途：
   *  1. 产品上：让用户能回答「我放的 skill 到底生效了吗」。
   *     这是渐进式披露机制的必要配套 —— 如果只提示词里放个目录、界面上什么都不显示，
   *     用户就只能靠「模型有没有按规范做事」来猜。
   *  2. 工程上：它能在**不发任何请求**的前提下建立会话，于是技能加载、
   *     系统提示组装这些链路可以离线验证（见 scripts/verify-renderer.mjs）。
   *
   * 技能清单必须取自内核的 `getSkills()` 而不是我们自己扫目录：
   * 内核会丢弃缺 description 的、命名非法的 skill 并给出 diagnostics，
   * 自己扫目录只会列出一堆「看起来在、实际没生效」的东西。
   */
  async inspect(params: PromptParams): Promise<SessionInspectResult> {
    const { sessionId, cwd, agentDir, modelId, provider, permissionMode, raw } = this.#parseRunParams(
      params,
      'session.inspect'
    )

    const record = this.#ensureRecord(sessionId, cwd)
    this.#bindAgentDir(agentDir)
    if (typeof raw.apiKey === 'string') record.apiKey = raw.apiKey
    record.permissionMode = permissionMode

    const session = await this.#ensurePiSession(
      record,
      cwd,
      agentDir,
      provider,
      modelId,
      record.apiKey,
      raw.plugins as PromptParams['plugins'],
      // inspect 也会建会话，所以这里同样要能恢复上下文 —— 否则「检视」出来的
      // 系统提示与真实对话时的不一致（历史会影响上下文文件与技能的使用情况）。
      raw.history as ChatMessage[] | undefined
    )
    this.#applyToolPolicy(record, session)

    const skills = record.resourceLoader?.getSkills()

    return {
      systemPrompt: session.systemPrompt,
      model: `${provider.id}/${modelId}`,
      activeTools: [...session.getActiveToolNames()],
      skills: (skills?.skills ?? []).map((skill) => ({
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
        baseDir: skill.baseDir,
        disableModelInvocation: skill.disableModelInvocation
      })),
      diagnostics: (skills?.diagnostics ?? []).map((diagnostic) => ({
        type: diagnostic.type,
        message: diagnostic.message,
        path: diagnostic.path
      })),
      plugins: this.#plugins.list().map((info) => {
        const view: SessionInspectResult['plugins'][number] = {
          id: info.id,
          state: info.state,
          tools: info.tools
        }
        if (info.lastError) view.lastError = info.lastError
        return view
      })
    }
  }

  /**
   * 中止当前 run。
   *
   * 顺序很关键：**先把待裁决的审批判 deny，再 await pi.abort()**。
   * `_beforeToolCall` 正 await 我们的审批 promise，而 `session.abort()` 会等会话进入 idle ——
   * 反过来的话就会互相等待，直到 5 分钟审批超时才解开。
   */
  async abortSession(sessionId: string): Promise<{ aborted: true; wasRunning: boolean }> {
    const record = this.#requireRecord(sessionId)
    const wasRunning = record.running
    record.aborted = true
    this.#denyAllPending(record, '用户中止了本轮运行')
    if (record.pi) {
      try {
        await record.pi.abort()
      } catch (error) {
        this.#log(`[runtime] abort 失败 session=${sessionId}: ${describeError(error)}`)
      }
    }
    return { aborted: true, wasRunning }
  }

  // ───────────────────────────── 审批 ─────────────────────────────

  /**
   * 主进程的裁决。
   *
   * 找不到对应审批时返回 `{ resolved: false }` 而不是抛错：UI 点「允许」和超时判 deny
   * 之间天然存在竞态，把它变成错误只会制造假故障。
   */
  resolveApproval(params: ResolveApprovalParams): { resolved: boolean } {
    const raw = requireObject(params, 'approval.resolve 参数')
    const sessionId = requireString(raw, 'sessionId', 'approval.resolve')
    const approvalId = requireString(raw, 'approvalId', 'approval.resolve')
    const decision = raw.decision
    if (decision !== 'allow-once' && decision !== 'allow-always' && decision !== 'deny') {
      fail('INVALID_PARAMS', 'approval.resolve 的 decision 必须是 allow-once | allow-always | deny')
    }

    const record = this.#records.get(sessionId)
    if (!record) return { resolved: false }
    return { resolved: this.#settleApproval(record, approvalId, decision) }
  }

  // ───────────────────────────── 关停 ─────────────────────────────

  /**
   * 清理所有会话。**不**在这里 `process.exit()`：库形态不该替宿主决定进程生死，
   * 由 sidecar 在应答 `shutdown` 之后负责退出（并先 flush stdout，否则应答会被截断）。
   */
  async shutdown(): Promise<{ disposed: number }> {
    if (this.#shutdown) return { disposed: 0 }
    this.#shutdown = true
    const records = [...this.#records.values()]
    for (const record of records) {
      await this.#destroyRecord(record)
    }
    this.#records.clear()
    // 插件子进程必须在退出前收掉，否则会留下孤儿 Node 进程。
    // 会话清了不等于插件清了 —— 插件是进程级的。
    await this.#plugins.deactivateAll()
    return { disposed: records.length }
  }

  // ───────────────────────────── 内部：会话构建 ─────────────────────────────

  #requireRecord(sessionId: string): SessionRecord {
    const record = this.#records.get(sessionId)
    if (!record) fail('SESSION_NOT_FOUND', `会话 ${sessionId} 不存在`)
    return record
  }

  /** prompt 时可能还没有 create（主进程直接 prompt）：按 PromptParams 补一条记录。 */
  #ensureRecord(sessionId: string, cwd: string): SessionRecord {
    const existing = this.#records.get(sessionId)
    if (existing) {
      if (resolve(existing.cwd) !== resolve(cwd)) {
        fail(
          'SESSION_CWD_MISMATCH',
          `会话 ${sessionId} 已绑定工作目录 ${existing.cwd}，本次 prompt 传的是 ${cwd}。` +
            '同一个会话不允许换工作目录（工具路径、项目资源发现都按它固化）。'
        )
      }
      return existing
    }
    return this.#records.set(
      sessionId,
      {
        sessionId,
        // 主进程没先 create 时不知道 workspaceId；侧车不是持久化权威，留空即可。
        workspaceId: '',
        cwd,
        agentDir: undefined,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        title: basename(cwd) || sessionId,
        providerId: undefined,
        modelId: undefined,
        apiKey: undefined,
        messageCount: 0,
        permissionMode: 'ask',
      thinkingLevel: undefined,
        maxSteps: this.#defaultMaxSteps,
        pi: undefined,
        modelRuntime: undefined,
        unsubscribe: undefined,
        providerSignature: undefined,
    resourceLoader: undefined,
    pluginToolNames: [],
        aborted: false,
        runId: undefined,
        settled: false,
        settledAborted: false,
        stopReasonOverride: undefined,
    providerError: undefined,
        toolCallsThisRun: 0,
        running: false,
        alwaysAllowed: new Set<string>(),
        pendingApprovals: new Map<string, PendingApproval>(),
        closing: false
      }
    ).get(sessionId) as SessionRecord
  }

  /**
   * 绑定进程级 agentDir。
   *
   * `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` 是**进程级**的，
   * 所以这里只接受第一个值：后面再来一个不同的目录就直接报错，
   * 而不是「一半会话写 A 目录、一半写 B 目录」这种事后无从排查的状态。
   */
  #bindAgentDir(agentDir: string): void {
    const normalized = resolve(agentDir)
    if (this.#boundAgentDir === undefined) {
      const previous = process.env[PI_AGENT_DIR_ENV]
      this.#boundAgentDir = normalized
      process.env[PI_AGENT_DIR_ENV] = normalized
      process.env[PI_SESSION_DIR_ENV] = `${normalized}${process.platform === 'win32' ? '\\' : '/'}sessions`
      if (previous !== undefined && resolve(previous) !== normalized) {
        // 关键提示：tools-manager.js 在 import 期就把 TOOLS_DIR 固化成 previous/bin 了。
        this.#log(
          `[runtime] agentDir 绑定为 ${normalized}（import 期兜底值曾是 ${previous}）。` +
            'pi 的 rg/fd 缓存目录 TOOLS_DIR 在模块加载时已固化，仍会落在兜底目录；其余（auth.json/models.json/sessions）按新值走。'
        )
      } else {
        this.#log(`[runtime] agentDir 绑定为 ${normalized}`)
      }
      return
    }
    if (this.#boundAgentDir !== normalized) {
      fail(
        'AGENT_DIR_LOCKED',
        `本进程的 agentDir 已绑定为 ${this.#boundAgentDir}，不能再切到 ${normalized}。` +
          'pi 的 agent 目录是进程级环境变量，跨目录混用会污染配置与会话文件。'
      )
    }
  }

  /**
   * 准备插件：读盘 → 重新校验 manifest → 登记 → 激活 → 汇总技能目录与工具定义。
   *
   * ## 为什么 manifest 要在这里再校验一次
   *
   * 主进程安装时校验过，但**磁盘上的文件可能在两次会话之间被改过**。
   * 直接信上游传来的数据等于「校验一次、之后永远相信」——
   * 而这里才是真正要执行那段代码的地方，信任边界必须在本地重画一次。
   *
   * ## 为什么校验失败只记日志不抛错
   *
   * 一个坏插件不该让整个会话建不起来。用户会看到 `session.inspect` 里那条
   * `failed` 与原因，而不是一个笼统的「会话创建失败」。
   */
  async #preparePlugins(
    requests: NonNullable<PromptParams['plugins']>,
    cwd: string
  ): Promise<{ skillPaths: string[]; customTools: ToolDefinition[] }> {
    const skillPaths: string[] = []
    const dirById = new Map<string, string>()
    const manifestById = new Map<string, PluginManifest>()

    for (const request of requests) {
      const manifestPath = join(request.dir, 'manifest.json')
      if (!existsSync(manifestPath)) {
        this.#log(`[runtime] 插件 ${request.id} 缺少 manifest.json：${manifestPath}`)
        continue
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
      } catch (error) {
        this.#log(`[runtime] 插件 ${request.id} 的 manifest.json 不是合法 JSON：${describeError(error)}`)
        continue
      }

      const validation = validatePluginManifest(parsed)
      if (!validation.ok) {
        const detail = validation.errors.map((item) => `${item.path || '(root)'}: ${item.message}`).join('; ')
        this.#log(`[runtime] 插件 ${request.id} 的 manifest 校验失败：${detail}`)
        continue
      }

      // 目录名与 manifest 的 id 不一致就拒绝：否则「启用 A」实际加载了 B，
      // 用户以为自己在授权 A 的权限。
      if (validation.manifest.id !== request.id) {
        this.#log(
          `[runtime] 插件目录与 manifest id 不一致（目录=${request.id} manifest=${validation.manifest.id}），已跳过`
        )
        continue
      }

      manifestById.set(validation.manifest.id, validation.manifest)
      dirById.set(validation.manifest.id, request.dir)
      this.#plugins.register(validation.manifest, request.dir)
    }

    const failures = await this.#plugins.activateAll()
    for (const [pluginId, message] of failures) {
      this.#log(`[runtime] 插件 ${pluginId} 激活失败：${message}`)
    }

    const active = new Set(
      this.#plugins
        .list()
        .filter((info) => info.state === 'active')
        .map((info) => info.id)
    )

    // 插件自带的技能目录并入内核的技能搜索路径 —— 复用已有的 skills 机制，
    // 插件作者不需要自己实现「怎么把规范送进系统提示」。
    for (const [pluginId, manifest] of manifestById) {
      if (!active.has(pluginId)) continue
      const dir = dirById.get(pluginId)
      if (!dir) continue
      for (const relative of manifest.contributes?.skills ?? []) {
        skillPaths.push(isAbsolute(relative) ? relative : resolvePath(dir, relative))
      }
    }

    // 工具注册。跨插件重名要在这里拦住：注册是同名覆盖的，
    // 两个插件声明同名工具会让「谁生效」取决于登记顺序 —— 那是不可接受的不确定性。
    const seen = new Set<string>()
    const customTools: ToolDefinition[] = []
    for (const tool of this.#plugins.contributedTools()) {
      if (!active.has(tool.pluginId)) continue
      if (seen.has(tool.toolName)) {
        this.#log(`[runtime] 工具名冲突，已跳过：${tool.pluginId} 的 ${tool.toolName}（前面的插件已注册同名工具）`)
        continue
      }
      seen.add(tool.toolName)

      customTools.push({
        name: tool.toolName,
        label: tool.toolName,
        description: tool.description,
        // manifest 里放的是 JSON Schema。pi 在运行时用 AJV 校验，所以结构上就是对的；
        // 这里的一次断言是 JSON Schema 与 typebox 的 `TSchema` 之间的桥 ——
        // 一个坏 schema 的后果是「模型看到校验错误」，不是崩溃。
        parameters: (tool.parameters ?? { type: 'object', properties: {} }) as never,
        // 参数逐个列全（而不是只写前两个）：`execute` 的第五个参数带扩展上下文，
        // 少写会让类型与 pi 的 AgentTool 对不上。
        execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
          const result = await this.#plugins.callTool(tool.pluginId, tool.toolName, params, cwd)
          return {
            content: [{ type: 'text' as const, text: result.content }],
            // `details` 在 AgentToolResult 里是必填的。不回传 undefined 而是带上来源，
            // 这样从一次工具结果就能看出它来自哪个插件的哪个工具 —— 排查时很有用。
            details: { pluginId: tool.pluginId, tool: tool.toolName },
            isError: result.isError
          }
        }
      })
    }

    if (customTools.length > 0 || skillPaths.length > 0) {
      this.#log(
        `[runtime] 插件贡献：工具 ${customTools.map((tool) => tool.name).join(', ') || '（无）'}；` +
          `技能目录 ${skillPaths.length} 个`
      )
    }

    return { skillPaths, customTools }
  }

  /** 懒创建/复用 pi 会话，并按需切换 provider / model。 */
  async #ensurePiSession(
    record: SessionRecord,
    cwd: string,
    agentDir: string,
    provider: PromptParams['provider'],
    modelId: string,
    apiKey: string | undefined,
    plugins: PromptParams['plugins'],
    /** 已落盘的历史（仅在该会话首次建内核会话时采用）。 */
    history: ChatMessage[] | undefined
  ): Promise<AgentSession> {
    if (!record.modelRuntime) {
      // modelsPath: null —— 完全不读 models.json（provider 全部走 registerProvider），
      // 既少一处落盘，也保证「验证时用的配置」和「真跑时用的配置」是同一份。
      record.modelRuntime = await ModelRuntime.create({ modelsPath: null })
    }
    const runtime = record.modelRuntime

    const signature = JSON.stringify([
      provider.id,
      provider.baseUrl ?? '',
      provider.apiStyle,
      apiKey ?? '',
      provider.models.map((model) => [model.id, model.label, model.contextWindow ?? 0, model.supportsReasoning ?? false])
    ])
    if (record.providerSignature !== signature) {
      try {
        registerPiProvider(runtime, provider, apiKey, modelId)
      } catch (error) {
        fail('PROVIDER_REGISTER_FAILED', describeError(error))
      }
      record.providerSignature = signature
    }

    const model = runtime.getModel(provider.id, modelId)
    if (!model) {
      fail(
        'MODEL_NOT_FOUND',
        `pi 解析不到模型 ${provider.id}/${modelId}；请检查 provider 的 apiStyle / baseUrl 与模型 ID。`
      )
    }

    if (record.pi) {
      const current = record.pi.model
      // provider 和 model **都要比**：两家 provider 可能有同名的 model id，
      // 只比 id 会在切 provider 时静默沿用旧 provider 的端点。
      if (current && (current.provider !== provider.id || current.id !== modelId)) {
        // provider/model 每轮都可以变（协议如此），所以复用会话而不是重建 ——
        // 重建会丢掉 pi 侧的对话上下文。setModel 会把选择写进内存会话记录。
        try {
          await record.pi.setModel(model)
        } catch (error) {
          fail('MODEL_SWITCH_FAILED', describeError(error))
        }
      }
      return record.pi
    }

    const settingsManager = SettingsManager.inMemory()
    /**
     * ⚠️ **必须显式把项目标成「不信任」** —— 默认是「信任」。
     *
     * 这一行是安全边界，不是配置偏好。`SettingsManager` 的 `projectTrusted` **默认 `true`**，
     * 而项目级资源加载完全由它决定（`package-manager.js`：`if (projectTrusted) { … }`）。
     * 于是「克隆一个陌生仓库、拿它当工作目录」会让那个仓库：
     *
     *  - **执行** `.pi/extensions/*.js` —— 在 sidecar 进程里，而那正是握着 API key 的进程；
     *  - 把 `.pi/SYSTEM.md` / `.pi/APPEND_SYSTEM.md` 的内容**注入系统提示**（静默的提示注入）；
     *  - 让我们加载它提供的 `.pi/skills/`、`.pi/prompts/`、`.pi/themes/`、`.pi/mcp.json`。
     *
     * 这三件事都被 `verify:project-trust` 抓过现行（那条自测在修复前是红的）。
     * 文档里曾经写着「inMemory 下 pi 不读项目配置」——**那是错的**，见 §7.9。
     *
     * 关掉之后，工作区里的这些资源一律不加载：我们的技能来自 `<agentDir>/skills`
     * 与插件贡献的目录，提示词由我们自己拼。要支持「项目自带扩展」必须先做信任机制
     * （pi 有 `resolveProjectTrust` 回调可以接），那是产品决策，不该靠默认值顺带发生。
     */
    settingsManager.setProjectTrusted(false)

    // 插件在会话建立时准备一次。插件进程是进程级复用的，所以这里主要是
    // 「登记 + 首次激活 + 汇总贡献」，重复调用的成本很低。
    const pluginContribution = plugins && plugins.length > 0
      ? await this.#preparePlugins(plugins, cwd)
      : { skillPaths: [], customTools: [] }

    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      // 审批闸门 + MCP（读 <agentDir>/mcp.json）+ codemode/tool_search。
      // SDK 不会像 CLI 那样自动装 MCP，必须显式放进 extensionFactories。
      extensionFactories: [
        this.#createApprovalFactory(record),
        createCodemodeExtension({ mode: 'on' }),
        createToolSearchExtension(),
        createMcpExtension({ startupWaitMs: 12_000 }),
        this.#createSubagentFactory(record, agentDir)
      ],
      // 插件自带的技能目录。内核会像扫描自己的技能目录一样扫描它们，
      // 于是插件的「规范/手册」自动进入渐进式披露，插件作者不用管提示词。
      ...(pluginContribution.skillPaths.length > 0
        ? { additionalSkillPaths: pluginContribution.skillPaths }
        : {})
    })
    // createAgentSession 只在自己构造 DefaultResourceLoader 时才会 reload；
    // 我们传了 loader，就必须自己先 reload（docs/sdk.md 的示例同样如此）。
    await resourceLoader.reload()

    // 把落盘的历史喂回内核，修掉「重启后模型失忆」。
    //
    // 只在**为这个会话新建内核会话时**做一次：之后内核自己就是最新的，
    // 再灌一次会让同一段对话在上下文里出现两遍（既费钱又会让模型困惑）。
    const seeded = history && history.length > 0
      ? toPiHistory(history, {
          providerId: provider.id,
          api: provider.apiStyle,
          model: modelId
        })
      : []

    const sessionManager = SessionManager.inMemory(cwd)
    for (const message of seeded) {
      sessionManager.appendMessage(message)
    }
    if (seeded.length > 0) {
      this.#log(`[runtime] 已用落盘历史恢复上下文：重放 ${seeded.length} 条消息`)
    }

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime: runtime,
      model,
      // 内存版设置：不读也不写 settings.json。副作用是**项目/工作区里配置的扩展不会被加载**，
      // 这对「打开别人的仓库」是好事（避免工作区里的扩展代码被静默执行）。
      settingsManager,
      // 会话持久化归主进程；内核不写会话文件。历史由上面 appendMessage 注入。
      sessionManager,
      resourceLoader,
      // ⚠️ `tools` **同时是白名单**（sdk.js：allowedToolNames = options.tools）。
      // 不在这个数组里的工具会被直接从工具定义表里过滤掉 —— 连注册都不会发生。
      // 所以插件贡献的工具必须并进来，否则会出现「插件已激活、技能也进了系统提示，
      // 但工具对模型不可见」这种很难从现象反推的故障。这条是
      // verify:renderer 里「插件工具已被注册给内核」那条断言抓出来的。
      tools: [
        ...FULL_TOOLS,
        ...pluginContribution.customTools.map((tool) => tool.name),
        // 扩展注册的工具也必须进白名单，否则 setActiveTools 时模型看不到它们。
        'run_subagent',
        'codemode',
        'tool_search'
      ],
      /**
       * 思考强度在建会话时传给内核（见下面 record.thinkingLevel 的说明）。
       */
      thinkingLevel: record.thinkingLevel,
      // 插件贡献的工具走 customTools：它们的执行体在插件子进程里，
      // 由 plugin-host 代理。它们同样要过审批闸门（闸门挂在 tool_call 事件上，
      // 而 pi 对所有工具调用都会发这个事件，不分来源）。
      ...(pluginContribution.customTools.length > 0
        ? { customTools: pluginContribution.customTools }
        : {})
    })

    record.pi = session
    record.resourceLoader = resourceLoader
    record.pluginToolNames = pluginContribution.customTools.map((tool) => tool.name)
    record.unsubscribe = session.subscribe((event) => {
      this.#onPiEvent(record, event)
    })

    // 显式绑定扩展运行时。实测**不调用也能拦到 tool_call**（见文件头第 1 条），
    // 这里补上是为了拿到与文档一致的 uiContext/mode 绑定与 session_start 语义。
    try {
      await session.bindExtensions({ mode: 'print' })
    } catch (error) {
      this.#log(`[runtime] bindExtensions 失败（审批闸门不依赖它，继续运行）：${describeError(error)}`)
    }

    this.#log(
      `[runtime] pi 会话已创建 session=${record.sessionId} cwd=${cwd} agentDir=${agentDir} ` +
        `model=${provider.id}/${modelId} tools=${JSON.stringify(session.getActiveToolNames())}`
    )
    return session
  }

  /**
   * 按权限模式设定**生效**工具集（硬保证仍在审批闸门）。
   *
   * ## 为什么必须显式激活插件工具
   *
   * `createAgentSession({ customTools })` 只是把工具**注册**进去，不等于**激活**。
   * 实测：注册之后 `getActiveToolNames()` 里仍然只有内置工具，插件工具要显式加进
   * 生效集合才会被模型看到。（这条是被 `verify:renderer` 里
   * 「插件工具已被注册给内核」那条断言抓出来的 —— 插件明明 active、
   * 技能也进了系统提示，工具却不可用。）
   *
   * ## 为什么只读模式下不激活插件工具
   *
   * 插件的权限声明是**按插件**而不是按工具的，我们无法判断某个工具是不是只读。
   * 所以在只读模式下干脆不激活它们 —— 比「激活后靠审批闸门兜底」更清楚：
   * 模型连看见都看不见，就不存在误调用的可能。
   */
  #applyToolPolicy(record: SessionRecord, pi: AgentSession): void {
    const base = record.permissionMode === 'readonly' ? READONLY_TOOLS : FULL_TOOLS
    const pluginTools = record.permissionMode === 'readonly' ? [] : record.pluginToolNames
    const current = pi.getActiveToolNames()
    /*
      MCP / codemode / tool_search / 资源工具由扩展在连接后激活。
      若这里只 set 内置名单，会把它们冲掉，表现为「配了 MCP 模型却看不见」。
      只读模式仍不保留 mcp（避免只读被 MCP 写工具钻空）。
    */
    const preserved =
      record.permissionMode === 'readonly'
        ? []
        : current.filter(
            (name) =>
              name.startsWith('mcp__') ||
              name === 'codemode' ||
              name === 'tool_search' ||
              name.startsWith('list_mcp') ||
              name.startsWith('read_mcp') ||
              name === 'run_subagent'
          )
    const desired = [...new Set([...base, ...pluginTools, ...preserved, 'run_subagent'])]

    const same = current.length === desired.length && desired.every((name) => current.includes(name))
    if (same) return
    try {
      pi.setActiveToolsByName(desired)
    } catch (error) {
      // 收窄失败不影响安全性：审批闸门在 readonly 下会拦掉所有非读工具。
      this.#log(`[runtime] setActiveToolsByName 失败（不影响 readonly 硬拦截）：${describeError(error)}`)
    }
  }

  #createApprovalFactory(record: SessionRecord): ExtensionFactory {
    return createApprovalExtension({
      getMode: () => record.permissionMode,
      request: (request) => this.#handleApproval(record, request),
      // 差异预览在审批之前算好：让用户在点「允许」之前就看清要改哪些行。
      // 用会话的 cwd 解析相对路径，与工具真正执行时的基准一致。
      preview: (toolName, args) => buildApprovalPreview(toolName, args, record.cwd)
    })
  }

  /**
   * 子智能体：注册 `run_subagent`，并在每轮 before_agent_start 把启用列表挂进系统提示。
   * 工具结果返回人设 + 任务，由当前会话按该人设继续（避免嵌套 prompt 重入）。
   */
  #createSubagentFactory(_record: SessionRecord, agentDir: string): ExtensionFactory {
    return async (pi) => {
      type SubDef = {
        id: string
        name: string
        description: string
        systemPrompt: string
        tools: 'readonly' | 'full' | 'none'
        enabled: boolean
      }
      const loadEnabled = (): SubDef[] => {
        const path = join(agentDir, 'subagents.json')
        if (!existsSync(path)) return []
        try {
          const raw = JSON.parse(readFileSync(path, 'utf8')) as { subagents?: SubDef[] }
          return (raw.subagents ?? []).filter((s) => s && s.enabled !== false)
        } catch {
          return []
        }
      }

      pi.on('before_agent_start', async (event) => {
        const enabled = loadEnabled()
        if (enabled.length === 0) return
        const lines = enabled
          .map((s) => `- \`${s.id}\` **${s.name}**（工具档 ${s.tools}）：${s.description}`)
          .join('\n')
        return {
          systemPrompt: `${event.systemPrompt}\n\n## 可委派的子智能体\n需要专项分工时调用工具 \`run_subagent\`（一次一个）：\n${lines}\n`
        }
      })

      pi.registerTool({
        name: 'run_subagent',
        label: 'Run subagent',
        description:
          'Delegate a focused task to a configured subagent by id. Returns the subagent persona and task for you to complete in the next steps.',
        parameters: {
          type: 'object',
          properties: {
            subagentId: { type: 'string', description: 'Id from the subagent list' },
            task: { type: 'string', description: 'Task for the subagent' }
          },
          required: ['subagentId', 'task']
        } as never,
        execute: async (
          _toolCallId: string,
          params: { subagentId?: string; task?: string },
          _signal?: AbortSignal,
          _onUpdate?: unknown,
          _ctx?: unknown
        ) => {
          const subagentId = String(params?.subagentId ?? '')
          const task = String(params?.task ?? '').trim()
          if (!subagentId || !task) {
            return { content: [{ type: 'text' as const, text: 'subagentId 与 task 均为必填' }], details: {} }
          }
          const enabled = loadEnabled()
          const def = enabled.find((s) => s.id === subagentId)
          if (!def) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `未找到启用的子智能体「${subagentId}」。可用：${enabled.map((s) => s.id).join(', ') || '（无）'}`
                }
              ],
              details: {}
            }
          }
          const text = [
            `已委派子智能体「${def.name}」（${def.id}，工具档 ${def.tools}）。`,
            '请立刻按以下人设完成任务，并给出最终答复；不要再次调用 run_subagent。',
            '',
            '【人设】',
            def.systemPrompt,
            '',
            '【任务】',
            task
          ].join('\n')
          return {
            content: [{ type: 'text' as const, text }],
            details: { subagentId: def.id, name: def.name }
          }
        }
      } as never)
    }
  }

  // ───────────────────────────── 内部：事件与审批 ─────────────────────────────

  #onPiEvent(record: SessionRecord, event: AgentSessionEvent): void {
    const runId = record.runId
    if (runId === undefined) {
      // 没有活跃 run（例如扩展主动触发的一轮）：不翻译，避免发出 runId 空的事件。
      return
    }

    if (event.type === 'agent_settled') {
      record.settled = true
      record.settledAborted = event.aborted
    }

    try {
      const translated = translateEvent(event, {
        runId,
        sessionId: record.sessionId,
        aborted: () => record.aborted
      })
      if (translated) {
        if (translated.type === 'message.committed') {
          record.messageCount += 1
          // provider 的错误是**随定稿消息回来**的，不是抛异常。
          // 在这里认领它，`prompt()` 才有机会把这一轮判成失败而不是 end_turn。
          if (translated.message.role === 'assistant') {
            const errorPart = translated.message.parts.find((part) => part.kind === 'error')
            if (errorPart && errorPart.kind === 'error' && !record.providerError) {
              record.providerError = errorPart.message
            }
          }
        }
        this.#emit(record, translated)
      }
    } catch (error) {
      // 事件翻译失败绝不能把 agent 循环带崩。
      this.#log(`[runtime] 翻译事件失败 type=${event.type}: ${describeError(error)}`)
    }

    // maxSteps 兜底：pi 1.1.0 没有这个选项（文件头第 8 条），只能自己数。
    if (event.type === 'tool_execution_start') {
      record.toolCallsThisRun += 1
      if (record.maxSteps > 0 && record.toolCallsThisRun > record.maxSteps) {
        this.#log(
          `[runtime] 会话 ${record.sessionId} 本轮工具调用已超过 maxSteps=${record.maxSteps}，主动中止`
        )
        record.stopReasonOverride = 'max_steps'
        this.#denyAllPending(record, 'maxSteps 已耗尽，审批请求自动作废')
        void record.pi?.abort().catch((error: unknown) => {
          this.#log(`[runtime] maxSteps 中止失败：${describeError(error)}`)
        })
      }
    }
  }

  #emit(record: SessionRecord, event: AgentEvent): void {
    try {
      this.#writeEvent(record.sessionId, event)
    } catch (error) {
      this.#log(`[runtime] 写事件失败 type=${event.type}: ${describeError(error)}`)
    }
  }

  /**
   * 审批闸门的异步等待点。
   *
   * 注意**不要**用 pi 的 `ctx.ui.confirm()`：没有真 uiContext 时它走 noOpUIContext，
   * 恒定返回 false，会把所有工具静默拒绝。这里的做法是发 `approval.requested`
   * 事件给主进程，然后 await 一个由 `approval.resolve` RPC 唤醒的 promise。
   */
  async #handleApproval(record: SessionRecord, request: ApprovalRequest): Promise<ApprovalDecision> {
    const fingerprint = approvalFingerprint(request.toolName, request.args)

    // allow-always 命中：同一 (工具名, 参数指纹) 不再问。
    if (record.alwaysAllowed.has(fingerprint)) {
      return 'allow-once'
    }

    if (record.closing) return 'deny'

    this.#emit(record, {
      type: 'approval.requested',
      runId: record.runId ?? '',
      approvalId: request.approvalId,
      callId: request.callId,
      toolName: request.toolName,
      args: request.args,
      risk: request.risk,
      // approval.ts 算出的人类可读危险原因，UI 要显示给用户看（JSON.stringify 会丢掉 undefined）。
      danger: request.danger,
      // 执行前的差异预览（write / edit 才有）。用户看不到要改什么，审批就只是走过场。
      previewDiff: request.previewDiff
    })

    const decision = await new Promise<ApprovalDecision>((settle) => {
      const timer = setTimeout(() => {
        // 必须显式 resolve 成 deny：handler 抛错是「阻断执行」的 fail-safe 路径，
        // 但靠抛错表达超时会把错误文本混进工具结果里，语义不清。
        record.pendingApprovals.delete(request.approvalId)
        this.#log(
          `[runtime] 审批 ${request.approvalId}（${request.toolName}）等待超时 ${this.#approvalTimeoutMs}ms，按 deny 处理`
        )
        settle('deny')
      }, this.#approvalTimeoutMs)
      // Node 的定时器默认 ref 住事件循环；unref 掉可以让「只剩一个待审批」不至于
      // 阻止进程在 stdin 关闭后退出。
      timer.unref?.()
      record.pendingApprovals.set(request.approvalId, { resolve: settle, timer })
    })

    if (decision === 'allow-always') {
      record.alwaysAllowed.add(fingerprint)
    }
    return decision
  }

  #settleApproval(record: SessionRecord, approvalId: string, decision: ApprovalDecision): boolean {
    const pending = record.pendingApprovals.get(approvalId)
    if (!pending) return false
    record.pendingApprovals.delete(approvalId)
    clearTimeout(pending.timer)
    pending.resolve(decision)
    return true
  }

  /**
   * 把所有待裁决审批立刻判 deny。
   *
   * 这是必须的收尾动作：`tool_call` handler 正 await 这些 promise，
   * 不清掉就会留下悬挂的 promise（dispose 后还挂着 5 分钟定时器）。
   */
  #denyAllPending(record: SessionRecord, reason: string): void {
    if (record.pendingApprovals.size === 0) return
    const ids = [...record.pendingApprovals.keys()]
    for (const id of ids) {
      this.#log(`[runtime] 审批 ${id} 由运行时判定为 deny：${reason}`)
      this.#settleApproval(record, id, 'deny')
    }
  }

  async #destroyRecord(record: SessionRecord): Promise<void> {
    if (record.closing) return
    record.closing = true
    this.#denyAllPending(record, '会话已关闭')
    try {
      record.unsubscribe?.()
    } catch (error) {
      this.#log(`[runtime] 取消订阅失败 session=${record.sessionId}: ${describeError(error)}`)
    }
    record.unsubscribe = undefined
    try {
      // dispose 会 abort 活跃工作、失效扩展上下文、断开与 agent 的连接。
      record.pi?.dispose()
    } catch (error) {
      this.#log(`[runtime] dispose 失败 session=${record.sessionId}: ${describeError(error)}`)
    }
    record.pi = undefined
    this.#records.delete(record.sessionId)
  }

  // ───────────────────────────── 内部：快照 ─────────────────────────────

  #snapshotMessages(record: SessionRecord): ChatMessage[] {
    const pi = record.pi
    if (!pi) return []
    const runId = record.runId ?? ''
    const messages: ChatMessage[] = []
    for (const message of pi.messages) {
      try {
        const converted = toChatMessage(message, runId)
        if (converted) messages.push(converted)
      } catch (error) {
        this.#log(`[runtime] 快照消息失败：${describeError(error)}`)
      }
    }
    return messages
  }

  #toSession(record: SessionRecord): Session {
    const session: Session = {
      id: record.sessionId,
      workspaceId: record.workspaceId,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      messageCount: record.messageCount
    }
    if (record.providerId !== undefined) session.providerId = record.providerId
    if (record.modelId !== undefined) session.modelId = record.modelId
    return session
  }
}
