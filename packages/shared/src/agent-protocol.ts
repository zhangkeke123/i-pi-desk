/**
 * 主进程 ↔ agent sidecar 的线协议。
 *
 * 形态：stdio 上的 NDJSON（一行一个 JSON 对象），即 JSON-RPC 2.0 的简化子集。
 * 为什么不用 Electron 的 utilityProcess / MessagePort：
 *   1) 打包后仍然可用，且 sidecar 可以独立用 `node sidecar.js` 调试，不依赖 Electron；
 *   2) 换语言实现（例如将来把内核挪到 Java 服务）时，只要保留这套线协议，主进程零改动；
 *   3) stdio 天然有背压与进程退出信号，比端口方案少一类「端口被占」故障。
 *
 * 安全约束：sidecar 只从 stdin 读命令、只往 stdout 写协议帧。
 * 因此 **任何日志必须走 stderr**，否则会污染协议流导致解析错乱。
 */

import type {
  ChatMessage,
  PermissionMode,
  ProviderConfig,
  RunStopReason,
  Session,
  ThinkingLevelValue,
  UsageStats
} from './types.js'

/** 主进程 → sidecar 的请求方法。 */
export type RpcMethod =
  | 'ping'
  | 'provider.verify'
  | 'session.create'
  | 'session.load'
  | 'session.prompt'
  | 'session.inspect'
  | 'session.abort'
  | 'session.list'
  | 'session.dispose'
  | 'approval.resolve'
  | 'shutdown'

export interface RpcRequest<P = unknown> {
  id: string
  method: RpcMethod
  params?: P
}

export interface RpcError {
  code: string
  message: string
  details?: string
}

export type RpcResponse =
  | { id: string; result: unknown }
  | { id: string; error: RpcError }

/** sidecar → 主进程的单向通知（无 id，无需应答）。 */
export interface RpcNotification<P = unknown> {
  method: 'agent.event' | 'runtime.log'
  params: P
}

/** 从 stdout 读到的任意一帧。 */
export type RpcFrame = RpcResponse | RpcNotification

// ───────────────────────────── 方法参数 ─────────────────────────────

export interface PromptParams {
  sessionId: string
  /** 本轮用户输入。 */
  text: string
  /** 本轮生效的模型与权限，避免 sidecar 自己读配置造成两处状态源。 */
  provider: ProviderConfig
  /**
   * 明文 key，仅随本次调用传递。
   *
   * sidecar 拿到后只做一件事：`modelRuntime.registerProvider(..., { apiKey })`。
   * 既不写进任何文件，也不放进 `process.env` —— 内存在会话存活期内即可。
   */
  apiKey?: string
  modelId: string
  permissionMode: PermissionMode
  /**
   * 本轮生效的思考强度。
   *
   * 与 modelId / permissionMode 一样**随每次调用传**（而不是让 sidecar 自己读设置）：
   * 两处状态源一定会分叉。缺省表示「按内核默认」。
   */
  thinkingLevel?: ThinkingLevelValue
  cwd: string
  /**
   * pi 的 agent 目录（绝对路径）。
   * sidecar 用它设置 `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR`，
   * 把内核状态关进应用自己的目录，避免污染 `~/.pi`。详见 main/store/pi-config.ts。
   */
  agentDir: string
  /**
   * 已启用的插件：**只给 id 与目录，不给 manifest**。
   *
   * 职责这样切是有意的：
   *  - **主进程决定「哪些启用」**（这是策略，归用户与设置管）；
   *  - **sidecar 自己读盘并重新校验 manifest**（这是信任边界，不能靠上游传过来的数据）。
   *
   * 后者尤其重要：磁盘上的 manifest 可能在两次会话之间被改过。
   * 如果直接信主进程传来的 manifest，就等于「校验一次、之后永远相信」。
   */
  plugins?: Array<{ id: string; dir: string }>
  /** 单次 run 的最大工具调用轮数，防止 agent 原地打转烧钱。 */
  maxSteps: number
  /**
   * 该会话**已落盘的历史消息**，用于内核冷启动时恢复上下文。
   *
   * 为什么需要它：会话消息由主进程落盘，而内核的 `SessionManager` 是 `inMemory` 的。
   * 不补这一步，应用一重启就会出现「界面上历史都在、模型完全不记得」——
   * 用户追问一句「继续改刚才那个函数」，得到的是「哪个函数？」。
   *
   * 语义上有两点必须清楚：
   *  - **主进程仍是持久化的唯一权威**，这里只是给内核一份用于重建上下文的副本；
   *  - sidecar **只在为某会话新建 pi 会话时**采用它，之后一律忽略 ——
   *    因为那之后内核自己就是最新的，再灌一次历史会造成重复。
   */
  history?: ChatMessage[]
}

export interface SessionCreateParams {
  sessionId: string
  workspaceId: string
  cwd: string
  provider?: ProviderConfig
  modelId?: string
}

