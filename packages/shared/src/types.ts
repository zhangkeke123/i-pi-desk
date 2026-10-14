/**
 * 领域模型：渲染层、主进程、agent sidecar 三方共用的数据形状。
 *
 * 这里刻意不出现任何 pi-* 的类型：pi 只是「当前选用的内核实现」，它的类型必须在
 * agent-host 内部被翻译成下面这套自有模型。这样换内核（换成别的 MIT 库、或自研、
 * 或走服务端编排）时，UI 与 IPC 契约一行都不用改。
 */

// ───────────────────────────── 工作区 ─────────────────────────────

export interface Workspace {
  id: string
  /** 用户可见名字，默认取目录名。 */
  name: string
  /** 绝对路径。 */
  path: string
  createdAt: string
  lastOpenedAt: string
  /**
   * 已从「最近目录」里移除。
   *
   * 移除用**标记**而不是删除记录：会话靠 `workspaceId` 关联目录，
   * 删掉记录就丢了 id→路径 的对应关系，那个目录下的对话会变成孤儿
   * （还在磁盘上，但界面按当前工作区过滤，再也看不到）。
   * 藏起来的记录仍然能被 `getWorkspace(id)` 找到（会话解析 cwd 要用），
   * 重新打开同一路径时会取消隐藏并**复用同一个 id**。
   */
  hidden?: boolean
  /** 侧栏项目分组色点（如 `#6b9b7a`）。 */
  color?: string
}

/** 侧栏会话状态：新建 / 进行中 / 已完成 / 异常。 */
export type SessionRunStatus = 'new' | 'running' | 'done' | 'error'

// ───────────────────────────── 会话 ─────────────────────────────

export type MessageRole = 'user' | 'assistant' | 'system'

export type RunStopReason = 'end_turn' | 'aborted' | 'max_steps' | 'error'

export interface UsageStats {
  inputTokens: number
  outputTokens: number
  /** 有价格表时才有；未知则为 undefined，不要用 0 冒充「免费」。 */
  costUsd?: number
}

/** 一次工具调用的完整生命周期。 */
export interface ToolCallPart {
  kind: 'tool-call'
  callId: string
  name: string
  /** 原始入参，UI 负责按 name 渲染。 */
  args: unknown
  state: 'pending' | 'awaiting-approval' | 'running' | 'succeeded' | 'failed' | 'denied'
  /** 成功时的返回值（已裁剪，避免把整份文件塞进消息）。 */
  result?: unknown
  error?: string
  startedAt?: string
  finishedAt?: string
}

export interface ApprovalPart {
  kind: 'approval'
  approvalId: string
  callId: string
  toolName: string
  args: unknown
  /**
   * 命中危险模式时给出的原因（如「递归强制删除」）。
   * 只有这类操作才会在 `auto` 模式下仍然弹审批，所以 UI 必须把它显示出来 ——
   * 否则用户看到的就是「明明设了自动放行，为什么还问我」。
   */
  danger?: string
  /**
   * **执行前**算好的差异预览（unified diff 风格的文本）。
   *
   * 为什么必须在审批时给：让用户盲批准一次文件写入，等于把权限层做成摆设。
   * 「看得到要改什么」才是审批真正有用的前提。
   *
   * 由 sidecar 计算（只有它能用 pi 的 `computeEditsDiff`），随事件传上来。
   */
  previewDiff?: string
  /** 谁批准的、何时。pending 时为空。 */
  decision?: 'allow-once' | 'allow-always' | 'deny'
  decidedAt?: string
}

export type MessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | ToolCallPart
  | ApprovalPart
  | { kind: 'error'; message: string }

export interface ChatMessage {
  id: string
  role: MessageRole
  createdAt: string
  parts: MessagePart[]
  usage?: UsageStats
  /** 该消息由哪次 run 产生，便于把事件流对回到消息上。 */
  runId?: string
}

export interface Session {
  id: string
  workspaceId: string
  title: string
  createdAt: string
  updatedAt: string
  providerId?: string
  modelId?: string
  messageCount: number
  /**
   * 是否置顶。
   *
   * 放在会话本身而不是「一份独立的置顶表」里：置顶是会话的属性，
   * 跟着会话文件走就不会出现「会话删了、置顶表里还留一条」这种要单独清理的状态。
   */
  pinned?: boolean
  /** 最近一次 run 的归类状态（侧栏图标用）。 */
  runStatus?: SessionRunStatus
  /** 会话自定义强调色（可选）。 */
  color?: string
}

// ───────────────────────────── 模型 provider ─────────────────────────────

