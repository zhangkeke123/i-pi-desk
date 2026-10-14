import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Compass,
  FileCode2,
  FolderOpen,
  GitCompare,
  ListChecks,
  Loader2,
  Settings2,
  Sparkles,
  TestTube,
  TriangleAlert
} from 'lucide-react'
import type { ChatMessage, MessagePart, WorkspaceFacts } from '@i-pi-desk/shared'
import { useAppStore } from '../../stores/app-store.js'
import { MessageParts } from './MessageParts.js'
import { SessionPreviewRail } from './SessionPreviewRail.js'
import { ComposerCard } from './ComposerCard.js'
import { currentStepText, describeRunSteps, formatElapsed, limitWarning, maxStepsNotice } from '../../lib/run-status.js'
import { composerBlocker, isStubProvider } from '../../lib/composer-blocker.js'
import { MESSAGE_WINDOW, hiddenLabel, windowMessages } from '../../lib/message-window.js'
import { buildStarters, emptyStateTitle } from '../../lib/starters.js'
import { call, getDesk } from '../../lib/desk.js'
import { summarizeRun } from '../../lib/run-summary.js'
import { formatRelativeTime, resolveSessionStatus, sessionStatusLabel } from '../../lib/session-groups.js'

/** 这些错误码意味着「配置没弄好」，UI 应当直接给一个去设置的入口。 */
const CONFIG_ERROR_CODES = new Set([
  'PROVIDER_NOT_CONFIGURED',
  'PROVIDER_NOT_FOUND',
  'PROVIDER_DISABLED',
  'PROVIDER_KEY_MISSING',
  'MODEL_NOT_CONFIGURED'
])

