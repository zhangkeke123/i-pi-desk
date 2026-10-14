/**
 * SessionPreviewRail 悬停 tip 的垂直定位。
 *
 * tip 必须锚在**当前悬停刻度**旁（默认右侧），不能写死 top。
 * 返回给 `position:absolute; transform:translateY(-50%)` 用的 `top`（相对 rail）。
 */

/** 刻度中心相对 rail 顶边的距离（px）。 */
export function tickCenterYInRail(tick: DOMRect, rail: DOMRect): number {
  return tick.top - rail.top + tick.height / 2
}

/**
 * 算出 tip 的 CSS `top`（配合 translateY(-50%) 垂直居中对齐刻度）。
 * 若 tip 会上下出轨，夹紧到轨内；刻度本身始终是对齐目标。
 */
export function sessionRailPreviewTop(opts: {
  tickCenterY: number
  previewHeight: number
  railHeight: number
}): number {
  const half = Math.max(0, opts.previewHeight) / 2
  const railHeight = Math.max(0, opts.railHeight)
  if (railHeight <= 0) return Math.max(0, opts.tickCenterY)

  // tip 比轨还高：只能尽量居中，避免负数或飞出
  if (opts.previewHeight >= railHeight) return railHeight / 2

  const minTop = half
  const maxTop = railHeight - half
  return Math.min(Math.max(opts.tickCenterY, minTop), maxTop)
}