/**
 * provider 的协议族。取值与 pi-ai 的 api 风格对齐，但这是我们的枚举，
 * 不是它的类型引用。
 */
export type ProviderApiStyle =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai'
  | 'openai-compatible'

export interface ProviderModel {
  id: string
  /** 显示名。可选 —— 多数情况下 id 就是最好的显示名。 */
  label?: string
  contextWindow?: number
  supportsTools?: boolean
  supportsReasoning?: boolean
}

export interface ProviderConfig {
  id: string
  label: string
  apiStyle: ProviderApiStyle
  /** 自建 / 内网端点（Ollama、vLLM、企业网关）必填；官方云服务可留空走默认。 */
  baseUrl?: string
  /**
   * API Key 的**引用**，不是明文。
   * 明文由主进程用 Electron safeStorage 加密后单独落盘，见 docs/ARCHITECTURE.md。
   */
  apiKeyRef?: string
  /** 手工声明的模型列表；为空表示依赖自动发现。 */
  models: ProviderModel[]
  /** 内网部署时同一个 provider 下可配多个端点做轮换。 */
  enabled: boolean
  /**
   * 来源。用于区分「用户自己加的」与「控制面下发的」：
   * 同步时只替换后者，绝不覆盖用户手工配置 —— 否则一次同步就把人的东西清掉了。
   * 缺省视为 `local`（旧配置没有这个字段）。
   */
  source?: 'local' | 'control-plane'
  createdAt: string
  updatedAt: string
}

// ───────────────────────────── 权限 ─────────────────────────────

/**
 * 权限三态。仿写时这是必须从第一天就做对的东西：
 * 一旦有工具能执行 shell / 写文件，没有审批层就等于把用户机器交出去。
 */
export type PermissionMode = 'readonly' | 'ask' | 'auto'

export type ToolRisk = 'read' | 'write' | 'execute' | 'network'

// ───────────────────────────── 设置 ─────────────────────────────

/**
 * 主题偏好。
 *
 * `system` 跟随操作系统亮暗，映射到 `midnight`（暗）或 `daylight`（亮）；
 * 其余是具体主题 id —— 它们必须与渲染层 `src/styles.css` 里的
 * `:root[data-theme='…']` 段一一对应（`verify:doc-claims` 会检查两边不漂）。
 *
 * 兼容：历史设置里可能存着 `'light'` / `'dark'`（旧的两值联合）。它们从未被
 * 真正写入过（当年的浅色主题是死代码），但手改过 settings.json 的人可能留下过 ——
 * 渲染层的 `resolveTheme()` 会把它们分别映射到 `daylight` / `midnight`。
 */
export type ThemePreference = 'system' | 'midnight' | 'graphite' | 'daylight' | 'paper' | 'contrast'

export interface AppSettings {
  theme: ThemePreference
  locale: 'zh-CN' | 'en'
  permissionMode: PermissionMode
  defaultProviderId?: string
  defaultModelId?: string
  /**
   * 默认工作空间绝对路径。
   * 快捷会话落在这里；启动时优先恢复到此目录。
   * 安装包可通过 `install-defaults.json` 预置，也可在设置里改。
   */
  defaultWorkspacePath?: string
  /** 单次 run 的最大工具调用轮数，防止 agent 打转烧钱。 */
  maxSteps: number
  /**
   * 思考强度。缺省时由内核决定（内核默认 `medium`）。
   *
   * 放在设置里而不是只放在本次输入上，是因为它更像「我平时希望它想多久」，
   * 而不是「这一句要它想多久」—— 输入区的 chip 改的就是这个设置。
   */
  thinkingLevel?: ThinkingLevelValue
  /** 控制面地址；为空表示纯本地模式。 */
  controlPlaneUrl?: string
}

export const DEFAULT_SETTINGS: AppSettings = {
  /** 默认清新浅色主体（daylight）；用户仍可改回 midnight / 跟随系统。 */
  theme: 'daylight',
  locale: 'zh-CN',
  permissionMode: 'ask',
  maxSteps: 40,
  // 与内核的默认值一致（见内核 runtime.d.ts 的说明：默认实际是 medium）。
  thinkingLevel: 'medium'
}

// ───────────────────────────── 运行时状态 ─────────────────────────────

export type RuntimeState = 'starting' | 'ready' | 'crashed' | 'stopped'

export interface RuntimeStatus {
  state: RuntimeState
  /** 重启次数，UI 据此提示「反复崩溃」。 */
  restarts: number
  lastError?: string
}

