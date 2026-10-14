/**
 * 墨点脉冲 Logo（方案 1）。
 * - animated：闪屏用，细环呼吸
 * - 静态：小尺寸 / 降级，只画实心点 + 静止环
 */
export function InkLogo({
  size = 56,
  animated = true,
  className = ''
}: {
  size?: number
  animated?: boolean
  className?: string
}): React.ReactElement {
  return (
    <svg
      className={`ink-logo ${animated ? 'ink-logo--pulse' : ''} ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden
      data-testid="ink-logo"
      data-animated={animated ? 'true' : 'false'}
    >
      <circle
        className="ink-logo__ring"
        cx="32"
        cy="32"
        r="26"
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="1.5"
        opacity="0.35"
      />
      <circle className="ink-logo__dot" cx="32" cy="32" r="14" fill="var(--color-accent)" />
      <circle cx="27" cy="27" r="4" fill="color-mix(in oklch, white 55%, transparent)" />
    </svg>
  )
}