export function ChatView({ onOpenSettings }: { onOpenSettings: () => void }): React.ReactElement {
  const messages = useAppStore((s) => s.messages)
  const live = useAppStore((s) => s.live)
  const busy = useAppStore((s) => s.busy)
  const promptError = useAppStore((s) => s.promptError)
  const lastStopReason = useAppStore((s) => s.lastStopReason)
  const currentSessionId = useAppStore((s) => s.currentSessionId)
  const currentWorkspace = useAppStore((s) => s.currentWorkspace)
  /**
   * 思考态的计时。
   *
   * 起点在 busy 变 true 的那一刻（而不是消息时间戳）：用户关心的是「我等了多久」，
   * 而不是「这条消息什么时候创建的」。结束（busy=false）就清空，不留下会自己走的定时器。
   */
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null)
  const [clockNow, setClockNow] = useState(() => Date.now())
  useEffect(() => {
    if (!busy) {
      setRunStartedAt(null)
      return
    }
    setRunStartedAt((previous) => previous ?? Date.now())
    const timer = setInterval(() => setClockNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [busy])

  /** 没有可用 provider 时也不该让用户白敲一段话（见输入区的说明行）。 */
  const enabledProviders = useAppStore((s) => s.providers.filter((p) => p.enabled).length)
  const onlyStubProviders = useAppStore((s) => {
    const enabled = s.providers.filter((p) => p.enabled)
    return enabled.length > 0 && enabled.every((p) => isStubProvider(p))
  })

  const sendPrompt = useAppStore((s) => s.sendPrompt)
  const abort = useAppStore((s) => s.abort)
  const resolveApproval = useAppStore((s) => s.resolveApproval)
  const pickWorkspace = useAppStore((s) => s.pickWorkspace)
  const settings = useAppStore((s) => s.settings)

  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  const pinnedToBottom = useRef(true)
  const bindScrollEl = (node: HTMLDivElement | null): void => {
    scrollRef.current = node
    setScrollEl(node)
  }

  /**
   * 输入框的历史记录 = 这个会话里**已经发过的用户消息**。
   *
   * 刻意不另外存一份：会话消息本来就是持久化的，从它派生意味着
   * **重启应用后历史自动还在**，也不会出现「历史列表与真实对话不一致」。
   * 代价是历史以会话为界（换会话就换一套），但那正是人们期望的语义。
   */
  const promptHistory = useMemo(
    () =>
      messages
        .filter((message) => message.role === 'user')
        .map((message) =>
          message.parts
            .filter((part): part is { kind: 'text'; text: string } => part.kind === 'text')
            .map((part) => part.text)
            .join('')
            .trim()
        )
        .filter((text) => text.length > 0),
    [messages]
  )

  // 用户往上翻历史时不要强行拉回底部 —— 流式输出时那会让人没法读代码。
  const onScroll = (): void => {
    const element = scrollRef.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    pinnedToBottom.current = distance < 80
  }

  useEffect(() => {
    if (!pinnedToBottom.current) return
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, live])

  const liveParts: MessagePart[] = live?.parts ?? []

  /**
   * 状态行要说的那句话与已用时长。
   *
   * 步骤直接从工具调用里翻译（见 lib/run-status.ts），所以它不是装饰性的文案：
   * 「正在读取 src/main.ts」出现时，模型确实正在读那个文件。
   *
   * 时长在 10 秒之后才出现 —— 前几秒显示 0:01 只会让人盯着数字看。
   */
  /**
   * 步骤要从**两处**取：已定稿消息里可能有这次运行的工具调用
   * （写文件会先落库一条带工具调用的消息，再等审批），而流式气泡里可能只有审批卡。
   * 只看 live 会出现「明明在等授权，状态行却写『正在思考』」——
   * 第一版就是这个毛病，是截图里看出来的。
   */
  const lastAssistantParts =
    messages.length > 0 && messages[messages.length - 1]?.role === 'assistant'
      ? (messages[messages.length - 1]?.parts ?? [])
      : []
  /**
   * **这一轮**的工具调用 = 最后一条用户消息之后的所有 part。
   *
   * 汇总与限额都以「这一轮」为单位，而不是整个会话：会话里可能已经有过好几轮，
   * 把它们的工具调用一起数进来，用户看到的数字会与他刚才那件事对不上。
   */
  const lastUserIndex = messages.map((message) => message.role).lastIndexOf('user')
  const turnParts = [
    ...messages.slice(lastUserIndex === -1 ? 0 : lastUserIndex + 1).flatMap((message) => message.parts),
    ...liveParts
  ]
  const turnToolCalls = turnParts.filter((part) => part.kind === 'tool-call').length

  /** 跑完之后才下结论（还在跑时汇总没有意义）。 */
  const runSummary = busy ? null : summarizeRun(turnParts)

  /** 接近上限时的预警（阈值 80%，见 lib/run-status.ts）。 */
  const nearLimit = busy && settings ? limitWarning(turnToolCalls, settings.maxSteps) : null

  const runStep = currentStepText(describeRunSteps([...lastAssistantParts, ...liveParts]))
  const toolProgress =
    busy && settings?.maxSteps && settings.maxSteps > 0
      ? Math.min(1, turnToolCalls / settings.maxSteps)
      : undefined
  const runElapsed =
    runStartedAt !== null && clockNow - runStartedAt >= 10_000 ? formatElapsed(clockNow - runStartedAt) : null
  /**
   * 「有操作在等你裁决」只能有**一个**判据。
   *
   * 原来这里是从**持久化消息**里找 `kind === 'approval'` 的 part：
   * `pendingApprovals(messages.flatMap((m) => m.parts))`。而审批 part **从来不落库**
   * （它只活在 `live` 里），所以这个表达式恒为 false —— 输入框实际上从来没有被挡住过，
   * 而占位文案里那句「有操作等待你的确认…」是一次都没出现过的死逻辑。
   *
   * 这个缺陷是被「等审批时切走再切回」那段自测抓出来的：卡片用真实 runId 种回来了，
   * 输入框却依然是可用的 —— 同一件事在两处算，于是分叉。
   *
   * 现在和卡片同源：都看 store 里按会话记的 `pendingApprovals`。
   */
  const pendingForSession = useAppStore((s) =>
    s.currentSessionId ? s.pendingApprovals[s.currentSessionId] : undefined
  )
  const blocked = pendingForSession !== undefined

  /**
   * 长会话只渲染最近 MESSAGE_WINDOW 条，更早的按需展开。
   *
   * 全量渲染的代价是「每次流式 token / 工具状态变化都重算几百个节点」，
   * 用户感受到的是「越用越卡」而很难归因。窗口把常见情况钉在常数上；
   * 窗口规则本身是纯函数（lib/message-window.ts），边界由单测覆盖。
   *
   * 切会话时自动收回展开状态：否则「我在 A 会话展开了全部」会带到 B 会话，
   * 而 B 会话可能根本没有那么多消息 —— 那种残留状态很难解释。
   */
  const [showAllMessages, setShowAllMessages] = useState(false)
  useEffect(() => {
    setShowAllMessages(false)
  }, [currentSessionId])
  const messageWindow = windowMessages(messages, MESSAGE_WINDOW, showAllMessages)

  /**
   * 空状态里点了示例之后，把文本「递」给输入框。
   *
   * 带 token 是为了「连点两次同一条示例」也能再次生效 —— 只传字符串的话，
   * React 看到值没变就不会重跑 effect。
   */
  const [inject, setInject] = useState<{ text: string; token: number } | null>(null)

  const railMessages = useMemo(() => {
    const list: Array<Pick<ChatMessage, 'id' | 'role' | 'parts'>> = [...messageWindow.visible]
    if (liveParts.length > 0) {
      list.push({ id: 'live', role: 'assistant', parts: liveParts })
    }
    return list
  }, [messageWindow.visible, liveParts])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative flex min-h-0 flex-1">
      <SessionPreviewRail messages={railMessages} scrollRoot={scrollEl} />
      {/*
        消息流容器。

        `scrollbar-gutter: stable` 是设计稿 §3.3「给迟到元素预留空间」的一半：
        流式输出到某一行时滚动条会突然出现，那一瞬间**整块内容会横向缩一下**，
        看起来像页面抖了一下。留出固定的滚动条槽位就没有这个位移了。
        （另一半在 MessageParts 的 markdown 样式里：代码块与表格给最小高度。）

        `overflow-anchor: none` 是有意的：浏览器默认的滚动锚定会在流式追加内容时
        「帮你保持视口」，而我们的策略是**用户滚上去就不动、贴底才跟随**
        （见 pinnedToBottom）。两套策略同时生效会互相打架。
      */}
      <div
        ref={bindScrollEl}
        onScroll={onScroll}
        data-testid="message-stream"
        className="chat-stream min-h-0 flex-1 overflow-y-auto px-4 py-6 pl-3 [overflow-anchor:none] [scrollbar-gutter:stable]"
      >
        {!currentSessionId && messages.length === 0 && (
          <EmptyState
            hasWorkspace={Boolean(currentWorkspace)}
            onOpenSettings={onOpenSettings}
            onPickExample={(text) => setInject({ text, token: Date.now() })}
          />
        )}

        <div className="mx-auto max-w-3xl space-y-4">
          {/*
            更早的消息：默认折叠，按需展开（见 messageWindow 的说明）。

            提示语带**具体条数**：只说「显示更早的消息」会让人不知道要点出多少东西，
            而条数也是「这个会话有多长」的一个信息。
          */}
          {messageWindow.hiddenCount > 0 && (
            <button
              type="button"
              data-testid="show-earlier"
              onClick={() => setShowAllMessages(true)}
              className="mx-auto block rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-1.5 text-2xs text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]"
            >
              {hiddenLabel(messageWindow.hiddenCount)}
            </button>
          )}

          {messageWindow.visible.map((message, index, visible) => (
            <div
              key={message.id}
              id={`msg-${message.id}`}
              data-testid="message-row"
              data-message-id={message.id}
              className="msg-row"
            >
              <Bubble
                message={message}
                endedAt={visible[index + 1]?.createdAt}
                onDecide={(id, decision) => void resolveApproval(id, decision)}
              />
            </div>
          ))}

          {/*
            思考态：尚无 live 气泡时单独一行；有 live 气泡时并入该 turn 卡 footer（同 testid）。
          */}
          {busy && liveParts.length === 0 && (
            <RunStatusLine runStep={runStep} runElapsed={runElapsed} />
          )}

          {/*
            接近上限就提前说（设计稿 §3.8）：撞上之后再解释已经晚了 ——
            用户会以为「它自己停下来了」，而其实是他自己设的上限。
          */}
          {nearLimit && (
            <div
              data-testid="limit-warning"
              className="flex items-center gap-2 rounded-[var(--radius-md)] border px-3 py-2 text-2xs"
              style={{
                borderColor: 'color-mix(in oklch, var(--color-warn) 40%, transparent)',
                background: 'var(--color-warn-soft)',
                color: 'var(--color-warn)'
              }}
            >
              <span className="min-w-0 flex-1">◷ {nearLimit.text}</span>
              <button
                type="button"
                onClick={onOpenSettings}
                className="shrink-0 font-medium underline underline-offset-2"
                style={{ color: 'var(--color-accent)' }}
              >
                去调大 →
              </button>
            </div>
          )}

          {liveParts.length > 0 && (
            <div id="msg-live" data-testid="message-row" data-message-id="live" className="msg-row">
              <Bubble
                message={{
                  id: 'live',
                  role: 'assistant',
                  createdAt: new Date().toISOString(),
                  parts: liveParts
                }}
                streaming
                runStep={runStep}
                runElapsed={runElapsed}
                showRunStatus
                onDecide={(id, decision) => void resolveApproval(id, decision)}
              />
            </div>
          )}

          {/*
            「部分完成」的汇总（设计稿 §3.4）。

            多步任务最常见的结局是**做了一半**：几个文件改好了、两个失败了、一个被拒绝。
            没有这张卡，用户只能自己在折叠的工具卡里数 —— 而它们会滚出视野。
            结论先说数字，再逐条给原因，最后说明已完成的工作都还在。
          */}
          {runSummary && (
            <div
              data-testid="run-summary"
              className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3.5 shadow-[var(--shadow-sm)]"
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-title font-semibold">{runSummary.headline}</span>
                <span className="text-2xs text-[var(--color-muted)]">{runSummary.detail}</span>
              </div>
              <div className="mt-2.5 flex flex-col gap-1.5">
                {runSummary.items.map((item) => (
                  <div
                    key={item.name + item.reason}
                    className="flex items-start gap-2 rounded-[var(--radius-sm)] border px-2.5 py-1.5 text-xs"
                    style={{
                      borderColor: 'color-mix(in oklch, var(--color-danger) 30%, transparent)',
                      background: 'var(--color-danger-soft)'
                    }}
                  >
                    <span className="shrink-0" style={{ color: 'var(--color-danger)' }}>
                      {item.kind === 'denied' ? '⊘' : '✕'}
                    </span>
                    <span className="min-w-0 flex-1">
                      <b className="font-mono">{item.name}</b>
                      <span className="text-[var(--color-muted)]"> · {item.reason}</span>
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-2.5 text-2xs text-[var(--color-muted)]">{runSummary.keptText}</p>
            </div>
          )}

          {lastStopReason === 'max_steps' && (
            <div
              data-testid="max-steps-notice"
              className="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border px-3 py-2 text-xs"
              style={{
                borderColor: 'color-mix(in oklch, var(--color-warn) 40%, transparent)',
                background: 'var(--color-warn-soft)',
                color: 'var(--color-warn)'
              }}
            >
              <span className="min-w-0 flex-1">{maxStepsNotice(turnToolCalls, settings?.maxSteps ?? 0)}</span>
              <button
                type="button"
                onClick={onOpenSettings}
                className="shrink-0 font-medium underline underline-offset-2"
                style={{ color: 'var(--color-accent)' }}
              >
                去设置 →
              </button>
            </div>
          )}
          {lastStopReason === 'aborted' && <Notice tone="muted" text="本次运行已被你中止。" />}
        </div>
      </div>
      </div>

      {promptError && (
        <div className="mx-4 mb-2 flex items-start gap-2 rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/8 p-3 text-sm">
          <TriangleAlert size={15} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
          <div className="min-w-0 flex-1">
            <p className="whitespace-pre-wrap">{promptError}</p>
            {looksLikeConfigError(promptError) && (
              <button
                type="button"
                onClick={onOpenSettings}
                className="mt-2 rounded-md border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-surface-2)]"
              >
                去配置模型
              </button>
            )}
          </div>
        </div>
      )}

      <ComposerCard
        busy={busy}
        blocked={blocked}
        history={promptHistory}
        inject={inject}
        runStartedAt={runStartedAt}
        clockNow={clockNow}
        toolProgress={toolProgress}
        onInjected={() => setInject(null)}
        onSend={(text) => void sendPrompt(text)}
        onAbort={() => void abort()}
        blocker={(() => {
          const blocker = composerBlocker({
            hasWorkspace: Boolean(currentWorkspace),
            enabledProviders,
            onlyStubProviders
          })
          if (!blocker) return null
          return {
            text: blocker.text,
            actionLabel: blocker.actionLabel,
            onAction: blocker.action === 'pick-workspace' ? () => void pickWorkspace() : onOpenSettings
          }
        })()}
      />
    </div>
  )
}

function looksLikeConfigError(message: string): boolean {
  for (const code of CONFIG_ERROR_CODES) {
    if (message.includes(code)) return true
  }
  // 错误消息本身也被主进程写成了可读中文，这里兜一层关键词匹配。
  return /还没有配置|还没有可用模型|缺少 API Key|provider 不存在/.test(message)
}

function RunStatusLine({
  runStep,
  runElapsed
}: {
  runStep: string | undefined
  runElapsed: string | null
}): React.ReactElement {
  return (
    <div data-testid="run-status" className="run-status-line">
      <Loader2 size={12} className="shrink-0 animate-spin text-[var(--color-accent)]" />
      <span className="min-w-0 flex-1 truncate text-[var(--color-ink-soft)]">{runStep ?? '正在思考…'}</span>
      {runElapsed && (
        <span className="shrink-0 font-mono tabular-nums" title="本次运行已用时长">
          {runElapsed}
        </span>
      )}
    </div>
  )
}

function turnFooterText(message: ChatMessage, endedAt?: string): string | null {
  const toolCount = message.parts.filter((part) => part.kind === 'tool-call').length
  const started = Date.parse(message.createdAt)
  const ended = endedAt ? Date.parse(endedAt) : NaN
  const durationMs =
    Number.isFinite(started) && Number.isFinite(ended) && ended > started ? ended - started : null

  if (toolCount === 0 && durationMs === null) return null

  const parts: string[] = []
  if (durationMs !== null && durationMs >= 1000) {
    parts.push(`思考 ${formatElapsed(durationMs)}`)
  }
  if (toolCount > 0) {
    parts.push(`${toolCount} 个工具`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

function Bubble({
  message,
  streaming,
  endedAt,
  runStep,
  runElapsed,
  showRunStatus,
  onDecide
}: {
  message: ChatMessage
  streaming?: boolean
  endedAt?: string
  runStep?: string
  runElapsed?: string | null
  showRunStatus?: boolean
  onDecide: (approvalId: string, decision: 'allow-once' | 'allow-always' | 'deny') => void
}): React.ReactElement {
  const isUser = message.role === 'user'
  const footer = !isUser && !streaming ? turnFooterText(message, endedAt) : null

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%]">
          <div className="mb-1 flex items-center justify-end gap-2 text-2xs text-[var(--color-muted)]">
            <span className="font-medium text-[var(--color-ink-soft)]">你</span>
          </div>
          <div className="rounded-[var(--radius-lg)] rounded-tr-[var(--radius-xs)] bg-[var(--color-accent-soft)] px-3.5 py-2.5">
            <MessageParts parts={message.parts} onDecide={onDecide} layout="flat" />
          </div>
        </div>
      </div>
    )
  }

  return (
    <article className="turn-card">
      <header className="turn-card__head">
        <span className="turn-card__avatar">
          <Sparkles size={10} />
        </span>
        <span className="font-medium text-[var(--color-ink-soft)]">agent</span>
        {streaming && (
          <span className="flex items-center gap-1 text-[var(--color-accent)]">
            <Loader2 size={11} className="animate-spin" />
            生成中
          </span>
        )}
        {message.usage && (
          <span className="ml-auto font-mono text-2xs tabular-nums text-[var(--color-muted)]">
            in {message.usage.inputTokens} / out {message.usage.outputTokens}
            {message.usage.costUsd !== undefined ? ` · $${message.usage.costUsd.toFixed(4)}` : ''}
          </span>
        )}
      </header>

      <div className="turn-card__body">
        <MessageParts parts={message.parts} onDecide={onDecide} layout="turn" />
      </div>

      {(footer || showRunStatus) && (
        <footer className="turn-card__foot">
          {showRunStatus ? (
            <RunStatusLine runStep={runStep} runElapsed={runElapsed ?? null} />
          ) : (
            <span>{footer}</span>
          )}
        </footer>
      )}
    </article>
  )
}

function Notice({ tone, text }: { tone: 'warn' | 'muted'; text: string }): React.ReactElement {
  const color = tone === 'warn' ? 'var(--color-warn)' : 'var(--color-muted)'
  return (
    <p className="text-center text-xs" style={{ color }}>
      {text}
    </p>
  )
}

function EmptyState({
  hasWorkspace,
  onOpenSettings,
  onPickExample
}: {
  hasWorkspace: boolean
  onOpenSettings: () => void
  onPickExample: (text: string) => void
}): React.ReactElement {
  const pickWorkspace = useAppStore((s) => s.pickWorkspace)

  /**
   * 空状态的取法（这次重设计的要点）。
   *
   * 原来只有标题 + 两行说明 + 两个按钮，上下都是空白 —— 观感是「还没做」而不是「准备好了」。
   * 现在按三层组织：
   *
   *  1. **品牌与一句话**：这是哪儿；
   *  2. **主次动作**：没有工作目录时，选目录就是唯一的主按钮；
   *  3. **可点的示例 + 能力清单**：把空白换成有用信息 ——
   *     示例点了直接填进输入框（不是空喊「开始对话吧」），能力清单回答「它能干什么」。
   *
   * 「选择工作目录 / 切换工作目录」这两个字样被端到端自测依赖，不要改动。
   */
  const currentWorkspace = useAppStore((s) => s.currentWorkspace)
  const sessions = useAppStore((s) => s.sessions)
  const workspaces = useAppStore((s) => s.workspaces)
  const selectSession = useAppStore((s) => s.selectSession)
  const openWorkspace = useAppStore((s) => s.openWorkspace)
  const pendingApprovals = useAppStore((s) => s.pendingApprovals)

  /**
   * 工作区事实（主进程扫出来的）。
   *
   * 起手任务**基于这个目录的真实情况**生成 —— 有 test 脚本才会建议跑测试，
   * 扫到 TODO 才会建议整理 TODO。「它已经看过你的项目了」这件事，
   * 就体现在每条建议下面那行小字上。
   *
   * 读不到（目录被删、没权限）时退回通用三条：宁可通用，也不编造。
   */
  const [facts, setFacts] = useState<WorkspaceFacts | null>(null)
  useEffect(() => {
    if (!currentWorkspace) {
      setFacts(null)
      return
    }
    let alive = true
    void (async () => {
      try {
        const next = await call(getDesk().workspace.facts(currentWorkspace.path))
        if (alive) setFacts(next)
      } catch {
        if (alive) setFacts(null)
      }
    })()
    return () => {
      alive = false
    }
  }, [currentWorkspace?.path])

  const GLYPHS: Record<string, typeof Compass> = {
    test: TestTube,
    structure: Compass,
    todo: ListChecks,
    readme: FileCode2,
    git: GitCompare,
    plan: Sparkles
  }
  const examples = buildStarters(facts).map((starter) => ({
    icon: GLYPHS[starter.glyph] ?? Compass,
    text: starter.text,
    why: starter.why
  }))

  const running = sessions.filter((s) => s.runStatus === 'running').length
  const awaiting = Object.keys(pendingApprovals).length
  const recentSessions = [...sessions]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 4)
  const recentDirs = workspaces.slice(0, 4)

  return (
    <div
      className="empty-state workbench-console mx-auto flex w-full max-w-2xl flex-col justify-start px-6 py-8 text-left"
      data-testid="workbench-console"
    >
      {/*
        A · 控制台空态：不是海报大标题，而是「选目录 / 续会话 / 起手任务」的驾驶舱首页。
        「选择一个工作目录」文案被端到端依赖，勿改。
      */}
      <h1 className="text-[18px] font-semibold tracking-tight text-[var(--color-ink)]">
        {hasWorkspace ? emptyStateTitle(currentWorkspace?.name) : '选择工作区，开始任务'}
      </h1>
      <p className="mt-1.5 max-w-lg text-[13px] leading-relaxed text-[var(--color-muted)]">
        会话工作台是当前任务驾驶舱。项目只在左侧分组；右侧产物栏随时审阅 Changes / 文件 / 终端。
      </p>

      {!hasWorkspace && (
        <button
          type="button"
          onClick={() => void pickWorkspace()}
          className="btn btn-primary mt-5 h-8 w-fit px-3"
        >
          <FolderOpen size={14} />
          选择一个工作目录
        </button>
      )}

      <div className="mt-5 grid grid-cols-3 gap-2">
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5">
          <p className="text-[16px] font-semibold tracking-tight text-[var(--color-ink)]">{sessions.length}</p>
          <p className="font-mono text-2xs text-[var(--color-muted)]">最近会话</p>
        </div>
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5">
          <p className="text-[16px] font-semibold tracking-tight text-[var(--color-ink)]">{running}</p>
          <p className="font-mono text-2xs text-[var(--color-muted)]">进行中</p>
        </div>
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5">
          <p className="text-[16px] font-semibold tracking-tight text-[var(--color-ink)]">{awaiting}</p>
          <p className="font-mono text-2xs text-[var(--color-muted)]">待确认</p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <p className="mb-2 font-mono text-2xs uppercase tracking-[0.08em] text-[var(--color-muted)]">
            最近目录
          </p>
          {recentDirs.length === 0 ? (
            <p className="text-xs text-[var(--color-muted)]">还没有打开过目录</p>
          ) : (
            recentDirs.map((ws) => (
              <button
                key={ws.id}
                type="button"
                onClick={() => void openWorkspace(ws.path)}
                className="flex w-full items-center gap-2 border-t border-[var(--color-border)] py-1.5 text-left text-xs text-[var(--color-ink)] first:border-t-0 hover:text-[var(--color-accent)]"
                title={ws.path}
              >
                <span className="min-w-0 flex-1 truncate">{ws.name}</span>
                <span className="shrink-0 font-mono text-2xs text-[var(--color-muted)]">
                  {formatRelativeTime(ws.lastOpenedAt)}
                </span>
              </button>
            ))
          )}
        </div>
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <p className="mb-2 font-mono text-2xs uppercase tracking-[0.08em] text-[var(--color-muted)]">
            继续会话
          </p>
          {recentSessions.length === 0 ? (
            <p className="text-xs text-[var(--color-muted)]">还没有会话</p>
          ) : (
            recentSessions.map((session) => {
              const status = resolveSessionStatus(session, {
                awaitsApproval: Boolean(pendingApprovals[session.id])
              })
              return (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => void selectSession(session.id)}
                  className="flex w-full items-center gap-2 border-t border-[var(--color-border)] py-1.5 text-left text-xs text-[var(--color-ink)] first:border-t-0 hover:text-[var(--color-accent)]"
                >
                  <span className="min-w-0 flex-1 truncate">{session.title}</span>
                  <span className="shrink-0 font-mono text-2xs text-[var(--color-muted)]">
                    {sessionStatusLabel(status)}
                  </span>
                </button>
              )
            })
          )}
        </div>
      </div>

      <div className="empty-state__starters mt-5 flex flex-wrap gap-1.5">
        {examples.map((example) => (
          <button
            key={example.text}
            type="button"
            data-testid="starter"
            disabled={!hasWorkspace}
            onClick={() => onPickExample(example.text)}
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[11.5px] text-[var(--color-ink)] transition-colors hover:bg-[var(--color-surface-2)] disabled:cursor-not-allowed disabled:opacity-45"
            title={example.why}
          >
            <example.icon size={11} className="text-[var(--color-muted)]" />
            {example.text}
          </button>
        ))}
      </div>

      {currentWorkspace && (
        <p className="mt-6 font-mono text-2xs text-[var(--color-muted)] opacity-70">
          {currentWorkspace.path} · {sessions.length} 个会话
        </p>
      )}
    </div>
  )
}
