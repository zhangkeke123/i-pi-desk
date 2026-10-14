/**
 * 消息左侧悬浮预览：从 parts 抽摘要、角色标题。
 *
 * 纯函数 —— 浮层文案不该依赖 DOM，边界（空文本、只剩工具调用、截断）用单测钉住。
 */
import type { MessagePart, MessageRole } from '@i-pi-desk/shared'

/** 预览正文默认字数上限（超出用省略号）。 */
export const MESSAGE_PREVIEW_MAX = 100

/** 角色 → 浮层标题（对标 PI-Desktop：「助手消息」/「用户消息」）。 */
export function messageRoleLabel(role: MessageRole): string {
  if (role === 'user') return '用户消息'
  if (role === 'assistant') return '助手消息'
  return '系统消息'
}

/**
 * 从消息 parts 抽一段可读摘要。
 *
 * 优先拼所有 text part；没有正文时退到工具调用数 / 思考过程 / 错误信息，
 * 避免浮层空白。空白与换行压成单空格，方便单行预览。
 */
export function messageExcerpt(parts: MessagePart[], maxLen = MESSAGE_PREVIEW_MAX): string {
  const limit = Number.isFinite(maxLen) && maxLen > 0 ? maxLen : MESSAGE_PREVIEW_MAX

  const texts = parts
    .filter((part): part is Extract<MessagePart, { kind: 'text' }> => part.kind === 'text')
    .map((part) => part.text.trim())
    .filter((text) => text.length > 0)

  if (texts.length > 0) {
    return clip(texts.join('\n').replace(/\s+/g, ' ').trim(), limit)
  }

  const toolCount = parts.filter((part) => part.kind === 'tool-call').length
  if (toolCount > 0) return `${toolCount} 个工具调用`

  const reasoning = parts.find((part) => part.kind === 'reasoning')
  if (reasoning && reasoning.kind === 'reasoning' && reasoning.text.trim()) {
    return clip(reasoning.text.replace(/\s+/g, ' ').trim(), limit)
  }

  const error = parts.find((part) => part.kind === 'error')
  if (error && error.kind === 'error' && error.message.trim()) {
    return clip(error.message.replace(/\s+/g, ' ').trim(), limit)
  }

  return '（无文本内容）'
}

function clip(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  if (maxLen <= 1) return '…'
  return `${text.slice(0, maxLen - 1)}…`
}
