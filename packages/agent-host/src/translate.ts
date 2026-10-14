import { randomUUID } from 'node:crypto'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type {
  AgentEvent,
  ChatMessage,
  MessagePart,
  UsageStats
} from '@i-pi-desk/shared'

/**
 * 内核事件 → 自有事件的翻译层。
 *
 * **这是整个 agent-host 里唯一允许 import pi-* 类型的地方（除 runtime 外）。**
 * pi 升级导致事件改名/改结构时，只需要改这一个文件，UI、持久化格式、
 * 主进程契约都不受影响。
 *
 * 翻译原则：
 *  - 增量事件（delta）只用于显示，不落库。
 *  - 只有 `message_end` 对应的消息是权威的，落到 `message.committed`。
 *  - 认不出来的事件一律返回 null（丢弃），绝不抛异常 —— 上游新增一个事件类型
 *    不应该让整个会话挂掉。
 */

/** pi 的用量结构 → 我们的结构。 */
function toUsage(usage: PiUsageLike | undefined): UsageStats | undefined {
  if (!usage) return undefined
  return {
    inputTokens: usage.input ?? 0,
    outputTokens: usage.output ?? 0,
    // pi 的 cost.total 已经算好；为 0 时视为「没有价格表」，不传出去冒充免费。
    costUsd: usage.cost?.total ? usage.cost.total : undefined
  }
}

interface PiUsageLike {
  input?: number
  output?: number
  cost?: { total?: number }
}

/**
 * pi 的消息 → 我们的 ChatMessage。
 * 返回 null 表示这条消息不需要进 UI（例如 toolResult 的原始回填）。
 */
export function toChatMessage(message: AgentMessage, runId: string): ChatMessage | null {
  const role = (message as { role?: string }).role
  const timestamp = (message as { timestamp?: number }).timestamp

  if (role === 'user') {
    const content = (message as { content: string | Array<{ type: string; text?: string }> }).content
    const text =
      typeof content === 'string'
        ? content
        : content
            .filter((part) => part.type === 'text')
            .map((part) => part.text ?? '')
            .join('')
    return {
      id: randomUUID(),
      role: 'user',
      createdAt: toIso(timestamp),
      parts: [{ kind: 'text', text }],
      runId
    }
  }

  if (role === 'assistant') {
    const content = (message as { content?: unknown[] }).content ?? []
    const parts: MessagePart[] = []
    let pendingCalls: MessagePart[] = []

    for (const raw of content) {
      const part = raw as { type?: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown }
      if (part.type === 'text' && part.text) {
        parts.push({ kind: 'text', text: part.text })
      } else if (part.type === 'thinking' && part.thinking) {
        parts.push({ kind: 'reasoning', text: part.thinking })
      } else if (part.type === 'toolCall') {
        // 工具调用先挂着，等 tool_execution_end 事件到了再补 result/error。
        // 这里 state 只能是 pending：执行结果此刻还不知道。
        pendingCalls.push({
          kind: 'tool-call',
          callId: part.id ?? randomUUID(),
          name: part.name ?? 'unknown',
          args: part.arguments,
          state: 'pending'
        })
      }
    }

    const errorMessage = (message as { errorMessage?: string }).errorMessage
    if (errorMessage) parts.push({ kind: 'error', message: errorMessage })

    return {
      id: randomUUID(),
      role: 'assistant',
      createdAt: toIso(timestamp),
      parts: [...parts, ...pendingCalls],
      usage: toUsage((message as { usage?: PiUsageLike }).usage),
      runId
    }
  }

  // toolResult / system 等不单独成消息：工具结果已经通过 tool.finished 反映在
  // 那条 assistant 消息的 tool-call part 上。
  return null
}

function toIso(timestamp: number | undefined): string {
  const ms = typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : Date.now()
  return new Date(ms).toISOString()
}

