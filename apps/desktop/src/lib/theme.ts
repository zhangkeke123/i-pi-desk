/**
 * 主题注册表与切换。
 *
 * ## 为什么单独一个模块
 *
 * 主题散在两处：**色值**在 `styles.css` 的 `:root[data-theme='…']` 段里，
 * **元信息**（名字、亮暗、预览色、说明）在这里。两边必须一一对应 ——
 * `verify:doc-claims` 有一条断言专门比对「CSS 里的主题 id」与「这里的 id」，
 * 加了主题忘了另一边会红。
 *
 * ## 为什么持久化不用 localStorage
 *
 * `AppSettings` 里本来就有 `theme` 字段（历史遗留：当年只有 light/dark 两值，
 * 而且**从来没有人写过它** —— 浅色主题那段 CSS 是死代码）。偏好存在应用设置里、
 * 由主进程落盘，符合这个应用「渲染层不碰磁盘」的分工。
 *
 * 代价是启动时有一小段「还不知道用什么主题」的窗口期。处理办法不是内联脚本
 * （生产档 CSP 禁止内联脚本），而是**主进程按主题的亮暗预置窗口底色**
 * （`electron/main/window.ts`）—— 底色本来就对，就不会看到闪白。
 */

import type { ThemePreference } from '@i-pi-desk/shared'

export type ThemeId = 'midnight' | 'graphite' | 'daylight' | 'paper' | 'contrast'

export interface ThemeMeta {
  id: ThemeId
  label: string
  /** 亮暗：给 `color-scheme` 与主进程预置底色用。 */
  kind: 'light' | 'dark'
  hint: string
  /** 预览色：底色 / 面板 / 强调，用于选择器里的小色块。 */
  swatch: [string, string, string]
}

export const THEMES: readonly ThemeMeta[] = [
  {
    id: 'daylight',
    label: 'Daylight',
    kind: 'light',
    hint: '清新浅灰青，默认主体',
    swatch: ['#f3f5f8', '#ffffff', '#2f8fa3']
  },
  {
    id: 'midnight',
    label: 'Midnight',
    kind: 'dark',
    hint: '冷中性深灰，少色相、一张青强调',
    swatch: ['#12141a', '#1a1d24', '#5eb0c4']
  },
  {
    id: 'graphite',
    label: 'Graphite',
    kind: 'dark',
    hint: '中性深灰 + 苔绿，最紧凑',
    swatch: ['#141414', '#1f1f1f', '#7a9e78']
  },
  {
    id: 'paper',
    label: 'Paper',
    kind: 'light',
    hint: '极淡纸感，阅读用（已去米黄铜棕）',
    swatch: ['#f5f4f0', '#fcfcfa', '#4a8f7a']
  },
  {
    id: 'contrast',
    label: 'Contrast',
    kind: 'dark',
    hint: '高对比（无障碍取向）：纯黑底、纯白字、亮琥珀强调',
    swatch: ['#000000', '#171717', '#ffc247']
  }
] as const

export const THEME_IDS: readonly ThemeId[] = THEMES.map((theme) => theme.id)

const PREFERS_DARK = '(prefers-color-scheme: dark)'

/** 旧设置里可能存着的两值（当年的死代码），映射到现在的具体主题。 */
const LEGACY: Record<string, ThemeId> = { light: 'daylight', dark: 'midnight' }

export function systemThemeId(): ThemeId {
  try {
    return window.matchMedia(PREFERS_DARK).matches ? 'midnight' : 'daylight'
  } catch {
    return 'daylight'
  }
}

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value)
}

/** 把偏好解析成**具体**主题：`system` 与旧值都在这里收敛。 */
export function resolveTheme(preference: ThemePreference | string | undefined): ThemeId {
  if (preference === undefined || preference === 'system') return systemThemeId()
  if (isThemeId(preference)) return preference
  return LEGACY[preference] ?? 'daylight'
}

export function themeMeta(id: ThemeId): ThemeMeta {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0]
}

/**
 * 把主题写到 `<html>` 上。
 *
 * 同时设 `color-scheme`：原生控件（滚动条、`<input type=date>`、下拉）要靠它变，
 * 只换自定义变量会出现「面板是浅色、滚动条还是深色」这种割裂。
 */
export function applyTheme(id: ThemeId): void {
  const root = document.documentElement
  root.dataset.theme = id
  root.style.colorScheme = themeMeta(id).kind
}

/** 亮暗对应的窗口底色（与主进程 `window.ts` 里那份保持一致）。 */
export const BACKGROUND_BY_KIND: Record<'light' | 'dark', string> = {
  dark: '#12141a',
  light: '#f3f5f8'
}
