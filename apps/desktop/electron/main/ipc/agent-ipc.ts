import { randomUUID } from 'node:crypto'
import {
  IPC,
  type AgentEventNotification,
  type AppSettings,
  type ChatMessage,
  type ProviderConfig,
  type PromptRequest,
  type RunStopReason,
  type RuntimeStatus,
  type SessionInspectResult
} from '@i-pi-desk/shared'
import { appendMessage, loadSession, patchToolCallInSession } from '../store/sessions.js'
import { getWorkspace } from '../store/workspaces.js'
import { getProvider, getSettings } from '../store/settings.js'
import { getSecret } from '../store/secrets.js'
import { resolveRunApiKey } from '../store/provider-key.js'
import { piAgentDir } from '../store/pi-config.js'
import { enabledPlugins } from '../store/plugins.js'
import { flushAudit, recordAuditEvent } from '../store/control-plane.js'
import type { AppContext } from '../context.js'
import { arg, handle, requireString } from './wrap.js'

/**
 * agent 域的 IPC：prompt / abort / 审批裁决，以及 sidecar 事件向渲染层的转发。
 *
 * 这里是「主进程作为编排层」最实质的一段代码：
 * 它把「会话 + 工作区 + provider + 密钥 + 设置」拼成一次 run 的完整输入，
 * 然后交给 sidecar。sidecar 自己不读配置，因此不存在两处状态源。
 */

interface RunSelection {
  providerId?: string
  modelId?: string
}

interface RunContext {
  sessionId: string
  cwd: string
  provider: ProviderConfig
  apiKey?: string
  /** 是否用了「不需要鉴权的内网端点」占位 key（用于记一条可排查的日志）。 */
  usedPlaceholderKey: boolean
  modelId: string
  settings: AppSettings
}

export function registerAgentIpc(ctx: AppContext): void {
  wireAgentEvents(ctx)

  handle<{ stopReason: RunStopReason }>(IPC.invoke.agentPrompt, async (_event, ...args) => {
    const input = arg<PromptRequest & { sessionId: string; text: string }>(args, 0)
    const sessionId = requireString(input?.sessionId, 'sessionId')
    const text = requireString(input?.text, 'text')

    const run = resolveRunContext(sessionId, input)
    if (run.usedPlaceholderKey) {
      ctx.log(`[agent] provider「${run.provider.label}」按「不需要鉴权的内网端点」处理，使用占位 key`)
    }

    /**
     * 带上已落盘的历史，让内核在冷启动时恢复上下文。
     *
     * 每次 prompt 都带（而不是「只带第一次」）：主进程并不知道 sidecar 内部是否已经
     * 有该会话的内核状态 —— sidecar 崩溃重启后，主进程的「已经发过」标记就会失真，
     * 结果就是又一次失忆。**让 sidecar 决定什么时候用**（它只在新建内核会话时采用）
     * 比让主进程猜更可靠。
     *
     * 代价是每轮多传一份历史。它有上限（见 history.ts），且一轮只发一次 RPC，
     * 所以这个开销可以接受；换来的是不必维护一份会失真的跨进程状态。
     */
    const snapshot = loadSession(sessionId)
    // loadSession 在会话文件缺失时返回 null（例如刚被删）。这时没有历史可恢复，
    // 也不该因此让本轮失败 —— 让 agent 从空白上下文开始即可。
    const history = snapshot && snapshot.messages.length > 0 ? snapshot.messages : undefined

    // 先把用户消息落库并广播，UI 才能在自己的输入之后立刻看到它，
    // 而不是等 sidecar 的第一帧事件回来才显示。
    const userMessage: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      createdAt: new Date().toISOString(),
      parts: [{ kind: 'text', text }]
    }
    persistAndAnnounce(ctx, sessionId, userMessage)

    const result = await ctx.supervisor.request<{ stopReason: RunStopReason }>('session.prompt', {
      sessionId,
      text,
      provider: run.provider,
      apiKey: run.apiKey,
      modelId: run.modelId,
      permissionMode: run.settings.permissionMode,
      // 思考强度也随每次调用传（而不是让 sidecar 自己读设置：两处状态源一定会分叉）。
      thinkingLevel: run.settings.thinkingLevel,
      cwd: run.cwd,
      agentDir: piAgentDir(),
      // 只传 id 与目录：sidecar 会自己读盘并**重新校验** manifest（见 agent-protocol 里的说明）。
      plugins: enabledPlugins(),
      // 只落盘历史，让内核恢复上下文（见上文说明）。
      history,
      maxSteps: run.settings.maxSteps
    })

    return result ?? { stopReason: 'end_turn' as RunStopReason }
  })

  handle<{ aborted: true }>(IPC.invoke.agentAbort, async (_event, ...args) => {
    const sessionId = requireString(args[0], 'sessionId')
    await ctx.supervisor.request('session.abort', { sessionId })
    return { aborted: true }
  })

  handle<{ resolved: true }>(IPC.invoke.agentResolveApproval, async (_event, ...args) => {
    const input = arg<{ sessionId: string; approvalId: string; decision: string }>(args, 0)
    const sessionId = requireString(input?.sessionId, 'sessionId')
    const approvalId = requireString(input?.approvalId, 'approvalId')
    const decision = requireString(input?.decision, 'decision')

    if (!['allow-once', 'allow-always', 'deny'].includes(decision)) {
      throw Object.assign(new Error(`未知的审批裁决: ${decision}`), { code: 'BAD_REQUEST' })
    }

    await ctx.supervisor.request('approval.resolve', {
      sessionId,
      approvalId,
      decision: decision as 'allow-once' | 'allow-always' | 'deny'
    })

    const toolName = approvalTools.get(approvalId)
    approvalTools.delete(approvalId)
    recordAuditEvent({
      type: decision === 'deny' ? 'tool.denied' : 'tool.approved',
      sessionId,
      ...(toolName ? { toolName } : {}),
      at: new Date().toISOString()
    })

    return { resolved: true }
  })

  handle<RuntimeStatus>(IPC.invoke.agentStatus, () => ctx.supervisor.getStatus())

  handle<SessionInspectResult>(IPC.invoke.agentInspect, async (_event, ...args) => {
    const sessionId = requireString(args[0], 'sessionId')
    const run = resolveRunContext(sessionId, {})

    // inspect 走与 prompt 完全相同的上下文解析，但**不发送任何内容** ——
    // 它只是把会话建起来读系统提示与技能清单，因此不需要模型可用、也不产生费用。
    return ctx.supervisor.request<SessionInspectResult>('session.inspect', {
      sessionId,
      text: '',
      provider: run.provider,
      apiKey: run.apiKey,
      modelId: run.modelId,
      permissionMode: run.settings.permissionMode,
      // 思考强度也随每次调用传（而不是让 sidecar 自己读设置：两处状态源一定会分叉）。
      thinkingLevel: run.settings.thinkingLevel,
      cwd: run.cwd,
      agentDir: piAgentDir(),
      plugins: enabledPlugins(),
      maxSteps: run.settings.maxSteps
    })
  })
}