export interface AppInfo {
  name: string
  version: string
  electron: string
  node: string
  chrome: string
  /**
   * 平台标识。刻意用 string 而不是 NodeJS.Platform：
   * shared 是被渲染层直接引用的契约包，不能依赖 @types/node，
   * 否则渲染层的构建会因为引入 Node 类型而带上不该有的全局。
   */
  platform: string
  userDataPath: string
}

// ───────────────────────────── 工作区文件树 ─────────────────────────────

export type FsEntryKind = 'file' | 'directory'

export interface FsEntry {
  name: string
  /** 相对工作区根的路径，统一用 `/` 分隔（Windows 上也是）。 */
  path: string
  kind: FsEntryKind
}

export interface FilePreview {
  path: string
  /** 文本内容；二进制文件或读取失败时为空串。 */
  text: string
  bytes: number
  /** 是否因超出大小上限被截断。 */
  truncated: boolean
  /** 是否为二进制（UI 应当提示「不支持预览」而不是显示乱码）。 */
  binary: boolean
  /**
   * 版本标记，用于**保存时检测外部修改**。
   *
   * 实现是 `<mtimeMs>:<size>`（不是内容哈希）。理由：读文件时顺手就有这两个值，
   * 而完整内容哈希在「文件很大且被截断」时根本算不出来。
   * 代价是「改了内容但 mtime 与 size 都没变」的极端情况检测不到 ——
   * 这与主流编辑器的做法一致，属于可接受的取舍。
   */
  revision: string
  /**
   * 不可编辑的原因。为空表示可以编辑。
   *
   * **截断或二进制的文件必须只读**：把读到的 512KB 存回去会把原文件毁掉。
   * 这不是保守，是防数据丢失的硬要求。
   */
  readOnlyReason?: string
}

export interface FileWriteInput {
  workspaceId: string
  /** 工作区内的相对路径。 */
  path: string
  text: string
  /**
   * 读取时拿到的 revision。
   * 传 `null` 表示**新建文件**（要求该路径当前不存在）。
   */
  expectedRevision: string | null
}

export interface FileWriteResult {
  path: string
  bytes: number
  /** 写入后的新版本标记，UI 用它更新本地状态，避免下一次保存立刻报「已过期」。 */
  revision: string
}

// ───────────────────────────── 文件树操作 ─────────────────────────────

/**
 * 在工作区里新建文件。
 *
 * `path` 是相对工作区的路径，**父目录必须已存在**。这是刻意的第一步限制：
 * 自动创建多层目录意味着要一边创建一边校验「新目录仍在工作区内」，
 * 而中间层可能已经有软链 —— 那是一条容易写错的路径。当前 UI 也只需要
 * 「在选中的目录里建一个文件」，等真有跨层需求时再连同校验一起做。
 */
export interface FileCreateInput {
  workspaceId: string
  path: string
  /** 初始内容，默认空。 */
  text?: string
}

/**
 * 重命名。
 *
 * `newName` 是**单个名字**（不含路径分隔符）—— 也就是第一步只支持同目录改名。
 * 跨目录移动牵涉「目标目录是否在工作区内」的额外校验，与新建的多层目录是同一个问题，
 * 一并留到需要时再做。
 */
export interface FileRenameInput {
  workspaceId: string
  path: string
  newName: string
}

export interface FileRemoveInput {
  workspaceId: string
  path: string
}

export interface FileMoveInput {
  workspaceId: string
  path: string
  /** 目标目录（工作区内的相对路径，空字符串表示根目录）。 */
  targetDir: string
}

export interface FileMutationResult {
  /** 操作后的相对路径（与传入的可能不同，例如重命名）。 */
  path: string
  /** 重命名前的相对路径。 */
  previousPath?: string
}

// ───────────────────────────── Git（只读） ─────────────────────────────

/** 工作区内发现的一个 Git 仓库根（相对工作区根的路径）。 */
export interface GitRepoInfo {
  /** 空字符串表示工作区根目录本身就是 Git 根。 */
  relativePath: string
  /** 展示名，一般为目录 basename。 */
  name: string
}

export interface GitStatusEntry {
  /** 相对该 Git 仓库根的路径，统一 `/`。 */
  path: string
  indexStatus: string
  workTreeStatus: string
}

export interface GitStatusResult {
  repoRelativePath: string
  branch?: string
  entries: GitStatusEntry[]
  /** Git 不可用或不是仓库等**业务失败**时填这里；仍走 Result.ok。 */
  error?: string
}

export interface GitDiffResult {
  repoRelativePath: string
  filePath: string
  staged: boolean
  diff: string
  error?: string
}

// ───────────────────────────── 工作区搜索 ─────────────────────────────

export interface FsSearchHit {
  /** 相对工作区根的路径，统一 `/`。 */
  path: string
  kind: 'name' | 'content'
  line?: number
  preview?: string
}

