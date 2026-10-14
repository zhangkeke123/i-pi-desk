import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChatMessage } from '@i-pi-desk/shared'
import { messageExcerpt, messageRoleLabel } from '../../lib/message-preview.js'
import { sessionRailPreviewTop, tickCenterYInRail } from '../../lib/session-rail-preview.js'

/**
 * Session 级左侧预览轨（Phase A / 图 2）。
 *
 * 整条会话共用一根竖轨；tick 对应消息，点击定位，滚动高亮视口内消息。
 * 悬停 tip 锚定当前刻度右侧（垂直对齐刻度中心，出轨时夹紧）。
 * 取代逐条 MessagePreviewAnchor gutter。
 */
export function SessionPreviewRail({
  messages,
  scrollRoot
}: {
  messages: ReadonlyArray<Pick<ChatMessage, 'id' | 'role' | 'parts'>>
  scrollRoot: HTMLElement | null
}): React.ReactElement | null {
  const [activeId, setActiveId] = useState<string | null>(messages[0]?.id ?? null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [previewTop, setPreviewTop] = useState(0)
  const railRef = useRef<HTMLElement | null>(null)
  const previewRef = useRef<HTMLDivElement | null>(null)
  const hoverTickRef = useRef<HTMLElement | null>(null)

  const ids = useMemo(() => messages.map((message) => message.id), [messages])

  useEffect(() => {
    if (!scrollRoot || ids.length === 0) return

    const visible = new Map<string, number>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.getAttribute('data-message-id')
          if (!id) continue
          if (entry.isIntersecting) visible.set(id, entry.intersectionRatio)
          else visible.delete(id)
        }
        let bestId: string | null = null
        let bestRatio = 0
        for (const [id, ratio] of visible) {
          if (ratio >= bestRatio) {
            bestRatio = ratio
            bestId = id
          }
        }
        if (bestId) setActiveId(bestId)
      },
      { root: scrollRoot, threshold: [0.15, 0.35, 0.55, 0.75] }
    )

    for (const id of ids) {
      const node = scrollRoot.querySelector(`[data-message-id="${CSS.escape(id)}"]`)
      if (node) observer.observe(node)
    }
    return () => observer.disconnect()
  }, [scrollRoot, ids])

  useLayoutEffect(() => {
    if (!hoverId) return
    const rail = railRef.current
    const tick = hoverTickRef.current
    const preview = previewRef.current
    if (!rail || !tick) return
    const tickRect = tick.getBoundingClientRect()
    const railRect = rail.getBoundingClientRect()
    const centerY = tickCenterYInRail(tickRect, railRect)
    const previewHeight = preview?.getBoundingClientRect().height ?? 0
    setPreviewTop(
      sessionRailPreviewTop({
        tickCenterY: centerY,
        previewHeight,
        railHeight: railRect.height
      })
    )
  }, [hoverId, messages])

  if (messages.length === 0) return null

  const hoverMessage = hoverId ? messages.find((message) => message.id === hoverId) : undefined

  const anchorToTick = (tickEl: HTMLElement, messageId: string) => {
    hoverTickRef.current = tickEl
    const rail = railRef.current
    if (rail) {
      // 首帧先按刻度中心落点；layout effect 再用实测 tip 高度夹紧
      setPreviewTop(tickCenterYInRail(tickEl.getBoundingClientRect(), rail.getBoundingClientRect()))
    }
    setHoverId(messageId)
  }

  const clearHover = (messageId: string) => {
    setHoverId((prev) => {
      if (prev !== messageId) return prev
      hoverTickRef.current = null
      return null
    })
  }

  return (
    <aside
      ref={railRef}
      className="session-rail"
      data-testid="session-preview-rail"
      aria-label="会话预览"
    >
      <div className="session-rail__track">
        {messages.map((message) => {
          const active = message.id === activeId
          const user = message.role === 'user'
          return (
            <button
              key={message.id}
              type="button"
              className={`session-rail__tick${active ? ' session-rail__tick--active' : ''}${user ? ' session-rail__tick--user' : ''}`}
              title={messageRoleLabel(message.role)}
              aria-label={`定位到${messageRoleLabel(message.role)}`}
              data-testid="session-rail-tick"
              data-active={active ? 'true' : undefined}
              onMouseEnter={(event) => anchorToTick(event.currentTarget, message.id)}
              onMouseLeave={() => clearHover(message.id)}
              onFocus={(event) => anchorToTick(event.currentTarget, message.id)}
              onBlur={() => clearHover(message.id)}
              onClick={() => {
                const node = document.getElementById(`msg-${message.id}`)
                node?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                setActiveId(message.id)
              }}
            />
          )
        })}
      </div>

      {hoverMessage && (
        <div
          ref={previewRef}
          className="session-rail__preview"
          data-testid="session-rail-preview"
          role="tooltip"
          style={{ top: previewTop }}
        >
          <p className="session-rail__preview-title">{messageRoleLabel(hoverMessage.role)}</p>
          <p className="session-rail__preview-body">{messageExcerpt(hoverMessage.parts)}</p>
          <span className="session-rail__preview-action">定位</span>
        </div>
      )}
    </aside>
  )
}