/**
 * 把一次 run 需要的全部输入解析出来。
 * 任何一项缺失都抛出带错误码的异常 —— UI 据此弹「去配置模型」而不是显示一堆 undefined。
 */
function resolveRunContext(sessionId: string, input: RunSelection): RunContext {
  const snapshot = loadSession(sessionId)
  if (!snapshot) {
    throw Object.assign(new Error(`会话不存在: ${sessionId}`), { code: 'SESSION_NOT_FOUND' })
  }

  const workspace = getWorkspace(snapshot.session.workspaceId)
  if (!workspace) {
    throw Object.assign(new Error('会话关联的工作区已不存在，请重新选择目录'), { code: 'WORKSPACE_NOT_FOUND' })
  }

  const settings = getSettings()
  const providerId = input.providerId ?? snapshot.session.providerId ?? settings.defaultProviderId
  if (!providerId) {
    throw Object.assign(new Error('还没有配置任何模型 provider'), { code: 'PROVIDER_NOT_CONFIGURED' })
  }

  const provider = getProvider(providerId)
  if (!provider) {
    throw Object.assign(new Error(`provider 不存在: ${providerId}`), { code: 'PROVIDER_NOT_FOUND' })
  }
  if (!provider.enabled) {
    throw Object.assign(new Error(`provider 已被停用: ${provider.label}`), { code: 'PROVIDER_DISABLED' })
  }

  const modelId = input.modelId ?? snapshot.session.modelId ?? settings.defaultModelId ?? provider.models[0]?.id
  if (!modelId) {
    throw Object.assign(new Error(`provider「${provider.label}」还没有可用模型，请先拉取或手工添加模型`), {
      code: 'MODEL_NOT_CONFIGURED'
    })
  }

  // 决定这一轮用哪个 key。完整规则见 store/provider-key.ts —— 简言之：
  // 「配了但取不到」和「公网端点没配」都报错，而「本机/内网端点没配」用占位 key
  // （pi 的 OpenAI 适配层要求 Authorization 头必须存在，否则连请求都不发）。
  const resolvedKey = resolveRunApiKey(provider, getSecret(provider.apiKeyRef))
  if (resolvedKey.errorCode) {
    throw Object.assign(new Error(resolvedKey.errorMessage ?? '缺少 API Key'), { code: resolvedKey.errorCode })
  }

  return {
    sessionId,
    cwd: workspace.path,
    provider,
    apiKey: resolvedKey.apiKey,
    usedPlaceholderKey: resolvedKey.placeholder,
    modelId,
    settings
  }
}

