import type { AssistantMessage, Message, UserMessage } from '@earendil-works/pi-ai'
import type { ChatMessage } from '@i-pi-desk/shared'

/**
 * 把**我们自己持久化的**对话历史转成内核能接受的消息，用于「重启后恢复记忆」。
 *
 * ## 为什么需要这个
 *
 * 会话消息由主进程落盘（`<userData>/sessions/<id>.json`），而内核的
 * `SessionManager` 是 `inMemory` 的。于是应用一重启就会出现一个很别扭的状态：
 *
 *   **界面上历史都在，模型却完全不记得。**
 *
 * 用户打开昨天的会话追问一句「继续改刚才那个函数」，看到的是一句莫名其妙的
 * 「哪个函数？」。这不是边缘情况，而是每天第一次打开应用必然发生的事。
 *
 * 修法是把落盘的历史**喂回内核**。主进程仍然是持久化的唯一权威
 * （见 `docs/ARCHITECTURE.md` §5），内核只拿到一份用于重建上下文的副本。
 *
 * ## 只保留文本，丢掉工具调用
 *
 * 这是刻意的，而且是这里最重要的一个决定。
 *
 * 工具调用与工具结果在多数厂商的协议里是**成对**的：有 `tool_calls` 就必须有
 * 对应的 `tool` 结果消息，否则请求会被直接拒绝（400），而且不同厂商的报错
 * 各不相同、很难一句「不合法」说清。历史里的配对关系一旦被截断（超过上限、
 * 或某条消息在崩溃中丢了），重放过去就会**让整个会话再也发不出请求**。
 *
 * 而用户真正在意的是「模型记得我们聊过什么」。助手消息的正文通常已经概括了
 * 它做过什么（「我已经把 xxx 改成 yyy」），所以只重放文本既能恢复记忆，
 * 又不会引入一整类协议配对问题。
 *
 * 代价写清楚：模型不会记得**工具调用的原始细节**（具体 diff、命令输出）。
 * 需要那些细节时，它应当重新读文件 —— 这也符合「文件和磁盘才是真相」的原则。
 */

export interface HistorySeedOptions {
  /** 当前 provider 的 pi 标识（用于填 assistant 消息的 `provider` 字段）。 */
  providerId: string
  /** API 风格（openai-completions / anthropic-messages…）。 */
  api: string
  /** 当前模型 id。 */
  model: string
  /** 最多重放多少条消息（从最近往前取）。 */
  maxMessages?: number
  /** 最多重放多少字符（从最近往前累计）。 */
  maxChars?: number
}

/** 默认上限：足够恢复「我们在聊什么」，又不会让每次冷启动的第一轮请求变得很贵。 */
export const DEFAULT_MAX_HISTORY_MESSAGES = 40
export const DEFAULT_MAX_HISTORY_CHARS = 60_000

/**
 * 转换并裁剪历史。
 *
 * 裁剪是**从最近往前**保留、然后反转 —— 直接 `slice(-N)` 也是这个效果，
 * 但字符预算必须自己累计，所以还是显式写一遍更清楚。
 */
