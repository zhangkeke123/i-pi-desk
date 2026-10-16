import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
/**
 * 中文换行。
 *
 * markdown 的换行规则是按西文定的：中文之间没有空格，于是渲染器会把一整段
 * 中文挤成一行、只在标点处断，行尾经常出现「只有一两个字」的孤字（尤其配合
 * `remark-gfm` 的表格与列表时更明显）。这个插件按 CJK 的规则处理断行与
 * 标点挤压，属于**读起来顺不顺**的差别，不影响功能但对中文界面很值
 * （40KB、MIT、只在构建期用）。
 */
import remarkCjkFriendly from 'remark-cjk-friendly'
import {
  AlertTriangle,
  Brain,
  Check,
  ChevronRight,
  Loader2,
  ShieldAlert,
  Terminal,
  Wrench,
  X
} from 'lucide-react'
import type { ApprovalDecision, MessagePart } from '@i-pi-desk/shared'
import { DiffView } from '../diff/DiffView.js'
import { approvalTimer } from '../../lib/approval-timer.js'
import { summarizeSteps } from '../../lib/step-summary.js'

/**
 * 单条消息的内容渲染。
 *
 * 每种 part 用独立组件，不要写成一个巨型 switch —— 后面加「diff 视图」「图片」
 * 「文件引用」时都是新增一个分支组件，不用动既有逻辑。
 */

function isContentPart(part: MessagePart): boolean {
  return part.kind === 'text' || part.kind === 'reasoning' || part.kind === 'error'
}

function isStepPart(part: MessagePart): boolean {
  return part.kind === 'tool-call' || part.kind === 'approval'
}