export interface FsSearchResult {
  hits: FsSearchHit[]
  truncated: boolean
}

// ───────────────────────────── 终端（PTY） ─────────────────────────────

/**
 * 终端会话句柄。
 *
 * ⚠️ **边界声明（重要）**：这个终端是**用户自己的交互式 shell**，不是 agent 的工具。
 * agent 在本次实现里拿不到 PTY —— 它的 shell 能力仍然是 `bash` 工具，走审批闸门。
 * 这条边界是刻意的：把交互式 shell 交给 agent，等于给它一个能绕过逐条审批的通道
 * （进去之后里面的每一条命令都不再经过我们的 tool_call 钩子）。
 * 将来若要让 agent 用终端，必须做「整个会话级审批」而不是逐命令审批。
 */
export interface TerminalSession {
  id: string
  shell: string
  cwd: string
  cols: number
  rows: number
  createdAt: string
}

export interface TerminalCreateOptions {
  cols?: number
  rows?: number
  cwd?: string
  shell?: string
}

export interface TerminalDataEvent {
  id: string
  /** 已按 16ms / 64KB 合并过的一批输出 —— 不是「一个字节一帧」。 */
  data: string
}

export interface TerminalExitEvent {
  id: string
  exitCode: number
  signal?: number
}

// ───────────────────────────── 技能（磁盘视角） ─────────────────────────────

/**
 * 磁盘上的一个技能。
 *
 * `name` / `description` 来自 frontmatter 的**宽松解析**（主进程不能依赖 pi，
 * 所以这里只做展示用途）。**是否真的生效以内核的 inspect 结果为准** ——
 * 解析失败、缺 description、命名不合法都会被内核丢弃。
 */
export interface InstalledSkill {
  /** 目录名（也是 `/skill:<name>` 用的名字）。 */
  name: string
  /** frontmatter 里声明的名字；缺失或与目录名不同时保留原值供 UI 对比。 */
  declaredName?: string
  description?: string
  filePath: string
  /** frontmatter 解析是否成功；失败时 UI 应提示「内核不会加载它」。 */
  frontmatterOk: boolean
}

// ───────────────────────── 定时任务 ─────────────────────────

/** 周期规则（v1：仅 UI 编排，执行器后续接）。 */
export type ScheduledTaskRepeat = 'daily' | 'weekdays' | 'weekly' | 'monthly'

export interface ScheduledTask {
  id: string
  /** 任务说明 / 触发时要发给 agent 的提示（v1 只存文案）。 */
  description: string
  repeat: ScheduledTaskRepeat
  /** 本地时间 HH:mm（24h）。 */
  timeLocal: string
  /** 展示用时区标签，例如「中国时间」。 */
  timezoneLabel: string
  /** 每次运行是否新开聊天会话。 */
  newChatEachRun: boolean
  providerId?: string
  modelId?: string
  thinkingLevel: ThinkingLevelValue
  createdAt: string
  /**
   * 是否参与调度。执行器尚未接入时仅影响 UI「状态」展示。
   * 缺省按已启用处理（兼容旧落盘数据）。
   */
  enabled: boolean
  /**
   * 最近一次执行完成时间（ISO）。调度未接入前通常为空，UI 展示「尚未执行」。
   */
  lastRunAt?: string
}

// ───────────────────────── 思考强度 ─────────────────────────

/**
 * 思考（推理）强度档位。
 *
 * ⚠️ 这七个值**必须与内核的 `ThinkingLevel` 逐字一致**（内核：
 * `@earendil-works/pi-agent-core` 的 types.d.ts）。shared 不能 import 内核类型
 * （本项目的不变量：pi-* 只在 agent-host 里出现），所以这里手写一份，
 * 并由 `verify:doc-claims` 里的一条断言**直接读内核的 d.ts 比对**，防止两边漂。
 *
 * 不是每个模型都支持全部档位（xhigh / max 只有部分模型家族支持）——
 * 但**渲染层不需要知道这件事**：内核有 clampThinkingLevel()，
 * 会在真正发请求时把档位夹到该模型支持的范围内。
 */
export type ThinkingLevelValue = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// ───────────────────────── 审批 ─────────────────────────

/**
 * 等用户裁决的默认超时（5 分钟）。
 *
 * **单一来源**：主进程用它决定什么时候放弃这次审批（超时按拒绝处理），
 * 渲染层用它显示倒计时。两处各写一份 5 分钟，早晚会出现「界面说还有 2 分钟、
 * 实际已经超时」这种对不上的情况 —— 而这个数字很小、很不显眼，正是最容易漂的那种。
 */
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000