export function toPiHistory(messages: ChatMessage[], options: HistorySeedOptions): Message[] {
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_HISTORY_MESSAGES
  const maxChars = options.maxChars ?? DEFAULT_MAX_HISTORY_CHARS

  const picked: ChatMessage[] = []
  let chars = 0

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue

    const text = textOf(message)
    if (!text) continue

    // 至少保证最后一条进来，否则「消息本身超预算」会让历史完全为空。
    if (picked.length > 0) {
      if (picked.length >= maxMessages) break
      if (chars + text.length > maxChars) break
    }

    picked.push(message)
    chars += text.length
  }

  picked.reverse()

  const result: Message[] = []
  for (const message of picked) {
    const text = textOf(message)
    const timestamp = timestampOf(message)
    if (message.role === 'user') {
      appendMerged(result, { role: 'user', content: [{ type: 'text', text }], timestamp })
    } else {
      appendMerged(result, assistantMessage(text, options, timestamp))
    }
  }

  /**
   * 历史**不能以 user 结尾**。
   *
   * 总会有「问了但没得到回复」的落盘消息：用户提问后应用被关掉、
   * 或者那一轮因为网络问题失败了（模型端不可达时也不会产生 assistant 消息）。
   * 这种悬挂的 user 消息本身没有信息量 —— 它要问的事用户马上会重新问一遍。
   *
   * 但如果留着它，重放之后紧跟着本次的新提问，就会变成 `user, user`。
   * OpenAI 兼容接口通常容忍，**Anthropic 的 Messages API 会直接 400**
   * 且报错不会告诉你原因。所以宁可丢掉这条悬挂的提问。
   *
   * 全部都是 user（历史里没有一条回复）时结果为空，也正合语义：没什么可记的。
   */
  while (result.length > 0 && result[result.length - 1].role === 'user') {
    result.pop()
  }

  /**
   * 同理，历史**不能以 assistant 开头**。
   *
   * ## 为什么这条很容易漏
   *
   * 裁剪是「从最近往前取」，切断点落在哪条消息上是随机的 —— 落在 assistant 上时，
   * 重放序列就有了一个**没有对应提问的回答**打头。而 Anthropic 的 Messages API
   * 对首条消息有硬要求：**必须是 `user`**，否则 400，报错是
   * `messages: first message must use the "user" role`。
   *
   * 这条不是我推出来的，是**实测 + 查证**得到的：
   *
   *  - 实测：把这种序列喂进 pi 真实的 Anthropic 请求构建（拦下 fetch 看报文），
   *    它**原样发出** `assistant, user, assistant` —— pi 不做任何修正；
   *  - 查证：多个独立项目都在「裁剪/压缩后历史以 assistant 开头」这一场景撞过同一个 400
   *    （lobehub#1601、chatbox#1288、dify#5567、hermes-agent 专门为此加过修补）。
   *
   * 之所以长期没被发现：**假模型是 OpenAI 兼容的，它容忍这种序列**。
   * 只有接真实 Anthropic 端点、且裁剪切断点正好落在 assistant 上时才会炸 ——
   * 一个既间歇、又只在特定厂商上出现的失败。
   *
   * 丢掉它而不是补一条假的 user 提问：那条回答脱离了它回答的问题，本身就是个残片，
   * 补一个用户从没说过的问题只会**伪造对话内容**。宁可少一条上下文。
   */
  if (result.length > 0 && result[0].role === 'assistant') {
    result.shift()
  }

  return result
}

/**
 * 追加一条消息，**合并相邻的同角色消息**。
 *
 * ## 为什么必须合并
 *
 * 上面的转换会丢掉「只有工具调用、没有正文」的 assistant 消息（见文件头）。
 * 丢掉之后，原本是 `user → assistant(工具调用) → user` 的序列会变成
 * `user → user` —— 两条相邻的 user。
 *
 * 这在 OpenAI 兼容接口上通常无碍，但 **Anthropic 的 Messages API 明确要求
 * user / assistant 交替**，相邻同角色会直接返回 400，而且报错信息只说不合法，
 * 不会告诉你「是因为我们重放历史时把回合边界弄丢了」。
 *
 * 合并比「补一条空 assistant」更好：空 assistant 消息本身也可能被拒绝
 * （部分厂商要求 content 非空），而合并只是把同一角色的话拼在一起，语义上完全等价。
 */
function appendMerged(result: Message[], message: Message): void {
  const previous = result[result.length - 1]
  if (!previous || previous.role !== message.role) {
    result.push(message)
    return
  }

  const previousText = contentText(previous.content)
  const nextText = contentText(message.content)
  const merged = previousText ? `${previousText}\n\n${nextText}` : nextText
  // 就地替换：两边的 content 都只可能是文本，所以直接换掉 content 即可，
  // 不必重建整个对象（assistant 的 api/model/usage 等元数据保持原样）。
  ;(previous as { content: unknown }).content = [{ type: 'text', text: merged }]
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text) : ''))
      .join('')
  }
  return ''
}

/**
 * 取一条消息里**可重放的正文**。
 *
 * 只取 `text` 片段：`reasoning` 属于模型的思考过程，重放它没有意义（有些厂商还会
 * 因为不认识的思考块而报错）；`error` 片段是本地状态，不是对话内容。
 */
function textOf(message: ChatMessage): string {
  return message.parts
    .filter((part): part is { kind: 'text'; text: string } => part.kind === 'text')
    .map((part) => part.text)
    .join('')
    .trim()
}

function timestampOf(message: ChatMessage): number {
  const parsed = Date.parse(message.createdAt)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

/**
 * 造一条 assistant 消息。
 *
 * `usage` 填零、`stopReason` 填 `stop`：这两个字段对「重放上下文」没有意义，
 * 但它们在内核的类型里是必填的。填零而不是编造数字，是为了**万一**这些字段
 * 被统计到（例如某个面板汇总历史用量），也不会凭空多出用量。
 */
function assistantMessage(text: string, options: HistorySeedOptions, timestamp: number): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: options.api as AssistantMessage['api'],
    provider: options.providerId as AssistantMessage['provider'],
    model: options.model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop',
    timestamp
  }
}
