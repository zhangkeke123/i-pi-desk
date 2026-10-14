import { create } from 'zustand'
import type {
  AgentEventNotification,
  AppInfo,
  AppSettings,
  ApprovalDecision,
  ApprovalPart,
  ChatMessage,
  MessagePart,
  ProviderConfig,
  ProviderVerifyResult,
  ProviderView,
  RunStopReason,
  RuntimeStatus,
  Session,
  SettingsView,
  ToolCallPart,
  Workspace
} from '@i-pi-desk/shared'
import { call, getDesk, IpcError } from '../lib/desk.js'
import { applyTheme, resolveTheme } from '../lib/theme.js'
import { pickActiveSession } from '../lib/session-scope.js'
import { pickBootWorkspace, sameWorkspacePath } from '../lib/workspace-pick.js'
import { BOOT_TARGETS } from '../lib/boot-progress.js'

/**
 * 渲染层唯一的状态源。
 *
 * 三块状态刻意分开：
 *  - `messages`：已定稿并落库的消息（来自 'message' 事件）。
 *  - `live`：正在流式生成的那条消息的**未定稿**部分。
 *  - `approvals`：等待用户裁决的审批（会阻塞 agent，必须显眼）。
 *
 * 分开的原因：流式增量每秒可能来几十次，如果直接往 `messages` 里改，
 * 每次都要重建数组并触发整列表重渲染；而定稿消息是不可变的，能被 memo 掉。
 */

interface LiveRun {
  runId: string
  parts: MessagePart[]
}

export interface AppState {
  booted: boolean
  bootError?: string
  /** 闪屏混合进度的阶段目标（1–100），由 Splash 缓动追赶。 */
  bootTarget: number
  info?: AppInfo
  runtime: RuntimeStatus
  settings?: SettingsView
  providers: ProviderView[]
  workspaces: Workspace[]
  currentWorkspace?: Workspace
  sessions: Session[]
  currentSessionId?: string
  messages: ChatMessage[]
  live: LiveRun | null
  /** 最后一次 run 的结束原因，用于展示「已中止 / 达到步数上限」。 */
  lastStopReason?: RunStopReason
  promptError?: string
  /**
   * 上一次「根本没发出去」的输入，供输入框还给用户。
   *
   * 输入框是先清空再发送的（必须如此：一轮 run 可能跑几分钟，不能等它结束才清）。
   * 但发送可能**在落库之前**就失败（没配 provider、缺 key），这时若不清空就丢了，
   * 用户得重新敲一遍 —— 这是最容易让人恼火的那类小摩擦。
   */
  restorableText?: string
  busy: boolean
  /**
   * 编辑器里现在有没有未保存的改动。
   *
   * 放在 store 而不是编辑器组件里，是因为**至少三处**要按它做决定：
   * 编辑器切文件、侧栏切工作区、以及关窗口前的拦截（那一条还要同步给主进程）。
   * 各自持有一份必然会漂移 —— 上一轮「同一件事四个入口三种行为」就是这么来的。
   */
  editorDirty: boolean
  setEditorDirty: (dirty: boolean) => void
  /**
   * 打开工作目录失败时给用户看的东西。
   *
   * 「最近目录」里的路径随时可能被外部删掉或改名（不是边缘情况：临时目录、
   * 清理脚本、移动硬盘）。原来这里没有接住异常 —— `call()` 抛出来之后
   * 谁都没接，于是**点了完全没反应**，连一句提示都没有
   * （同时还留下一次未处理的 rejection）。
   */
  workspaceError?: { path: string; name: string; message: string }
  clearWorkspaceError: () => void
  /** 把一个打不开的目录从最近列表里移掉。 */
  forgetWorkspace: (id: string) => Promise<void>
  /**
   * **每个会话**正在等待裁决的审批（键是 sessionId）。
   *
   * 为什么不能只看当前会话：审批事件原本和别的 agent 事件一样被「只处理当前会话」
   * 那道守卫拦掉了。于是「等审批的时候切到别的会话看一眼、再切回来」会出现一个很坏的
   * 结果 —— 切回来时 `selectSession` 把 `live` 清空，**卡片再也回不来了**：
   * 用户既看不到按钮、也无法批准，那个 run 只能安静地等到 5 分钟超时被判 deny。
   * 界面上没有任何东西告诉他「有个操作在等你」。
   *
   * 所以审批**必须按会话记住**：记下来给侧栏做指示，切回来时据此把卡片重新种回 `live`。
   */
  pendingApprovals: Record<string, { runId: string; part: ApprovalPart }>