export interface TranslateContext {
  runId: string
  sessionId: string
  /**
   * 本次 run 是否被调用方请求过中止。
   *
   * **结束原因不再依赖它**：pi 的 `agent_settled` 自带 `aborted`，那是权威值
   * （调用方请求 abort 和 pi 实际中止之间可能有差异）。保留这个字段是因为
   * 「谁请求了 abort」对诊断仍然有用，且它是 runtime 侧已有的状态。
   */
  aborted: () => boolean
}

/**
 * 把 pi 的会话事件翻译成自有事件。返回 null 表示这个事件不需要转发。
 *
 * 参数类型用 pi `AgentSessionEvent`（`session.subscribe` 给的就是它）而不是
 * pi-agent-core 的 `AgentEvent`：结束信号 `agent_settled` 只存在于前者。
 */
export function translateEvent(event: AgentSessionEvent, ctx: TranslateContext): AgentEvent | null {
  switch (event.type) {
    case 'agent_start':
      return { type: 'run.started', runId: ctx.runId, sessionId: ctx.sessionId }

    case 'message_update': {
      const inner = event.assistantMessageEvent
      if (inner.type === 'text_delta') {
        return inner.delta ? { type: 'text.delta', runId: ctx.runId, text: inner.delta } : null
      }
      if (inner.type === 'thinking_delta') {
        return inner.delta ? { type: 'reasoning.delta', runId: ctx.runId, text: inner.delta } : null
      }
      // text_start / text_end / toolcall_* / done 都不产生独立 UI 事件：
      // 正文由 delta 拼出来，工具调用由 tool_execution_* 事件驱动。
      return null
    }

    case 'tool_execution_start':
      return {
        type: 'tool.started',
        runId: ctx.runId,
        callId: event.toolCallId,
        name: event.toolName,
        args: event.args
      }

    case 'tool_execution_end':
      return {
        type: 'tool.finished',
        runId: ctx.runId,
        callId: event.toolCallId,
        ok: !event.isError,
        result: event.isError ? undefined : event.result,
        error: event.isError ? describeToolError(event.result) : undefined
      }

    case 'message_end': {
      const message = toChatMessage(event.message, ctx.runId)
      if (!message) return null
      return { type: 'message.committed', runId: ctx.runId, message }
    }

    case 'agent_end':
      /**
       * **故意不映射成 run.finished。**
       *
       * `agent_end` 只是「一次底层 agent 循环结束」，之后 pi 还可能自动重试
       * （auto_retry_start）或继续处理排队消息，用它当结束会让 UI 提前收尾、
       * 后面的事件落在「已经结束」的 run 上。
       * 真正的终点是 `agent_settled`（见下面那个分支）。
       */
      return null

    case 'agent_settled':
      /**
       * 权威的结束信号，且自带 aborted。
       *
       * 判据必须与 `runtime.ts` 里 `prompt()` 的返回值**完全一致**
       * （那里是 `record.settledAborted || record.aborted`），否则同一轮会分叉：
       * 事件流说 `aborted`、返回值说别的，界面上「已中止」的提示就不出现。
       * 用户请求过中止、而 pi 恰好把它当成正常结束时，`event.aborted` 是 false，
       * 所以要把它或上 `ctx.aborted()`。
       */
      return {
        type: 'run.finished',
        runId: ctx.runId,
        stopReason: event.aborted || ctx.aborted() ? 'aborted' : 'end_turn'
      }

    default:
      // turn_start / turn_end / agent_settled / queue_update / compaction_* 等
      // 暂时不映射。需要时在这里加分支，而不是让 UI 去理解 pi 的原生事件。
      return null
  }
}

/** 工具失败时 pi 会把错误塞在 result 里，形状不固定，尽力提取出可读文本。 */
function describeToolError(result: unknown): string {
  if (typeof result === 'string') return result
  if (result && typeof result === 'object') {
    const content = (result as { content?: unknown }).content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      const text = content
        .map((part) => (part && typeof part === 'object' ? (part as { text?: string }).text : undefined))
        .filter((value): value is string => Boolean(value))
        .join('\n')
      if (text) return text
    }
    const message = (result as { message?: string }).message
    if (typeof message === 'string') return message
  }
  return '工具执行失败'
}