function TurnLayoutParts({
  parts,
  onDecide
}: {
  parts: MessagePart[]
  onDecide?: (approvalId: string, decision: ApprovalDecision) => void
}): React.ReactElement {
  const contentParts = parts.filter(isContentPart)
  const stepParts = parts.filter(isStepPart)
  const summary = summarizeSteps(stepParts)
  /** 成功默认收起；审批中 / 失败 / 执行中强制展开。 */
  const [stepsOpen, setStepsOpen] = useState(summary.startOpen)

  useEffect(() => {
    if (summary.startOpen) setStepsOpen(true)
  }, [summary.startOpen])

  return (
    <div className="space-y-2" data-testid="message-parts">
      {contentParts.map((part, index) => (
        <Part key={`c-${index}`} part={part} onDecide={onDecide} />
      ))}

      {stepParts.length > 0 && (
        <div className="turn-steps">
          <button
            type="button"
            className="turn-steps__toggle"
            onClick={() => setStepsOpen((value) => !value)}
            aria-expanded={stepsOpen}
          >
            <ChevronRight size={12} className={`turn-steps__chevron ${stepsOpen ? 'turn-steps__chevron--open' : ''}`} />
            <span>{summary.total} 个步骤</span>
            {summary.issues > 0 ? (
              <span className="turn-steps__issues">{summary.issues} 个问题</span>
            ) : (
              <span className="turn-steps__hint">{stepsOpen ? '收起' : '展开工具与确认'}</span>
            )}
          </button>
          {stepsOpen && (
            <div className="turn-steps__list space-y-2">
              {stepParts.map((part, index) => (
                <div key={`s-${index}`} className="turn-steps__item">
                  <Part part={part} onDecide={onDecide} compactStep />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function MessageParts({
  parts,
  onDecide,
  layout = 'flat'
}: {
  parts: MessagePart[]
  onDecide?: (approvalId: string, decision: ApprovalDecision) => void
  /** assistant turn 卡：正文与可折叠工具/审批步骤分区 */
  layout?: 'flat' | 'turn'
}): React.ReactElement {
  if (layout === 'turn') {
    return <TurnLayoutParts parts={parts} onDecide={onDecide} />
  }

  return (
    <div className="space-y-2" data-testid="message-parts">
      {parts.map((part, index) => (
        <Part key={index} part={part} onDecide={onDecide} />
      ))}
    </div>
  )
}

function Part({
  part,
  onDecide,
  compactStep
}: {
  part: MessagePart
  onDecide?: (approvalId: string, decision: ApprovalDecision) => void
  compactStep?: boolean
}): React.ReactElement | null {
  switch (part.kind) {
    case 'text':
      return <TextPart text={part.text} />
    case 'reasoning':
      return <ReasoningPart text={part.text} />
    case 'tool-call':
      return <ToolCallCard part={part} compact={compactStep} />
    case 'approval':
      return <ApprovalCard part={part} onDecide={onDecide} compact={compactStep} />
    case 'error':
      return <ErrorPart message={part.message} />
    default:
      return null
  }
}

function TextPart({ text }: { text: string }): React.ReactElement {
  if (!text.trim()) return <span />
  return (
    <div className="md">
      {/*
        代码块与表格给**最小高度**（设计稿 §3.3「迟到元素预留空间」）。

        为什么：流式输出里代码块的到达是「先出现一个空的 pre，再一行行长出来」。
        空 pre 高度是 0，于是它下面所有内容会先被顶上去、再被挤下来 ——
        读的人正盯着某一行，页面自己跳了。给两行左右的最小高度，第一次渲染就把位置占住。
        表格同理（表头先到、行随后到）。

        markdown 是运行时渲染的，没有可以挂 class 的地方，所以用任意值选择器。
      */}
      <div className="[&_pre]:min-h-[3.25rem] [&_table]:min-h-[2.5rem]">
        <Markdown remarkPlugins={[remarkGfm, remarkCjkFriendly]}>{text}</Markdown>
      </div>
    </div>
  )
}

/** 思维链默认展开（Phase A：可预览）；仍可手动收起。 */
function ReasoningPart({ text }: { text: string }): React.ReactElement {
  const [open, setOpen] = useState(true)
  return (
    <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-2)]/40">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-2xs text-[var(--color-muted)] transition-colors hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]"
      >
        <ChevronRight size={12} className={`shrink-0 ${open ? 'rotate-90' : ''} transition-transform`} />
        <Brain size={12} className="shrink-0" />
        思考过程
        <span className="chip ml-auto h-[18px] px-1.5 text-2xs">{text.length} 字</span>
      </button>
      {open && (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-[var(--color-border)] bg-[var(--color-canvas)] px-3 py-2 font-mono text-xs leading-relaxed text-[var(--color-muted)]">
          {text}
        </pre>
      )}
    </div>
  )
}

/** 工具调用状态 → 标签样式（文案保持不变：端到端自测按文字断言这些状态）。 */
const TOOL_STATE_CHIP: Record<string, string> = {
  pending: 'chip',
  'awaiting-approval': 'chip chip-warn',
  running: 'chip chip-accent',
  succeeded: 'chip chip-ok',
  failed: 'chip chip-danger',
  denied: 'chip chip-danger'
}

function ToolCallCard({
  part,
  compact
}: {
  part: Extract<MessagePart, { kind: 'tool-call' }>
  compact?: boolean
}): React.ReactElement {
  const [open, setOpen] = useState(true)

  const statusView = {
    pending: { icon: <Loader2 size={11} className="animate-spin" />, text: '等待中', color: 'var(--color-muted)' },
    'awaiting-approval': { icon: <ShieldAlert size={11} />, text: '等待授权', color: 'var(--color-warn)' },
    running: { icon: <Loader2 size={11} className="animate-spin" />, text: '执行中', color: 'var(--color-accent)' },
    succeeded: { icon: <Check size={11} />, text: '完成', color: 'var(--color-ok)' },
    failed: { icon: <X size={11} />, text: '失败', color: 'var(--color-danger)' },
    denied: { icon: <X size={11} />, text: '已拒绝', color: 'var(--color-danger)' }
  }[part.state]

  const Icon = part.name === 'bash' || part.name === 'powershell' ? Terminal : Wrench

  return (
    <div
      className={`overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] ${compact ? 'turn-step-tool bg-[var(--color-surface)]' : 'bg-[var(--color-surface-2)]/40'}`}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`flex w-full items-center gap-2 text-left transition-colors hover:bg-[var(--color-surface-2)] ${compact ? 'px-2 py-1.5' : 'px-2.5 py-2'}`}
      >
        <ChevronRight size={12} className={`shrink-0 text-[var(--color-muted)] ${open ? 'rotate-90' : ''} transition-transform`} />
        <span
          className="grid h-5 w-5 shrink-0 place-items-center rounded-[var(--radius-xs)]"
          style={{ background: 'var(--color-surface-3)', color: statusView.color }}
        >
          <Icon size={12} />
        </span>
        <span className="truncate font-mono text-xs text-[var(--color-ink)]">{part.name}</span>
        <span className={`${TOOL_STATE_CHIP[part.state] ?? 'chip'} ml-auto h-[18px] shrink-0 px-1.5 text-2xs`}>
          {statusView.icon}
          {statusView.text}
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5">
          <Field label="参数" value={part.args} />
          {toolDiff(part.result) ? (
            <div>
              <p className="mb-1 text-2xs font-medium uppercase tracking-wide text-[var(--color-muted)]">改动</p>
              <DiffView diff={toolDiff(part.result) as string} />
            </div>
          ) : (
            part.result !== undefined && <Field label="结果" value={part.result} />
          )}
          {part.error && (
            <div>
              <p className="mb-1 text-2xs font-medium uppercase tracking-wide text-[var(--color-muted)]">错误</p>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-[var(--radius-sm)] border border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)] p-2 font-mono text-xs text-[var(--color-danger)]">
                {part.error}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * 从工具结果里取差异。
 *
 * pi 的 `edit` 工具在 `details.diff` 里给了一份现成的展示用 diff —— 直接用它，
 * 而不是让 UI 自己重新算一遍：重算就要把 pi 的编辑语义（模糊匹配、行尾处理）
 * 在渲染层再实现一次，必然会与真实改动不一致。
 */
function toolDiff(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined
  const details = (result as { details?: unknown }).details
  if (!details || typeof details !== 'object') return undefined
  const diff = (details as { diff?: unknown }).diff
  return typeof diff === 'string' && diff.trim() ? diff : undefined
}

function Field({ label, value }: { label: string; value: unknown }): React.ReactElement {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }
  return (
    <div>
      <p className="mb-1 text-2xs font-medium uppercase tracking-wide text-[var(--color-muted)]">{label}</p>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-canvas)] p-2 font-mono text-xs leading-relaxed">
        {text}
      </pre>
    </div>
  )
}

/**
 * 审批卡片。
 *
 * 这是整个 UI 里最需要「不能忽略」的元素：agent 此刻被阻塞着等它，
 * 用户不点就永远没有下一步。所以用**左侧色条 + 明确的三档选项**，
 * 并在视觉层级上压过普通工具卡（更亮的边框、更大的内边距）。
 *
 * 文案一个字都不能动：端到端自测按文字点击这三个按钮、并按文字断言结果
 * （「仅允许这一次」「本会话内始终允许（相同参数）」「拒绝」「已处理」）。
 */
function ApprovalCard({
  part,
  onDecide,
  compact
}: {
  part: Extract<MessagePart, { kind: 'approval' }>
  onDecide?: (approvalId: string, decision: ApprovalDecision) => void
  compact?: boolean
}): React.ReactElement {
  const decided = Boolean(part.decision)
  const tone = part.danger ? 'var(--color-danger)' : 'var(--color-warn)'

  /**
   * 倒计时。
   *
   * 起点是**这张卡片出现的那一刻**（事件里没有带请求时间），所以它与主机的真实截止时间
   * 只差一个渲染延迟 —— 够用，但不假装精确到毫秒（原因写在 lib/approval-timer.ts 里）。
   *
   * 只在「还没裁决」时走计时器：裁决之后这个数字就没有意义了，留着只会白耗一个定时器。
   */
  const [now, setNow] = useState(() => Date.now())
  const appearedAt = useRef(Date.now())
  useEffect(() => {
    if (decided) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [decided])
  const timer = approvalTimer(appearedAt.current, now)

  return (
    <div
      className={`overflow-hidden rounded-[var(--radius-lg)] border ${compact ? 'turn-step-approval' : ''}`}
      style={{
        borderColor: `color-mix(in oklch, ${tone} 55%, transparent)`,
        background: part.danger ? 'var(--color-danger-soft)' : 'var(--color-warn-soft)',
        boxShadow: `inset 3px 0 0 0 ${tone}`
      }}
    >
      <div className="flex items-center gap-2 px-3.5 pt-3" style={{ color: tone }}>
        <ShieldAlert size={15} className="shrink-0" />
        <span className="text-ui font-semibold">{part.danger ? '危险操作，需要确认' : '需要你确认'}</span>
        <span className="chip ml-auto h-[18px] shrink-0 px-1.5 font-mono text-2xs">{part.toolName}</span>
      </div>

      {part.danger && (
        <p className="mt-1.5 px-3.5 text-xs text-[var(--color-ink-soft)]">
          命中危险模式：<strong>{part.danger}</strong>
          <span className="text-[var(--color-muted)]">
            {' '}
            —— 这类操作即使权限模式设为「自动放行」也会强制询问。
          </span>
        </p>
      )}

      <div className="px-3.5 pb-3.5 pt-2">
        {part.previewDiff ? (
          <div>
            <p className="mb-1 text-2xs font-medium uppercase tracking-wide text-[var(--color-muted)]">
              将要改动的内容
            </p>
            <DiffView diff={part.previewDiff} />
          </div>
        ) : (
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-canvas)] p-2 font-mono text-xs">
            {stringify(part.args)}
          </pre>
        )}

        {/*
          倒计时与「超时会怎样」。
          这是这一版补的缺口：卡片原来只写「等着你点」，从没说过不点会怎样 ——
          而主机侧 5 分钟后会按**拒绝**处理。没有出口的等待是要避免的失败。
        */}
        <p
          className="mt-2.5 text-2xs"
          style={{ color: decided ? 'var(--color-muted)' : timer.expired ? 'var(--color-danger)' : 'var(--color-muted)' }}
        >
          {decided
            ? part.decision === 'deny'
              ? '你拒绝了这一步：agent 会收到拒绝原因，然后继续做剩下的部分'
              : '按你授予的范围执行；参数不同的调用会重新询问'
            : timer.text}
        </p>

        {decided ? (
          <p className="mt-2.5 text-xs text-[var(--color-muted)]">
            {/*
              「已处理」的措辞必须和**实际授予的范围**一致。
              见下面那个按钮的说明：白名单是按「工具 + 完全相同的参数」记的，
              写「本会话始终允许」会让人以为「这个工具以后都不问了」。
            */}
            已处理：
            {part.decision === 'deny'
              ? '拒绝'
              : part.decision === 'allow-always'
                ? '始终允许此操作（参数相同的调用不再询问）'
                : '仅允许这一次'}
          </p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onDecide?.(part.approvalId, 'allow-once')}
              className="btn btn-primary h-8"
            >
              仅允许这一次
            </button>
            <button
              type="button"
              onClick={() => onDecide?.(part.approvalId, 'allow-always')}
              className="btn btn-outline h-8"
              /**
               * ⚠️ 文案必须说清**范围**，因为这个按钮的承诺比它原来写的窄得多。
               *
               * 白名单的键是 `工具名 + JSON.stringify(参数)`（见 agent-host 的
               * `approvalFingerprint`），也就是说：**参数只要有一点不同就会再问一次**。
               * 而写文件几乎每次内容都不一样 —— 原来那句「本会话始终允许」等于在承诺
               * 「这个工具以后别问了」，用户点完立刻又被问一次，只会以为按钮坏了。
               *
               * 这里选择**把文案改准**，而不是把范围放宽：
               *  - 放宽到「同一工具」对 `bash` 是危险的（一次点击 = 本会话内所有命令放行）；
               *  - 放宽到「同一文件」对 write/edit 是合理且有用的，但那需要按路径取键，
               *    而且取不到路径时必须**回落到精确参数**（绝不能回落到「全部放行」）。
               *    那是一次权限边界的改动，值得单独做，不该顺手塞进来。
               */
              title="同一工具、完全相同参数的调用，本会话内不再询问；参数不同会重新询问"
            >
              本会话内始终允许（相同参数）
            </button>
            <button
              type="button"
              onClick={() => onDecide?.(part.approvalId, 'deny')}
              className="btn h-8 border border-[var(--color-danger)]/50 text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]"
            >
              拒绝
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function ErrorPart({ message }: { message: string }): React.ReactElement {
  return (
    <div className="flex items-start gap-2 rounded-[var(--radius-md)] border border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)] p-3 text-ui">
      <AlertTriangle size={15} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
      <span className="whitespace-pre-wrap">{message}</span>
    </div>
  )
}

function stringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
