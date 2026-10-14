/**
 * 渲染层可见的 API 契约（preload 暴露为 `window.desk`）。
 *
 * 为什么把这个接口放在 shared 而不是 preload 里：
 * preload 与渲染层分属两个 tsconfig，接口写两份必然漂移。放这里，两边都引用同一个定义，
 * preload 少实现一个方法、渲染层多调一个方法，都会在 typecheck 阶段报错。
 *
 * 所有方法返回 `Result<T>` 而不是抛异常 —— 渲染层用 `unwrap()`（见 src/lib/ipc.ts）
 * 决定是取值还是把错误码交给 UI 处理。
 */

import type { AgentEventNotification, AgentEvent, ProviderVerifyResult, SessionInspectResult, SessionSnapshot } from './agent-protocol.js'
import type {
  ControlPlaneLoginInput,
  ControlPlaneQuota,
  ControlPlaneStatus,
  ControlPlaneSyncResult
} from './control-plane.js'
import type { Result } from './result.js'
import type {
  AppInfo,
  AppSettings,
  ChatMessage,
  FileCreateInput,
  FileMutationResult,
  FileMoveInput,
  FilePreview,
  FileRemoveInput,
  FileRenameInput,
  FileWriteInput,
  FileWriteResult,
  FsEntry,
  FsSearchResult,
  GitDiffResult,
  GitRepoInfo,
  GitStatusResult,
  InstalledSkill,
  ProviderConfig,
  RuntimeStatus,
  ScheduledTask,
  Session,
  TerminalCreateOptions,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalSession,
  Workspace
} from './types.js'
import type { PluginView } from './plugin.js'
import type {
  McpServerConfigView,
  McpServerSaveInput,
  SubagentDefinition,
  SubagentSaveInput
} from './mcp-subagents.js'

/** provider 的对外视图：不暴露 apiKeyRef 指向的密文细节，只说明「有没有 key」。 */
export type ProviderView = ProviderConfig & { hasApiKey: boolean }

export type SettingsView = AppSettings & {
  /** 这台机器是否有可用的密钥环（决定 UI 要不要禁用「保存 API Key」）。 */
  secretStorageAvailable: boolean
}

export interface PromptRequest {
  sessionId: string
  text: string
  providerId?: string
  modelId?: string
}

export interface PromptResponse {
  stopReason: 'end_turn' | 'aborted' | 'max_steps' | 'error'
}

export type ApprovalDecision = 'allow-once' | 'allow-always' | 'deny'

/** 取消订阅函数。渲染层在 useEffect 清理函数里调用它。 */
export type Unsubscribe = () => void

