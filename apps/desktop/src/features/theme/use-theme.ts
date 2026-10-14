import { useEffect, useState } from 'react'
import { useAppStore } from '../../stores/app-store.js'
import { applyTheme, resolveTheme, systemThemeId, type ThemeId } from '../../lib/theme.js'
import type { ThemePreference } from '@i-pi-desk/shared'

export function useThemePreference(): ThemePreference {
  return useAppStore((s) => s.settings?.theme ?? 'system')
}

/**
 * 当前**解析后**的主题 id。
 *
 * 用途是那些「不能靠 CSS 变量自动跟随」的地方 —— 典型是 xterm：
 * 它在 JS 里自己解析颜色字符串，不会读 CSS 变量，所以切主题时必须主动
 * 重设 `term.options.theme`。这类消费者需要知道「主题变了」，而不只是拿到偏好值。
 */
export function useResolvedTheme(): ThemeId {
  const preference = useThemePreference()
  const [systemId, setSystemId] = useState<ThemeId>(() => systemThemeId())

  useEffect(() => {
    if (preference !== 'system') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => setSystemId(systemThemeId())
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [preference])

  return preference === 'system' ? systemId : resolveTheme(preference)
}

/**
 * 把当前主题写到 `<html>` 上，并在「跟随系统」时监听系统亮暗变化。
 *
 * 启动时 `app-store` 也会应用一次（那是设置刚拉回来的时刻）；这里管的是
 * **后续变化**：用户在设置里换了主题、或系统在运行中切了亮暗。
 * 两处都调用同一个 `applyTheme`，不会出现两套规则。
 */
export function useApplyTheme(): void {
  const preference = useThemePreference()

  useEffect(() => {
    applyTheme(resolveTheme(preference))
    if (preference !== 'system') return

    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => applyTheme(resolveTheme('system'))
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [preference])
}
