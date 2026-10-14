/**
 * 启动闪屏混合进度：真阶段给出目标，显示值向目标缓动，永不回退。
 */

export const BOOT_MIN_MS = 800

/** 阶段目标（与设计文档一致）。 */
export const BOOT_TARGETS = {
  start: 15,
  fetching: 40,
  hydrated: 75,
  ready: 90,
  done: 100
} as const

/**
 * 每帧把 `current` 向 `target` 推近。
 * - 不回退
 * - 距目标很近时直接贴齐，避免长时间停在 99.x
 */
export function approachBootProgress(
  current: number,
  target: number,
  /** 0–1，越大越快；默认偏稳。 */
  easing = 0.12
): number {
  const from = clampPercent(current)
  const to = clampPercent(Math.max(from, target))
  if (to <= from) return from
  const next = from + (to - from) * easing
  if (to - next < 0.35) return to
  return clampPercent(next)
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(100, Math.max(1, value))
}

/** 是否可以冲刺到 100%（boot 完成且最短展示已满足）。 */
export function canFinishSplash(booted: boolean, elapsedMs: number, minMs = BOOT_MIN_MS): boolean {
  return booted && elapsedMs >= minMs
}

export function formatBootPercent(value: number): string {
  return `${Math.round(clampPercent(value))}%`
}