export interface DeskApi {
  app: {
    info: () => Promise<Result<AppInfo>>
    /**
     * 关窗前的拦截，只为「别把没保存的东西弄丢」这一件事存在。
     *
     * 渲染层每次脏状态变化都要上报（主进程没法自己知道）；用户确认丢弃之后
     * 调 `confirmQuit()` —— 它会真的把窗口关掉。
     */
    setEditorDirty: (dirty: boolean) => Promise<Result<{ dirty: boolean }>>
    confirmQuit: () => Promise<Result<{ closing: boolean }>>
  }
  workspace: {
    list: () => Promise<Result<Workspace[]>>
    open: (path: string) => Promise<Result<Workspace>>
    remove: (id: string) => Promise<Result<{ id: string }>>
    /** 工作区事实（空状态据此生成起手任务，见 §15.18）。 */
    facts: (path: string) => Promise<Result<WorkspaceFacts>>
    /** 侧栏项目色点。 */
    setColor: (input: { id: string; color?: string }) => Promise<Result<Workspace>>
  }
  session: {
    list: () => Promise<Result<Session[]>>
    create: (input: { workspaceId: string; title?: string; providerId?: string; modelId?: string }) => Promise<Result<Session>>
    load: (sessionId: string) => Promise<Result<SessionSnapshot>>
    rename: (input: { id: string; title: string }) => Promise<Result<Session>>
    /** 复制会话（含消息历史），标题追加「副本」。 */
    duplicate: (sessionId: string) => Promise<Result<Session>>
    /** 置顶 / 取消置顶（写进会话文件，列表里立刻可见）。 */
    setPinned: (input: { id: string; pinned: boolean }) => Promise<Result<Session>>
    /** 颜色 / runStatus 等轻量字段。 */
    patch: (input: {
      id: string
      color?: string | null
      runStatus?: Session['runStatus']
    }) => Promise<Result<Session>>
    remove: (sessionId: string) => Promise<Result<{ id: string }>>
  }
  agent: {
    prompt: (input: PromptRequest) => Promise<Result<PromptResponse>>
    abort: (sessionId: string) => Promise<Result<{ aborted: true }>>
    resolveApproval: (
      input: { sessionId: string; approvalId: string; decision: ApprovalDecision }
    ) => Promise<Result<{ resolved: true }>>
    /**
     * 检视会话：agent 真正看到的系统提示、生效工具、已加载技能。
     *
     * 对渐进式披露的技能机制来说这是必要配套 —— 提示词里只放一行技能目录，
     * 界面上再不显示，用户就只能靠猜自己的规范有没有生效。
     */
    inspect: (sessionId: string) => Promise<Result<SessionInspectResult>>
    /**
     * 主动读一次内核状态。
     *
     * 状态本来是推送式的（`events.onRuntimeStatus`），但**推送只覆盖「变化」**：
     * 组件如果在 sidecar 已经就绪之后才挂载，就永远收不到那一次事件，
     * 于是界面会一直停在「启动中」。所以需要一个能主动问的入口。
     */
    status: () => Promise<Result<RuntimeStatus>>
  }
  /**
   * 技能管理（磁盘视角）。
   *
   * 与 `agent.inspect().skills` 的区别很重要：
   *  - 这里是**磁盘上有什么**，用于管理（安装/删除）；
   *  - inspect 是**内核真正加载了什么**，用于回答「生效了吗」。
   * 两者不一致时（例如缺 description 被内核丢弃），UI 应当明确标出「未生效」。
   */
  skills: {
    list: () => Promise<Result<InstalledSkill[]>>
    install: (input: { name: string; content: string }) => Promise<Result<InstalledSkill>>
    remove: (name: string) => Promise<Result<{ name: string }>>
    openDir: () => Promise<Result<{ path: string }>>
  }
  /** MCP 服务器（落盘后同步到 pi agentDir/mcp.json，新会话生效）。 */
  mcp: {
    list: (workspaceId?: string) => Promise<Result<McpServerConfigView[]>>
    save: (input: McpServerSaveInput) => Promise<Result<McpServerConfigView>>
    remove: (input: { id: string; scope: 'global' | 'project'; workspaceId?: string }) => Promise<Result<{ id: string }>>
    setEnabled: (input: {
      id: string
      scope: 'global' | 'project'
      workspaceId?: string
      enabled: boolean
    }) => Promise<Result<McpServerConfigView>>
    openDir: () => Promise<Result<{ path: string }>>
    /** 把当前可见配置写进运行时 mcp.json（可选 workspaceId 合并项目级）。 */
    syncRuntime: (workspaceId?: string) => Promise<Result<{ path: string; count: number }>>
  }
  /** 子智能体定义（内置 + 自定义）；启用的会注入委派工具。 */
  subagents: {
    list: () => Promise<Result<SubagentDefinition[]>>
    save: (input: SubagentSaveInput) => Promise<Result<SubagentDefinition>>
    remove: (id: string) => Promise<Result<{ id: string }>>
    setEnabled: (input: { id: string; enabled: boolean }) => Promise<Result<SubagentDefinition>>
  }
  provider: {
    list: () => Promise<Result<ProviderView[]>>
    save: (input: { provider: ProviderConfig; apiKey?: string }) => Promise<Result<ProviderView>>
    remove: (providerId: string) => Promise<Result<{ id: string }>>
    verify: (input: { provider: ProviderConfig; apiKey?: string }) => Promise<Result<ProviderVerifyResult>>
  }
  settings: {
    get: () => Promise<Result<SettingsView>>
    set: (patch: Partial<AppSettings>) => Promise<Result<AppSettings>>
  }
  /** 定时任务列表（落盘 `<userData>/scheduled-tasks.json`）。 */
  scheduledTasks: {
    list: () => Promise<Result<ScheduledTask[]>>
    save: (tasks: ScheduledTask[]) => Promise<Result<ScheduledTask[]>>
  }
  /**
   * 工作区文件系统（只读）。
   *
   * 两个安全取向：
   *  1. 所有路径都是**相对工作区根**的，由主进程翻译成绝对路径 —— 渲染层拿不到绝对路径，
   *     也就无法用它去读工作区以外的文件。
   *  2. 传的是 **workspaceId 而不是根路径**：根路径由主进程从自己的存储里查出来，
   *     渲染层无法伪造一个根目录来把读取范围改到别处。
   */
  fs: {
    list: (workspaceId: string, relativePath?: string) => Promise<Result<FsEntry[]>>
    read: (workspaceId: string, relativePath: string) => Promise<Result<FilePreview>>
    /**
     * 保存文件。
     *
     * ⚠️ 这是**用户自己**的写操作，不走审批闸门 —— 闸门约束的是 agent。
     * 但有一层必须有的保护：`expectedRevision` 对不上就拒绝写入
     * （agent 可能刚好改过同一个文件，直接覆盖会静默丢掉它的改动）。
     */
    write: (input: FileWriteInput) => Promise<Result<FileWriteResult>>
    /**
     * 新建文件。父目录必须已存在、目标不能已存在。
     *
     * 和 `write` 一样，这是**用户自己**的操作，不走审批闸门；闸门约束的是 agent。
     */
    create: (input: FileCreateInput) => Promise<Result<FileMutationResult>>
    /** 同目录改名（`newName` 不含路径分隔符）。目标已存在时拒绝，不覆盖。 */
    rename: (input: FileRenameInput) => Promise<Result<FileMutationResult>>
    /** 跨目录移动（名字不变，只换父目录）。 */
    move: (input: FileMoveInput) => Promise<Result<FileMutationResult>>
    /**
     * 删除（移动到系统回收站，**不是**永久删除）。
     *
     * 用回收站而不是 `rm` 是刻意的：编辑器里的误删应该可恢复，
     * 而「永久删除」在 UI 上一次点击就发生，代价不对等。
     */
    remove: (input: FileRemoveInput) => Promise<Result<FileMutationResult>>
    /**
     * 在工作区内按文件名 / 内容搜索（只读）。
     *
     * 主进程优先用 ripgrep；没有 rg 时退化为遍历文件名匹配。
     * 渲染层只传 workspaceId 与 query，不碰 fs。
     */
    search: (input: { workspaceId: string; query: string; maxHits?: number }) => Promise<Result<FsSearchResult>>
  }
  /**
   * Git 只读操作（发现多仓、status、单文件 diff）。
   *
   * 路径均相对工作区根；仓库 cwd 由主进程根据 `repoRelativePath` 解析。
   * Git 缺失或不是仓库时返回 `data.error`，不抛穿 IPC 的异常。
   */
  git: {
    discover: (workspaceId: string) => Promise<Result<GitRepoInfo[]>>
    status: (input: { workspaceId: string; repoRelativePath: string }) => Promise<Result<GitStatusResult>>
    diff: (input: {
      workspaceId: string
      repoRelativePath: string
      filePath: string
      staged?: boolean
    }) => Promise<Result<GitDiffResult>>
  }
  events: {
    onAgent: (cb: (payload: AgentEventNotification) => void) => Unsubscribe
    onSession: (cb: (payload: SessionEvent) => void) => Unsubscribe
    onWorkspace: (cb: (payload: WorkspaceEvent) => void) => Unsubscribe
    onRuntimeStatus: (cb: (payload: RuntimeStatus) => void) => Unsubscribe
    onTerminalData: (cb: (payload: TerminalDataEvent) => void) => Unsubscribe
    onTerminalExit: (cb: (payload: TerminalExitEvent) => void) => Unsubscribe
    /**
     * 主进程想关窗、但编辑器里有未保存的改动：请渲染层问一句。
     *
     * 关窗这件事只有主进程能做（`close` 事件在它那里），而「有没有未保存」
     * 只有渲染层知道 —— 所以是主进程请求、渲染层决定。
     */
    onCloseRequested: (cb: () => void) => Unsubscribe
  }
  /**
   * 插件管理。
   *
   * ⚠️ 插件是**任意代码**，运行在独立子进程里，拥有与应用同级的操作系统权限
   * （没有 OS 级沙箱，上游也没有）。所以：
   *  - 安装后**默认不启用**，「启用」这个动作就是知情同意的落点；
   *  - `permissions` 是声明的能力清单，UI 必须在启用前把它显示出来；
   *  - 子进程**不继承** `process.env`（唯一实质性的运行时保护）。
   */
  plugins: {
    list: () => Promise<Result<PluginView[]>>
    /** 弹出目录选择框，从用户选的目录安装。 */
    install: () => Promise<Result<PluginView | null>>
    remove: (id: string) => Promise<Result<{ id: string }>>
    setEnabled: (id: string, enabled: boolean) => Promise<Result<PluginView>>
    openDir: () => Promise<Result<{ path: string }>>
  }
  /**
   * 控制面（私有化交付的「管理服务」）。
   *
   * 关键性质：**它不在热路径上**。没配控制面时应用功能完整；配了之后，
   * 模型配置与技能从控制面下发。任何一次 prompt 都不依赖控制面在线。
   */
  controlPlane: {
    status: () => Promise<Result<ControlPlaneStatus>>
    login: (input: ControlPlaneLoginInput) => Promise<Result<ControlPlaneStatus>>
    logout: () => Promise<Result<ControlPlaneStatus>>
    /** 拉取模型配置与技能，并把结果落到本地（providers / pi-agent/skills）。 */
    sync: () => Promise<Result<ControlPlaneSyncResult>>
    quota: () => Promise<Result<ControlPlaneQuota>>
    /** 立刻把本地积压的审计事件推上去（正常情况会自动推）。 */
    flushAudit: () => Promise<Result<{ sent: number; pending: number }>>
  }
  /** 选目录对话框。走主进程的 dialog，渲染层拿不到 fs 也就没法自己开。 */
  dialog: {
    pickDirectory: () => Promise<Result<string | null>>
  }
  /**
   * 交互式终端（PTY）。
   *
   * ⚠️ 这是**用户自己的 shell**，不是 agent 的工具 —— agent 的 shell 能力仍走
   * `bash` 工具 + 审批闸门。把交互式 shell 交给 agent 等于开一条绕过逐条审批的通道。
   *
   * `data` / `exit` 是主进程推送的事件（见 `events.onTerminalData/onTerminalExit`），
   * 因为 PTY 的输出是持续的流，没法用「一次 invoke 一次返回」建模。
   */
  terminal: {
    create: (options?: TerminalCreateOptions) => Promise<Result<TerminalSession>>
    write: (id: string, data: string) => Promise<Result<{ id: string }>>
    resize: (id: string, cols: number, rows: number) => Promise<Result<{ id: string }>>
    dispose: (id: string) => Promise<Result<{ id: string }>>
    list: () => Promise<Result<string[]>>
    /**
     * 终端能力是否可用。
     *
     * `node-pty` 是编译型原生模块，在缺少 MSVC Spectre 缓解库的机器上装不上。
     * UI 必须先问这个再决定是否显示终端入口 —— 否则用户会点开一个只报错的空面板。
     */
    probe: () => Promise<Result<{ available: boolean; message?: string }>>
  }
}

