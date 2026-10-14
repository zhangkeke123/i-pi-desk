import { useCallback, useState } from 'react'
import type { ChatMessage } from '@i-pi-desk/shared'
import { messageExcerpt, messageRoleLabel } from '../../lib/message-preview.js'

/**
 * 消息行左侧锚点 + 悬停预览卡。
 *
 * 对标 PI-Desktop：短横线把手 → 悬停出小卡片（角色标题 + 摘要）；
 * 点击锚点或卡片 → scrollIntoView 到该消息。不提供 Edit（产品尚无消息编辑）。
 */
export function MessagePreviewAnchor({
  message,
  children
}: {
  message: Pick<ChatMessage, 'id' | 'role' | 'parts'>
  children: React.ReactNode
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  const title = messageRoleLabel(message.role)
  const excerpt = messageExcerpt(message.parts)
  const anchorId = `msg-${message.id}`

  const scrollToSelf = useCallback(() => {
    const node = document.getElementById(anchorId)
    node?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [anchorId])

  return (
    <div
      id={anchorId}
      data-testid="message-row"
      data-message-id={message.id}
      className="msg-row"
      onMouseLeave={() => setOpen(false)}
    >
      <div className="msg-row__gutter">
        <button
          type="button"
          data-testid="message-anchor"
          className={`msg-anchor${open ? ' msg-anchor--open' : ''}`}
          aria-label={`预览${title}`}
          title={title}
          onMouseEnter={() => setOpen(true)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onClick={scrollToSelf}
        >
          <span className="msg-anchor__ticks" aria-hidden>
            <span className="msg-anchor__tick" />
            <span className="msg-anchor__tick" />
            <span className="msg-anchor__tick" />
          </span>
        </button>

        {open && (
          <div
            className="msg-preview"
            data-testid="message-preview"
            role="tooltip"
            onMouseEnter={() => setOpen(true)}
            onClick={scrollToSelf}
          >
            <div className="msg-preview__rail" aria-hidden />
            <div className="msg-preview__card">
              <p className="msg-preview__title">{title}</p>
              <p className="msg-preview__body">{excerpt}</p>
              <span className="msg-preview__action">定位</span>
            </div>
          </div>
        )}
      </div>

      <div className="msg-row__body">{children}</div>
    </div>
  )
}
