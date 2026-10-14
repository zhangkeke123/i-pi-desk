/**
 * 「思考态」要说的话：当前在做什么、做了几步、已经多久。
 *
 * ## 为什么单独一个模块
 *
 * 参考材料里有一条很硬的结论：**一个没有出口的思考态是要避免的头号失败**。
 * 对一个 agent 来说，「在做什么」不是编出来的文案 —— 工具调用事件里本来就有
 * 工具名与参数。这个模块只做一件事：把工具调用翻译成**人话**（「正在读取 src/main.ts」
 * 而不是「tool: read」），以及把已经过去的时间格式化。
 *
 * 翻译规则要可单测：它决定用户看到的第一句话，而这类文案最容易在改动中悄悄退化成
 * 「正在处理…」这种什么都没说的话。
 */

import type { MessagePart } from '@i-pi-desk/shared'

export interface RunStep {
  /** 用于 React key：工具调用 id 或序号。 */
  key: string
  text: string
  state: 'running' | 'done' | 'failed' | 'waiting'
}

/** 从工具参数里取一个短的可读标识（路径 / 命令 / 模式）。 */
function argHint(args: unknown, keys: string[]): string | undefined {
  if (!args || typeof args !== 'object') {
    return typeof args === 'string' ? args.split('\n')[0]?.slice(0, 60) : undefined
  }
  const record = args as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      // 只取最后两段路径 / 第一行命令，避免把整段内容塞进一行。
      const line = value.split('\n')[0]?.trim() ?? ''
      return line.length > 60 ? `${line.slice(0, 57)}…` : line
    }
  }
  return undefined
}

/**
 * 工具名 → 人话。
 *
 * 措辞规则：**动词 + 宾语**，宾语尽量是用户认得的东西（路径、命令、模式）。
 * 认不出来的工具就在句子里带上工具名 —— 那也比「正在处理」有用。
 */
export function describeToolCall(name: string, args: unknown): string {
  switch (name) {
    case 'read':
    case 'read_file': {
      const path = argHint(args, ['path', 'file', 'filePath'])
      return path ? `正在读取 ${path}` : '正在读取文件'
    }
    case 'write':
    case 'write_file': {
      const path = argHint(args, ['path', 'file', 'filePath'])
      return path ? `正在写入 ${path}` : '正在写入文件'
    }
    case 'edit': {
      const path = argHint(args, ['path', 'file', 'filePath'])
      return path ? `正在修改 ${path}` : '正在修改文件'
    }
    case 'grep': {
      const pattern = argHint(args, ['pattern', 'query'])
      return pattern ? `正在搜索 ${pattern}` : '正在搜索代码'
    }
    case 'find':
    case 'glob': {
      const pattern = argHint(args, ['pattern', 'glob'])
      return pattern ? `正在查找 ${pattern}` : '正在查找文件'
    }
    case 'ls':
    case 'list': {
      const path = argHint(args, ['path', 'dir'])
      return path ? `正在列出 ${path}` : '正在列出目录'
    }
    case 'bash':
    case 'powershell':
    case 'shell': {
      const command = argHint(args, ['command', 'cmd', 'script'])
      return command ? `正在运行 ${command}` : '正在运行命令'
    }
    default:
      return `正在调用 ${name}`
  }
}

const STATE_LABEL: Record<string, RunStep['state']> = {
  pending: 'waiting',
  'awaiting-approval': 'waiting',
  running: 'running',
  succeeded: 'done',
  failed: 'failed',
  denied: 'failed'
}

/**
 * 把一条消息里的工具调用按顺序翻译成步骤列表。
 *
 * 只保留最后 `limit` 条：思考态是「现在在干什么」的窗口，不是完整日志
 * （完整日志在工具卡展开后能看到）。
 */
export function describeRunSteps(parts: MessagePart[], limit = 4): RunStep[] {
  const steps: RunStep[] = []
  parts.forEach((part, index) => {
    if (part.kind !== 'tool-call') return
    steps.push({
      key: part.callId || `step-${index}`,
      text: describeToolCall(part.name, part.args),
      state: STATE_LABEL[part.state] ?? 'waiting'
    })
  })
  return steps.slice(-limit)
}

/** `mm:ss`（超过一小时给 `h:mm:ss`）。刻意不用「秒数」：跑十分钟时 601 不如 10:01 好读。 */
export function formatElapsed(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0
  const totalSeconds = Math.floor(safe / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

/**
 * 现在该显示哪一句。
 *
 * 优先级：正在跑的步骤 → 已完成/失败的最后一步 → 还没有步骤（模型在思考）。
 * 最后那种情况返回 `undefined`，由界面显示「正在思考…」——
 * 不在这里编一句话，是因为「还没有工具调用」本身就是事实。
 */
export function currentStepText(steps: RunStep[]): string | undefined {
  if (steps.length === 0) return undefined
  const running = [...steps].reverse().find((step) => step.state === 'running')
  if (running) return running.text
  const waiting = [...steps].reverse().find((step) => step.state === 'waiting')
  if (waiting) return waiting.text
  const last = steps[steps.length - 1]
  return last ? `已完成 ${last.text.replace(/^正在/, '')}` : undefined
}

/**
 * 限额预警。
 *
 * 设计稿 §3.8 的规矩：**在撞墙前提醒**。撞上之后再解释已经晚了 ——
 * 用户会认为「它自己停下来了」，而实际上是他自己设的上限。
 *
 * 阈值取 80%：留出的余量刚好够一次「保存 + 收尾」，而不是在最后一步才喊。
 * 达到 100% 时不走这里（那由停止原因那条通知负责，它说的是「已经停了」）。
 */
export interface LimitWarning {
  used: number
  max: number
  text: string
}

export function limitWarning(usedToolCalls: number, maxSteps: number, threshold = 0.8): LimitWarning | null {
  if (!Number.isFinite(maxSteps) || maxSteps <= 0) return null
  if (usedToolCalls >= maxSteps) return null
  if (usedToolCalls / maxSteps < threshold) return null
  return {
    used: usedToolCalls,
    max: maxSteps,
    text: `本次运行已用 ${usedToolCalls}/${maxSteps} 步，接近上限`
  }
}

/**
 * 撞上上限之后要说的那句话。
 *
 * 必须带**具体数字**（「已用 40/40 步」）与**下一步**：只说「到上限了」，
 * 用户既不知道是哪个上限，也不知道去哪改。
 */
export function maxStepsNotice(used: number, max: number): string {
  return `已达到本次运行的最大步数上限（${used}/${max} 步）。改动都已落盘，历史与文件不会丢；可以在「设置 → 通用 → 单次最大步数」调大后继续。`
}