  init: () => Promise<void>
  pickWorkspace: () => Promise<void>
  openWorkspace: (path: string) => Promise<void>
  /** 在当前工作区新建会话（内部/发消息兜底）。 */
  newSession: () => Promise<void>
  /** 快捷会话：落在设置里的默认工作空间。 */
  newQuickSession: () => Promise<void>
  /** 正常会话：先引导选择工作空间，再在其中建会话。 */
  newGuidedSession: () => Promise<void>
  /** 在指定项目（工作区）下建普通会话；必要时先切换工作区。 */
  newSessionInWorkspace: (workspaceId: string) => Promise<void>
  selectSession: (id: string) => Promise<void>
  /** 重新读取设置与 provider 列表（控制面同步后必须调用，见实现处的说明）。 */
  reloadConfig: () => Promise<void>
  removeSession: (id: string) => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>
  /** 复制会话（含历史），并切到新会话。 */
  duplicateSession: (id: string) => Promise<void>
  /** 置顶 / 取消置顶（写进会话文件；列表里立刻可见）。 */
  setPinned: (id: string, pinned: boolean) => Promise<void>
  /** 会话色 / runStatus 等轻量字段。 */
  patchSession: (id: string, patch: { color?: string | null; runStatus?: Session['runStatus'] }) => Promise<void>
  /** 项目（工作区）侧栏色点。 */
  setWorkspaceColor: (id: string, color?: string) => Promise<void>
  sendPrompt: (text: string) => Promise<void>
  /** 取走「发送失败但没记下来」的输入（输入框用它把内容还给用户）。 */
  consumeRestorableText: () => void
  abort: () => Promise<void>
  resolveApproval: (approvalId: string, decision: ApprovalDecision) => Promise<void>
  saveProvider: (provider: ProviderConfig, apiKey?: string) => Promise<void>
  verifyProvider: (provider: ProviderConfig, apiKey?: string) => Promise<ProviderVerifyResult>
  removeProvider: (id: string) => Promise<void>
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>
}

/**
 * 待裁决的审批 = 处于 awaiting-approval 的工具调用。
 *
 * ⚠️ 这个 helper **曾经被用错地方**：ChatView 把它套在持久化消息上
 * （`pendingApprovals(messages.flatMap((m) => m.parts))`），用来决定输入框要不要挡住。
 * 而审批 part 从来不落库 —— 那个表达式恒为 false，占位文案里那句
 * 「有操作等待你的确认…」是一次都没出现过的死逻辑。
 *
 * 那一段现在改成看 `pendingApprovals`（按会话记的 map），与卡片同源。
 * 这个 helper 保留下来给「拿到一组 parts 想筛出未裁决的审批」的场景用 ——
 * 但**不要在持久化消息上用它**。
 */
export function pendingApprovals(parts: MessagePart[]): Array<Extract<MessagePart, { kind: 'approval' }>> {
  return parts.filter(
    (part): part is Extract<MessagePart, { kind: 'approval' }> =>
      part.kind === 'approval' && !part.decision
  )
}