export interface ProviderVerifyParams {
  provider: ProviderConfig
  /** 明文 key 只在这一次调用里传递，sidecar 不落盘。 */
  apiKey?: string
}

export interface ProviderVerifyResult {
  ok: boolean
  /** 校验方式：列模型 / 发一条最小请求。 */
  checkedBy: 'list-models' | 'minimal-completion'
  models?: string[]
  message?: string
}

// ───────────────────────────── agent 事件 ─────────────────────────────

/**
 * 归一化之后的 agent 事件。
 *
 * 这是整个系统里最需要稳定的一层：UI 只认这些事件。
 * sidecar 负责把 pi-agent-core 的原生事件翻译到这里（翻译逻辑集中在
 * packages/agent-host/src/translate.ts，pi 升级时只改那一个文件）。
 */
export type AgentEvent =
  | { type: 'run.started'; runId: string; sessionId: string }
  | { type: 'text.delta'; runId: string; text: string }
  | { type: 'reasoning.delta'; runId: string; text: string }
  | {
      type: 'tool.started'
      runId: string
      callId: string
      name: string
      args: unknown
    }
  | {
      type: 'tool.finished'
      runId: string
      callId: string
      ok: boolean
      result?: unknown
      error?: string
    }
  | {
      type: 'approval.requested'
      runId: string
      approvalId: string
      callId: string
      toolName: string
      args: unknown
      risk: 'read' | 'write' | 'execute' | 'network'
      /**
       * 命中危险模式时的人话说明（例如「递归强制删除」「强推覆盖远端历史」）。
       * 由 agent-host 的 `approval.ts` 判定并透传；UI 必须显示它 ——
       * 用户看不到原因就无法判断该不该点「允许」。
       */
      danger?: string
      /**
       * **执行前**算好的差异预览（unified diff 风格文本）。
       *
       * 让用户盲批准一次文件写入，等于把权限层做成摆设 ——「看得到要改什么」才是
       * 审批真正有用的前提。由 sidecar 用 pi 的 `computeEditsDiff` / `generateDiffString`
       * 计算（只有它能碰 pi），随事件传上来。
       */
      previewDiff?: string
    }
  | { type: 'usage'; runId: string; usage: UsageStats }
  | { type: 'message.committed'; runId: string; message: ChatMessage }
  | { type: 'run.finished'; runId: string; stopReason: RunStopReason; usage?: UsageStats }
  | { type: 'run.failed'; runId: string; error: RpcError }

export interface AgentEventNotification {
  sessionId: string
  event: AgentEvent
}

/** 主进程下发给 sidecar 的审批裁决。 */
export interface ResolveApprovalParams {
  sessionId: string
  approvalId: string
  decision: 'allow-once' | 'allow-always' | 'deny'
}

/** 会话快照（sidecar → 主进程），用于重建 UI。 */
export interface SessionSnapshot {
  session: Session
  messages: ChatMessage[]
}

// ───────────────────────────── 会话检视（技能 / 系统提示） ─────────────────────────────

/**
 * 一个**已被内核加载**的技能。
 *
 * 注意用词是「已被加载」而不是「存在于磁盘」：内核会丢弃命名不合法、
 * 缺 description、frontmatter 损坏的技能，并给出 diagnostics。
 * UI 必须展示内核的结论，而不是自己扫目录的结果 —— 否则用户会以为自己
 * 放的规范生效了，实际没有。
 */
export interface SkillView {
  name: string
  description: string
  filePath: string
  baseDir: string
  /** 为 true 时该技能不会被模型自动选中，只能通过 `/skill:<name>` 显式调用。 */
  disableModelInvocation: boolean
}

export interface SkillDiagnosticView {
  type: 'warning' | 'error' | 'collision'
  message: string
  path?: string
}

/**
 * 会话检视结果。
 *
 * 这是「让用户看得见 agent 到底看到了什么」的落地：系统提示、生效工具、已加载技能。
 * 对渐进式披露的技能机制来说，这不是可选的调试功能，而是**必要配套** ——
 * 提示词里只放一行目录，界面上再不显示，用户就只能靠猜。
 */
export interface SessionInspectResult {
  systemPrompt: string
  /** `<providerId>/<modelId>`。 */
  model: string
  activeTools: string[]
  skills: SkillView[]
  diagnostics: SkillDiagnosticView[]
  /**
   * 插件运行状态。
   *
   * 放进检视结果是因为插件与技能一样有个「装上了但没生效」的问题：
   * 插件可能 manifest 校验失败、入口 import 失败、或激活时抛错。
   * 只显示「已安装」而不显示「已激活/失败原因」，用户就只能靠猜。
   */
  plugins: PluginRuntimeView[]
}

export interface PluginRuntimeView {
  id: string
  state: 'inactive' | 'activating' | 'active' | 'failed'
  /** 该插件当前可用的工具名（激活后才会填充）。 */
  tools: string[]
  lastError?: string
}