/**
 * 每个 run 的用量累计。
 *
 * 用量随定稿的 assistant 消息回来（一条消息一个 usage），而审计事件要的是
 * 「这一轮总共消耗了多少」，所以在这里按 runId 累加。
 */
const runUsage = new Map<string, { input: number; output: number; cost: number; model?: string }>()

/** approvalId → toolName。裁决回来时要用它填审计事件。 */
const approvalTools = new Map<string, string>()

/** 订阅 sidecar 事件，转发给渲染层，并顺手把定稿消息落库。 */
function wireAgentEvents(ctx: AppContext): void {
  ctx.supervisor.on('event', (payload: AgentEventNotification) => {
    ctx.broadcast(IPC.event.agent, payload)
    const event = payload.event

    // 增量事件只用于显示；只有 message.committed 是「权威消息」，到这里才落库。
    // 这样即使 run 中途崩了，已经定稿的消息也不会丢。
    if (event.type === 'message.committed') {
      /**
       * ⚠️ **用户消息由主进程自己落库，这里必须跳过。**
       *
       * 用户消息在调用内核之前就已经 `persistAndAnnounce` 过一次（见上面的 prompt 处理）——
       * 那是刻意的：模型还没回应就崩掉时，用户输入不该丢。
       *
       * 但内核**也会把这条用户消息作为 `message.committed` 回显**，于是同一个消息
       * 会被落库两次、广播两次。实测的表现是聊天区里每条消息重复出现
       * （用户消息三次、助手消息两次），会话文件也在悄悄变胖。
       *
       * 按角色跳过是最干净的判据：主进程只创建用户消息，其余消息都来自内核。
       */
      if (event.message.role === 'user') {
        // 仍然转发给渲染层做「运行中」的状态维护，但不再落库/广播。
        return
      }
      persistAndAnnounce(ctx, payload.sessionId, event.message)

      const usage = event.message.usage
      if (usage) {
        const acc = runUsage.get(event.runId) ?? { input: 0, output: 0, cost: 0 }
        acc.input += usage.inputTokens
        acc.output += usage.outputTokens
        acc.cost += usage.costUsd ?? 0
        runUsage.set(event.runId, acc)
      }
    }

    if (event.type === 'approval.requested') {
      approvalTools.set(event.approvalId, event.toolName)
    }

    /**
     * 工具跑完后，把最终状态**回写进已落盘的消息**。
     *
     * 不这么做的话，重启应用之后那次工具调用会永远停在「调用中」——
     * 因为内核是在工具**执行之前**定稿那条消息的，结果到达时只有内存里的
     * live 状态被更新（见 `patchToolCallInSession` 的说明）。
     */
    if (event.type === 'tool.finished') {
      patchToolCallInSession(payload.sessionId, event.callId, {
        state: event.ok ? 'succeeded' : 'failed',
        ...(event.ok ? { result: event.result } : { error: event.error ?? '工具执行失败' }),
        finishedAt: new Date().toISOString()
      })
    }

    if (event.type === 'run.finished' || event.type === 'run.failed') {
      const acc = runUsage.get(event.runId)
      runUsage.delete(event.runId)
      const base = {
        sessionId: payload.sessionId,
        ...(acc && acc.input > 0 ? { inputTokens: acc.input, outputTokens: acc.output } : {}),
        ...(acc && acc.cost > 0 ? { costUsd: acc.cost } : {}),
        at: new Date().toISOString()
      }
      recordAuditEvent(
        event.type === 'run.finished'
          ? { type: 'run.completed', ...base }
          : {
              type: 'run.failed',
              ...base,
              // 截断：审计要的是「哪类错误」，不是完整堆栈。
              error: event.error.message.slice(0, 300)
            }
      )
      // 不 await：控制面不可用时绝不能影响本地对话的收尾。
      void flushAudit().catch((error: unknown) => {
        ctx.log(`[control-plane] 审计上报失败（事件仍留在队列里）：${error instanceof Error ? error.message : String(error)}`)
      })
    }
  })

  ctx.supervisor.on('status', (status: RuntimeStatus) => {
    ctx.broadcast(IPC.event.runtimeStatus, status)
    if (status.state === 'crashed') {
      ctx.log(`[agent] sidecar 异常: ${status.lastError ?? '未知原因'}`)
    }
  })
}

function persistAndAnnounce(ctx: AppContext, sessionId: string, message: ChatMessage): void {
  // appendMessage 内部已经刷新了 updatedAt，这里不需要再补一次写盘。
  const session = appendMessage(sessionId, message)
  if (session) ctx.broadcast(IPC.event.session, { type: 'updated', session })
  // 消息本体单独广播，渲染层据此渲染 —— 这是消息内容的唯一来源。
  ctx.broadcast(IPC.event.session, { type: 'message', sessionId, message })
}