function errorMessage(error: unknown): string {
  if (error instanceof IpcError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

/** init() 挂上的订阅；重复 init 时先退掉旧的（原因见 init 里的说明）。 */
let unsubscribeAll: (() => void) | undefined

export const useAppStore = create<AppState>((set, get) => ({
  booted: false,
  bootTarget: BOOT_TARGETS.start,
  runtime: { state: 'starting', restarts: 0 },
  providers: [],
  workspaces: [],
  sessions: [],
  messages: [],
  live: null,
  busy: false,
  editorDirty: false,
  pendingApprovals: {},

  setEditorDirty(dirty) {
    if (get().editorDirty === dirty) return
    set({ editorDirty: dirty })
  },

  async init() {
    const desk = getDesk()

    /**
     * 订阅只挂一次。
     *
     * `init()` 由 `App` 的 effect 调用，而开发模式下 `<StrictMode>` 会把 effect
     * **跑两次** —— 没有退订就会挂上两套监听，于是**每条消息被追加两次**、
     * 界面上一模一样的回复出现两遍。打包版不会双调用，所以这类重复只在开发时
     * 出现（磁盘上的会话文件是干净的，重复纯粹在渲染层）——
     * 它的坏处是让人花时间去查一个「生产不存在」的现象。
     *
     * 这里显式退掉上一轮订阅：既解决 StrictMode，也覆盖将来任何「重新 init」的路径。
     */
    unsubscribeAll?.()
    const disposers: Array<() => void> = []

    // 事件订阅必须在任何请求之前挂好：sidecar 启动很快，
    // 晚挂一秒就可能漏掉首帧的状态推送。
    disposers.push(desk.events.onRuntimeStatus((status) => set({ runtime: status })))
    disposers.push(
      desk.events.onSession((event) => {
      const state = get()
      if (event.type === 'created') {
        /**
         * **按 id 去重**，因为同一个会话有两条路径会进来：
         * 主进程广播这条 `created`，而 `newSession()` 拿到返回值后也会插入一次
         * （保留它是有意的：万一批广播早于渲染层订阅而丢掉，列表仍是对的）。
         *
         * 两条路径改同一份列表、先后顺序却没有保证 —— 一旦广播晚于返回值到达，
         * 侧栏里就会出现两个同一个会话（React 还会因为 key 重复而告警）。
         * 去重之后无论谁先到都只有一份。
         *
         * 这和 §5.5 那个「消息被落库两次」是同一类问题：
         * **同一件事有两个写入方时，必须让结果与顺序无关。**
         */
        set({ sessions: [event.session, ...state.sessions.filter((s) => s.id !== event.session.id)] })
      } else if (event.type === 'updated') {
        set({ sessions: state.sessions.map((s) => (s.id === event.session.id ? event.session : s)) })
      } else if (event.type === 'deleted') {
        set({ sessions: state.sessions.filter((s) => s.id !== event.id) })
      } else if (event.type === 'message') {
        // 只接受当前会话的消息：后台会话（未来支持并行 run）的消息不该串到前台。
        if (event.sessionId !== state.currentSessionId) return
        /**
         * **落库的会话是消息的唯一真相**：它由主进程在定稿时广播，一条消息只广播一次。
         *
         * 早先这里和 agent 的 `message.committed` 事件**两条通道都往同一个数组里追加**，
         * 于是每条消息都被渲染两遍（用户消息更是三遍：主进程落库时一次、
         * 内核回显时又一次）。现在追加只在这里发生。
         */
        set({
          messages: [...state.messages, event.message],
          // 与「追加定稿消息」同一个 set：助手消息进入列表的同时结束流式态。
          // 分成两个通道做会出现「streaming 已清空、定稿消息还没到」的一帧闪烁。
          live: event.message.role === 'assistant' ? null : state.live
        })
      }
      })
    )
    disposers.push(desk.events.onAgent((payload) => applyAgentEvent(payload, set, get)))
    unsubscribeAll = () => {
      for (const dispose of disposers) dispose()
      unsubscribeAll = undefined
    }

    try {
      set({ bootTarget: BOOT_TARGETS.fetching, bootError: undefined })

      const [info, settings, providers, workspaces, sessions] = await Promise.all([
        call(desk.app.info()),
        call(desk.settings.get()),
        call(desk.provider.list()),
        call(desk.workspace.list()),
        call(desk.session.list())
      ])

      set({ bootTarget: BOOT_TARGETS.hydrated })

      // 主动拉一次内核状态：`onRuntimeStatus` 只在**变化**时推送，
      // 而渲染层有可能在 sidecar 已经就绪之后才挂载（刷新页面、或启动很快）——
      // 那样徽标会永远停在「启动中」。推送负责后续变化，这一次负责初始真值。
      void call(desk.agent.status())
        .then((status) => set({ runtime: status }))
        .catch(() => undefined)

      /**
       * 自动选中的会话**必须是当前工作区的**。
       *
       * 原来取的是 `sessions[0]`（全局最近更新的那个）—— 它可能属于另一个目录，
       * 于是启动后就出现错位：标题与文件树是 A，聊天区与随后发出的请求却是 B 的会话，
       * 而 agent 是在 B 里干活的（见 `lib/session-scope.ts` 的说明）。
       */
      const currentWorkspace = pickBootWorkspace(workspaces, settings.defaultWorkspacePath)
      const activeSession = pickActiveSession(sessions, currentWorkspace?.id)
      set({
        booted: true,
        bootTarget: BOOT_TARGETS.ready,
        info,
        settings,
        providers,
        workspaces,
        sessions,
        currentWorkspace,
        // 有历史工作区就直接恢复上次的会话列表并选中最近一个，
        // 不要每次都让用户从「选择目录」开始。
        currentSessionId: activeSession?.id
      })

      applyTheme(resolveTheme(settings.theme))

      /**
       * 安装预置了默认工作空间、但最近列表里还没有时，启动时打开一次。
       * openWorkspace 会刷新 workspaces / 会话选中。
       */
      const defaultPath = settings.defaultWorkspacePath?.trim()
      if (defaultPath && !currentWorkspace) {
        await get().openWorkspace(defaultPath)
      } else if (activeSession) {
        await get().selectSession(activeSession.id)
      }
    } catch (error) {
      set({ booted: false, bootError: errorMessage(error), bootTarget: BOOT_TARGETS.start })
    }
  },

  async pickWorkspace() {
    const path = await call(getDesk().dialog.pickDirectory())
    if (!path) return
    await get().openWorkspace(path)
  },

  async openWorkspace(path) {
    const desk = getDesk()
    /**
     * 打不开就**说清楚**，而不是让异常沉下去。
     *
     * 目录不存在时主进程抛 `WORKSPACE_NOT_FOUND`；这里接住、放进 `workspaceError`
     * 让侧栏显示，并清掉上一次的旧错误（否则一次失败会一直挂在那里）。
     *
     * 当前工作区保持不变 —— **打不开就当作没点过**，这是最不容易让人误会的处理。
     */
    const previous = get().currentWorkspace
    try {
      const workspace = await call(desk.workspace.open(path))
      const workspaces = await call(desk.workspace.list())
      set({ workspaceError: undefined })
      /**
       * 换目录必须**同时重新挑会话**，否则会留下一个会把活干错地方的错位。
       *
       * 原来这里只换 `currentWorkspace`，`currentSessionId` 还指着上一个目录的会话 ——
       * 于是切到 B 之后，聊天区显示 A 的对话，用户输入一句，`sendPrompt` 用的仍是 A 的会话，
       * **agent 在 A 里干活而界面显示 B**。侧栏那时还会把 A 的会话列为可点，
       * 点一下就是同一个错位（现在侧栏也按目录过滤了）。
       *
       * 新目录里有会话就选中最近一个；没有就把选中状态**清空** ——
       * 清空之后 `sendPrompt` 会自动为**当前**目录建一个新会话（`newSession` 用的是
       * `currentWorkspace`），这正是我们想要的行为。
       */
      const activeSession = pickActiveSession(get().sessions, workspace.id)
      set({
        workspaces,
        currentWorkspace: workspace,
        currentSessionId: activeSession?.id,
        messages: [],
        live: null,
        promptError: undefined,
        lastStopReason: undefined
      })
      if (activeSession) await get().selectSession(activeSession.id)
    } catch (error) {
      set({
        // 沿用当前工作区：打不开就当作没点过。
        currentWorkspace: previous,
        workspaceError: {
          path,
          name: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
          message: errorMessage(error)
        }
      })
    }
  },

  clearWorkspaceError() {
    if (get().workspaceError) set({ workspaceError: undefined })
  },

  async forgetWorkspace(id) {
    try {
      await call(getDesk().workspace.remove(id))
      const wasCurrent = get().currentWorkspace?.id === id
      // 以主进程可见列表为准（隐藏后 list 不再含该 id），避免只滤本地态漂移。
      const remaining = await call(getDesk().workspace.list())
      set({
        workspaces: remaining,
        workspaceError: undefined,
        ...(wasCurrent
          ? {
              currentWorkspace: undefined,
              currentSessionId: undefined,
              messages: [],
              live: null,
              promptError: undefined
            }
          : {})
      })
      // 删的是当前项目时切到其它最近目录，避免 cwd 悬空。
      if (wasCurrent) {
        const next = remaining[0]
        if (next?.path) await get().openWorkspace(next.path)
      }
    } catch (error) {
      set({ workspaceError: { path: '', name: '', message: errorMessage(error) } })
    }
  },

  async newSession() {
    const workspace = get().currentWorkspace
    if (!workspace) {
      set({ promptError: '请先选择一个工作目录' })
      return
    }
    const desk = getDesk()
    /**
     * 刻意**不传 providerId / modelId**。
     *
     * 早先的写法是把当前的 `defaultProviderId` / `defaultModelId` 快照进新会话，
     * 结果是一个很难查的 bug：控制面同步会在主进程侧改掉默认 provider，
     * 而渲染层缓存的那份还是旧值 —— 于是**同步之后新建的会话被钉在旧 provider 上**，
     * 表现为「新会话发不出请求」，而设置界面显示的却是新下发的模型。
     *
     * 不传之后，`resolveRunContext` 会回落到主进程侧的当前默认值 —— 那才是权威，
     * 而且永远是最新的。等将来支持「为某个会话单独指定模型」时，再按需显式传入，
     * 那时它表达的是**用户的明确选择**，而不是一份会过期的快照。
     */
    const session = await call(desk.session.create({ workspaceId: workspace.id }))
    set({
      sessions: [session, ...get().sessions.filter((s) => s.id !== session.id)],
      currentSessionId: session.id,
      messages: [],
      live: null,
      promptError: undefined
    })
  },

  async newQuickSession() {
    const preferred = get().settings?.defaultWorkspacePath?.trim()
    if (!preferred) {
      set({ promptError: '尚未配置默认工作空间，请到设置 → 通用里指定，或改用「新会话」手动选择' })
      return
    }
    const current = get().currentWorkspace
    const already = current ? sameWorkspacePath(current.path, preferred) : false
    if (!already) {
      await get().openWorkspace(preferred)
      if (!get().currentWorkspace) {
        set({
          promptError: get().workspaceError?.message ?? `打不开默认工作空间：${preferred}`
        })
        return
      }
    }
    await get().newSession()
  },

  async newGuidedSession() {
    const path = await call(getDesk().dialog.pickDirectory())
    if (!path) return
    await get().openWorkspace(path)
    if (!get().currentWorkspace) {
      set({
        promptError: get().workspaceError?.message ?? '未能打开所选工作空间'
      })
      return
    }
    await get().newSession()
  },

  async newSessionInWorkspace(workspaceId) {
    const target = get().workspaces.find((workspace) => workspace.id === workspaceId)
    if (!target?.path) {
      set({ promptError: '找不到这个项目，请先打开或登记本地目录' })
      return
    }
    const current = get().currentWorkspace
    if (!current || current.id !== workspaceId) {
      await get().openWorkspace(target.path)
      const opened = get().currentWorkspace
      if (!opened || opened.id !== workspaceId) {
        set({
          promptError: get().workspaceError?.message ?? `打不开项目「${target.name}」`
        })
        return
      }
    }
    await get().newSession()
  },

  /**
   * 重新读取设置与 provider 列表。
   *
   * ## 为什么必须有这个动作
   *
   * 控制面同步会在**主进程侧**改掉 `defaultProviderId` 与 provider 列表，
   * 但渲染层缓存的 `settings` / `providers` 不会自动更新。
   *
   * 后果很具体：`newSession()` 会带上 `settings.defaultProviderId`，
   * 于是**同步之后新建的会话会被钉在旧 provider 上** —— 用户看到的是
   * 「新会话发不出请求」，而设置界面里显示的却是新下发的那个模型。
   *
   * 之前这个问题一直没被发现，是因为验证只查了主进程侧的真相
   * （`agent.inspect` 报的 model 是对的），没查渲染层那份副本。
   */
  async reloadConfig() {
    const desk = getDesk()
    const [settings, providers] = await Promise.all([call(desk.settings.get()), call(desk.provider.list())])
    set({ settings, providers })
  },

  async selectSession(id) {
    const desk = getDesk()
    const snapshot = await call(desk.session.load(id))
    /**
     * 侧栏跨项目：点别的项目的会话时先切工作区，再打开**指定**会话。
     * 不能走 `openWorkspace`（它会自动挑该目录最近会话，把用户点的那条抢走）。
     */
    const current = get().currentWorkspace
    if (current && snapshot.session.workspaceId !== current.id) {
      const target = get().workspaces.find((w) => w.id === snapshot.session.workspaceId)
      if (!target?.path) {
        set({
          promptError: `这个会话属于另一个工作目录，但找不到对应路径（${snapshot.session.workspaceId}）`
        })
        return
      }
      try {
        const workspace = await call(desk.workspace.open(target.path))
        const workspaces = await call(desk.workspace.list())
        const sessions = await call(desk.session.list())
        set({
          workspaces,
          sessions,
          currentWorkspace: workspace,
          workspaceError: undefined
        })
      } catch (error) {
        set({
          promptError: errorMessage(error),
          workspaceError: {
            path: target.path,
            name: target.name,
            message: errorMessage(error)
          }
        })
        return
      }
    }
    /**
     * 切回来时把**还在等待裁决**的审批重新种回 `live`。
     *
     * 用事件里那个**真实的 runId**（不是编一个）：后续事件（工具执行、收尾正文）
     * 都带同一个 runId，`upsertPart` 保留 `current.runId`，所以它们会合并进这张卡片所在的
     * 那个 live 里，界面能顺着演下去。
     */
    const pending = get().pendingApprovals[id]
    set({
      currentSessionId: id,
      messages: snapshot.messages,
      live: pending ? { runId: pending.runId, parts: [pending.part] } : null,
      promptError: undefined,
      lastStopReason: undefined
    })
  },

  /**
   * 置顶 / 取消置顶。
   *
   * 只改 pinned 本身，**不动 updatedAt 之外的任何排序依据**：列表按 updatedAt 倒序，
   * 置顶靠的是单独一个分组（lib/session-groups.ts 的 splitPinned）——
   * 这一点有单测钉着，避免下次有人「顺手」把置顶实现成改时间。
   */
  async setPinned(id, pinned) {
    const updated = await call(getDesk().session.setPinned({ id, pinned }))
    set((state) => ({ sessions: state.sessions.map((s) => (s.id === id ? updated : s)) }))
  },

  async patchSession(id, patch) {
    const updated = await call(getDesk().session.patch({ id, ...patch }))
    set((state) => ({ sessions: state.sessions.map((s) => (s.id === id ? updated : s)) }))
  },

  async setWorkspaceColor(id, color) {
    const updated = await call(getDesk().workspace.setColor({ id, color }))
    set((state) => ({
      workspaces: state.workspaces.map((w) => (w.id === id ? updated : w)),
      currentWorkspace: state.currentWorkspace?.id === id ? updated : state.currentWorkspace
    }))
  },

  async removeSession(id) {
    await call(getDesk().session.remove(id))
    const remaining = get().sessions.filter((s) => s.id !== id)
    // 会话都没了，它上面等待裁决的审批也就不该再挂指示（否则侧栏会指向一个不存在的会话）。
    const pending = { ...get().pendingApprovals }
    delete pending[id]
    set({ sessions: remaining, pendingApprovals: pending })
    if (get().currentSessionId === id) {
      set({ currentSessionId: undefined, messages: [], live: null })
      // 下一个会话也要**在本工作区里**挑，否则删完一个会话就会跳到别的目录的会话上。
      const next = pickActiveSession(remaining, get().currentWorkspace?.id)
      if (next) await get().selectSession(next.id)
    }
  },

  /**
   * 重命名会话。
   *
   * 标题只用于人找会话，不参与任何逻辑（内核那边的会话标识是 id），
   * 所以这里不做唯一性校验 —— 两个会话同名是合理的（比如同名任务的两个分支）。
   *
   * 空标题**直接不提交**而不是回退成「新会话」：用户清空输入框多半是想重打，
   * 或者干脆放弃了这次重命名。把空字符串变成一个看起来像自动命名的标题，
   * 会让人以为自己的操作生效了。
   */
  async renameSession(id, title) {
    const trimmed = title.trim()
    if (trimmed.length === 0) return
    const updated = await call(getDesk().session.rename({ id, title: trimmed }))
    // 主进程同时会广播一条 `updated` 事件（`onSession` 也会更新列表）。
    // 这里仍然显式 set 一次，是为了**让 `await` 返回后状态立刻一致**：
    // 广播是异步到达的，只依赖它会让「改完名马上读列表」拿到旧值。
    set({ sessions: get().sessions.map((s) => (s.id === id ? updated : s)) })
  },

  async duplicateSession(id) {
    const session = await call(getDesk().session.duplicate(id))
    set({
      sessions: [session, ...get().sessions.filter((s) => s.id !== session.id)],
      promptError: undefined
    })
    await get().selectSession(session.id)
  },

  async sendPrompt(text) {
    const sessionId = get().currentSessionId
    if (!sessionId) {
      // 没会话就自动建一个：让用户「直接开始打字」而不是先学会点「新建会话」。
      await get().newSession()
    }
    const activeId = get().currentSessionId
    if (!activeId) return

    const desk = getDesk()
    set((state) => ({
      busy: true,
      promptError: undefined,
      lastStopReason: undefined,
      live: null,
      sessions: state.sessions.map((s) => (s.id === activeId ? { ...s, runStatus: 'running' as const } : s))
    }))
    void call(desk.session.patch({ id: activeId, runStatus: 'running' })).then(
      (updated) => {
        set((state) => ({ sessions: state.sessions.map((s) => (s.id === activeId ? updated : s)) }))
      },
      () => undefined
    )

    try {
      const result = await call(
        /**
         * 刻意**不传 providerId / modelId**。
         *
         * 早先这里传的是渲染层缓存的 `settings.defaultProviderId` —— 那是一份会过期的快照：
         * 控制面同步在主进程侧改掉默认 provider 之后，**每一次从输入框发出的请求
         * 都仍然打到旧 provider 上**（表现为「同步完了却发不出请求」，
         * 而设置界面显示的却是新下发的模型）。
         *
         * 不传之后由主进程按 `会话 → 当前默认` 的顺序解析，那才是权威且总是最新的。
         * 将来支持「为某个会话指定模型」时，这里传的应当是**用户在该会话上的明确选择**，
         * 而不是默认值的副本。
         */
        desk.agent.prompt({ sessionId: activeId, text })
      )
      set({ lastStopReason: result.stopReason, restorableText: undefined })
    } catch (error) {
      /**
       * 发送失败时判断「这条消息到底有没有被记下来」——
       * 依据是**会话里有没有它**，而不是某个错误码清单。
       *
       * 这个区分很实际：主进程在调用内核**之前**就落库并广播用户消息，
       * 但「没配 provider / 缺 key / provider 被删」这类校验发生在落库**之前**。于是：
       *  - 校验失败 → 会话里没有这条消息 → 内容还给用户（否则刚敲的一大段就没了）；
       *  - 内核或网络失败 → 会话里已经有这条消息 → **不能**还原，否则会和历史重复。
       *
       * 只看最后一条消息即可：发送时它一定追加在末尾。
       */
      const last = get().messages[get().messages.length - 1]
      const recorded =
        last?.role === 'user' &&
        last.parts.some((part) => part.kind === 'text' && part.text.trim() === text.trim())
      // 错误码决定 UI 的引导方式（例如提示去配置模型）。
      set({ promptError: errorMessage(error), restorableText: recorded ? undefined : text })
    } finally {
      set({ busy: false, live: null })
    }
  },

  consumeRestorableText() {
    set({ restorableText: undefined })
  },

  async abort() {
    const sessionId = get().currentSessionId
    if (!sessionId) return
    await call(getDesk().agent.abort(sessionId))
  },

  async resolveApproval(approvalId, decision) {
    const sessionId = get().currentSessionId
    if (!sessionId) return
    await call(getDesk().agent.resolveApproval({ sessionId, approvalId, decision }))
    // 本地先标记，避免用户点了按钮后卡片还挂着直到下一帧事件到达。
    set({
      live: markApprovalDecision(get().live, approvalId, decision),
      messages: get().messages.map((message) => ({
        ...message,
        parts: markApprovalDecisionInParts(message.parts, approvalId, decision)
      }))
    })
  },

  async saveProvider(provider, apiKey) {
    const saved = await call(getDesk().provider.save({ provider, apiKey }))
    const providers = get().providers.some((p) => p.id === saved.id)
      ? get().providers.map((p) => (p.id === saved.id ? saved : p))
      : [...get().providers, saved]

    // 第一个 provider 自动设为默认，省掉一次「配完了还得去选」的操作。
    const settings = get().settings
    const patch: Partial<AppSettings> = {}
    if (!settings?.defaultProviderId) {
      patch.defaultProviderId = saved.id
      patch.defaultModelId = saved.models[0]?.id
    }
    set({ providers })
    if (Object.keys(patch).length > 0) await get().updateSettings(patch)
  },

  async verifyProvider(provider, apiKey) {
    // 返回值直接交给调用方（设置面板）展示，不进全局状态：
    // 「测试连接」的结果是一次性的，塞进 store 反而要额外管理它的生命周期。
    return call(getDesk().provider.verify({ provider, apiKey }))
  },

  async removeProvider(id) {
    await call(getDesk().provider.remove(id))
    set({ providers: get().providers.filter((p) => p.id !== id) })
  },

  async updateSettings(patch) {
    const updated = await call(getDesk().settings.set(patch))
    const settings = get().settings
    set({ settings: settings ? { ...settings, ...updated } : { ...updated, secretStorageAvailable: true } })
    if (patch.theme) {
      applyTheme(resolveTheme(patch.theme))
    }
  }
}))


type SetState = (partial: Partial<AppState>) => void
type GetState = () => AppState


/**
 * 把工具状态同步到**已经定稿**的消息里。
 *
 * 为什么需要它：助手消息在工具**还没跑完**时就已经落库并广播了（写文件要先问授权，
 * 那一刻状态是 `pending`/`awaiting-approval`）。此后状态继续前进，但渲染层持有的那份
 * 定稿消息不会自己更新 —— 而流式气泡（`live`）在消息定稿时就被清空了。
 * 结果：工具早就跑完了，界面上那张工具卡**永远停在「等待中」**。
 *
 * 这不是渲染层的渲染问题，是「同一件事存在两份、只有一份在更新」——
 * 所以修法是让两份一起更新，而不是在渲染时去猜。
 *
 * 没命中任何消息时**返回原数组**（同一个引用），避免无谓的重渲染。
 */
function patchCommittedTool(
  messages: ChatMessage[],
  callId: string,
  patch: Partial<ToolCallPart>
): ChatMessage[] {
  let touched = false
  const next = messages.map((message) => {
    const index = message.parts.findIndex((part) => part.kind === 'tool-call' && part.callId === callId)
    if (index === -1) return message
    touched = true
    const parts = [...message.parts]
    parts[index] = { ...(parts[index] as ToolCallPart), ...patch }
    return { ...message, parts }
  })
  return touched ? next : messages
}

/** 把 sidecar 事件落到状态上。这是渲染层理解 agent 的唯一入口。 */
function applyAgentEvent(payload: AgentEventNotification, set: SetState, get: GetState): void {
  const event = payload.event

  /**
   * ⚠️ 审批事件要在「只处理当前会话」那道守卫**之前**处理。
   *
   * 它在别的会话里发生时也不能丢：用户可能在等审批时切走（去看另一个会话），
   * 而 run 还在那边等着 —— 丢掉事件就意味着**再也无法批准**，只能干等 5 分钟超时。
   * 所以这里按 sessionId 记下来（见 `pendingApprovals` 的说明）。
   */
  if (event.type === 'approval.requested') {
    set({
      pendingApprovals: {
        ...get().pendingApprovals,
        [payload.sessionId]: {
          runId: event.runId,
          part: {
            kind: 'approval',
            approvalId: event.approvalId,
            callId: event.callId,
            toolName: event.toolName,
            args: event.args,
            danger: event.danger,
            previewDiff: event.previewDiff
          }
        }
      }
    })
  }

  // 这一轮结束了（成功或失败），它的审批不可能还有效 —— 清掉指示，否则会一直挂着。
  if (event.type === 'run.finished' || event.type === 'run.failed') {
    const next = { ...get().pendingApprovals }
    delete next[payload.sessionId]
    set({ pendingApprovals: next })
  }

  // 侧栏状态图标：任意会话的 run 起止都写回列表（不限当前会话）。
  if (event.type === 'run.started' || event.type === 'run.finished' || event.type === 'run.failed') {
    const runStatus =
      event.type === 'run.started' ? 'running' : event.type === 'run.finished' ? 'done' : 'error'
    const sid = payload.sessionId
    set({
      sessions: get().sessions.map((s) => (s.id === sid ? { ...s, runStatus } : s))
    })
    void call(getDesk().session.patch({ id: sid, runStatus })).then(
      (updated) => {
        set({ sessions: get().sessions.map((s) => (s.id === sid ? updated : s)) })
      },
      () => undefined
    )
  }

  // 只处理当前会话。多会话并行时后台事件不应污染前台视图。
  if (payload.sessionId !== get().currentSessionId) return

  switch (event.type) {
    case 'run.started':
      set({ live: { runId: event.runId, parts: [] } })
      return

    case 'text.delta':
      set({ live: appendText(get().live, event.runId, 'text', event.text) })
      return

    case 'reasoning.delta':
      set({ live: appendText(get().live, event.runId, 'reasoning', event.text) })
      return

    case 'tool.started':
      set({
        live: upsertPart(get().live, event.runId, {
          kind: 'tool-call',
          callId: event.callId,
          name: event.name,
          args: event.args,
          state: 'running',
          startedAt: new Date().toISOString()
        }),
        // 已定稿的那条消息里也有一份同样的工具卡，状态要一起往前走（见 patchCommittedTool）。
        messages: patchCommittedTool(get().messages, event.callId, {
          state: 'running',
          startedAt: new Date().toISOString()
        })
      })
      return

    case 'tool.finished':
      set({
        live: patchToolCall(get().live, event.callId, {
          state: event.ok ? 'succeeded' : 'failed',
          result: event.result,
          error: event.error,
          finishedAt: new Date().toISOString()
        }),
        messages: patchCommittedTool(get().messages, event.callId, {
          state: event.ok ? 'succeeded' : 'failed',
          result: event.result,
          error: event.error,
          finishedAt: new Date().toISOString()
        })
      })
      return

    case 'approval.requested':
      set({
        messages: patchCommittedTool(get().messages, event.callId, { state: 'awaiting-approval' }),
        live: upsertPart(
          patchToolCall(get().live, event.callId, { state: 'awaiting-approval' }),
          get().live?.runId ?? event.runId,
          {
            kind: 'approval',
            approvalId: event.approvalId,
            callId: event.callId,
            toolName: event.toolName,
            args: event.args,
            danger: event.danger,
            previewDiff: event.previewDiff
          }
        )
      })
      return

    case 'message.committed':
      /**
       * **这里不再往 `messages` 里追加。**
       *
       * 定稿消息会由主进程落库并广播一条会话 `message` 事件，
       * 那才是把它加进列表的地方（见 `onSession` 的处理）。
       *
       * 两条通道都追加的后果是每条消息渲染两遍 —— 而且它们到达的先后没有保证，
       * 所以「哪个通道负责」必须只有一个答案。这里保留的是**落库的那条**：
       * 它同时覆盖「别的路径写入的消息」，也天然去重（一条消息只广播一次）。
       */
      return

    case 'run.finished':
      set({ live: null, lastStopReason: event.stopReason })
      return

    case 'run.failed':
      set({
        live: null,
        promptError: event.error.message,
        messages: [
          ...get().messages,
          {
            id: `error-${event.runId}`,
            role: 'assistant',
            createdAt: new Date().toISOString(),
            parts: [{ kind: 'error', message: event.error.message }]
          }
        ]
      })
      return

    case 'usage':
      // 用量已经随 message.committed 一起带出，这里只做兜底：没有 live 就忽略。
      return

    default:
      return
  }
}

function appendText(live: LiveRun | null, runId: string, kind: 'text' | 'reasoning', text: string): LiveRun {
  const current = live ?? { runId, parts: [] }
  const parts = [...current.parts]
  const last = parts[parts.length - 1]

  // 同类型的增量接到上一段后面，而不是每来一个字就 push 一个新 part ——
  // 否则一次回复会产生上千个 part，React 列表直接卡死。
  if (last && last.kind === kind) {
    parts[parts.length - 1] = { kind, text: last.text + text }
  } else {
    parts.push({ kind, text })
  }
  return { runId: current.runId, parts }
}

function upsertPart(live: LiveRun | null, runId: string, part: MessagePart): LiveRun {
  const current = live ?? { runId, parts: [] }
  const index = part.kind === 'tool-call' || part.kind === 'approval'
    ? current.parts.findIndex(
        (candidate) =>
          (candidate.kind === 'tool-call' || candidate.kind === 'approval') &&
          'callId' in candidate &&
          candidate.callId === part.callId
      )
    : -1

  const parts = [...current.parts]
  if (index === -1) parts.push(part)
  else parts[index] = part
  return { runId: current.runId, parts }
}

function patchToolCall(live: LiveRun | null, callId: string, patch: Partial<ToolCallPart>): LiveRun | null {
  if (!live) return live
  return {
    runId: live.runId,
    parts: live.parts.map((part) =>
      part.kind === 'tool-call' && part.callId === callId ? { ...part, ...patch } : part
    )
  }
}

function markApprovalDecision(
  live: LiveRun | null,
  approvalId: string,
  decision: ApprovalDecision
): LiveRun | null {
  if (!live) return live
  return { runId: live.runId, parts: markApprovalDecisionInParts(live.parts, approvalId, decision) }
}

function markApprovalDecisionInParts(
  parts: MessagePart[],
  approvalId: string,
  decision: ApprovalDecision
): MessagePart[] {
  return parts.map((part) =>
    part.kind === 'approval' && part.approvalId === approvalId
      ? { ...part, decision, decidedAt: new Date().toISOString() }
      : part
  )
}