// ───────────────────── 主进程 → 渲染层的推送载荷 ─────────────────────

export type SessionEvent =
  | { type: 'created'; session: Session }
  | { type: 'updated'; session: Session }
  | { type: 'deleted'; id: string }
  /**
   * 一条消息已定稿并落库。
   *
   * 为什么单独开一个事件而不是复用 'updated'：'updated' 只带会话元数据，
   * 渲染层拿不到消息内容，就只能「乐观插入」一份自己的副本 —— 于是同一条消息
   * 会存在两份（内存一份、磁盘一份），id 还不一样，后续按 id 更新必然对不上。
   */
  | { type: 'message'; sessionId: string; message: ChatMessage }

export type WorkspaceEvent = { type: 'opened'; workspace: Workspace }

/** 渲染层使用的消息别名，避免各处 import 路径不一致。 */
export type { AgentEvent, AgentEventNotification, ChatMessage }

/**
 * 工作区的「事实」（空状态的起手任务据此生成，见 §15.18）。
 *
 * 计数是**扫到的**而不是声称的：扫描有深度/文件数/读取数三道闸，
 * 被截断时 `truncated` 为 true，界面上的措辞会相应地说「扫到的 N 个文件」。
 */
export interface WorkspaceFacts {
  root: string
  /** 源码文件数（按扩展名统计，跳过 node_modules 等目录）。 */
  sourceFiles: number
  /** 测试文件数（*.test.* / *.spec.* / __tests__）。 */
  testFiles: number
  /** 扫到的 TODO / FIXME 处数。 */
  todoCount: number
  /** 实际走到的文件数（用来说明扫描范围）。 */
  scannedFiles: number
  /** package.json 里的脚本名（最多 12 个）。 */
  scripts: string[]
  /** 顶层目录名（最多 12 个）。 */
  topLevelDirs: string[]
  /** 包管理器（有锁文件才推断得出来）。 */
  packageManager?: 'pnpm' | 'yarn' | 'npm' | 'bun'
  /** 看起来像源码根目录的那个（src / app / lib / packages）。 */
  srcDir?: string
  hasReadme: boolean
  hasGit: boolean
  /**
   * 目录遍历是否被闸门截断（深度 / 文件数）——截断时**计数不完全**。
   */
  truncated: boolean
  /**
   * TODO 统计是否只覆盖了部分文件（读取数量有上限，但**源文件计数仍是完整的**）。
   *
   * 与 `truncated` 分开，是因为它们影响的是不同的话：混在一起会出现
   * 「扫到 143 个源文件（只扫了一部分）」这种把完整的数字说成不完整的措辞 ——
   * 这一条是在安装版上实跑时看出来的。
   */
  todoPartial: boolean
}
