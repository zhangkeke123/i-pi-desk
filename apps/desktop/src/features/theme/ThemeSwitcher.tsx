import { useEffect, useRef, useState } from 'react'
import { Check, Monitor, Palette } from 'lucide-react'
import { useAppStore } from '../../stores/app-store.js'
import { THEMES, resolveTheme, systemThemeId, themeMeta, type ThemeId } from '../../lib/theme.js'
import { useThemePreference } from './use-theme.js'
import type { ThemePreference } from '@i-pi-desk/shared'

/**
 * 主题预览色块：底色 + 面板 + 强调。
 *
 * 三个点而不是一张缩略图 —— 缩略图要么写死（与真实样式漂移），
 * 要么得截图（构建期做不到）。三个语义色足以让人分辨。
 */
function Swatch({ colors, active }: { colors: readonly [string, string, string]; active: boolean }): React.ReactElement {
  return (
    <span
      aria-hidden
      className="flex h-4 w-7 shrink-0 items-center overflow-hidden rounded-[var(--radius-xs)] border"
      style={{
        borderColor: active ? 'var(--color-accent)' : 'var(--color-border)',
        background: colors[0]
      }}
    >
      <span className="h-full w-1/3" style={{ background: colors[1] }} />
      <span className="ml-auto mr-[3px] h-2 w-2 rounded-full" style={{ background: colors[2] }} />
    </span>
  )
}

function Row({
  label,
  hint,
  colors,
  active,
  onSelect
}: {
  label: string
  hint: string
  colors: readonly [string, string, string]
  active: boolean
  onSelect: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      onClick={onSelect}
      className="flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2 py-1.5 text-left transition-colors hover:bg-[var(--color-surface-2)]"
      style={active ? { background: 'var(--color-accent-soft)' } : undefined}
    >
      <Swatch colors={colors} active={active} />
      <span className="min-w-0 flex-1">
        <span
          className="block truncate text-[12.5px] font-medium"
          style={{ color: active ? 'var(--color-accent)' : 'var(--color-ink)' }}
        >
          {label}
        </span>
        <span className="block truncate text-[11px] text-[var(--color-muted)]">{hint}</span>
      </span>
      {active && <Check size={13} className="shrink-0 text-[var(--color-accent)]" />}
    </button>
  )
}

/**
 * 顶栏的主题切换器。
 *
 * 交互取舍：**不加全屏遮罩**用于「点外面关闭」。
 * E2E 里用 `div.fixed.inset-0` 定位对话框遮罩，再加一个同类元素会污染那条断言
 * （选择器只看类名，不看是谁的）。所以用 document 级 pointerdown + ref 判断。
 */
export function ThemeSwitcher(): React.ReactElement {
  const preference = useThemePreference()
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const select = (next: ThemePreference): void => {
    setOpen(false)
    void updateSettings({ theme: next })
  }

  const current = themeMeta(resolveTheme(preference))
  const systemNow = themeMeta(systemThemeId())

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        className="icon-btn"
        title={`主题：${preference === 'system' ? `跟随系统（当前 ${systemNow.label}）` : current.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-active={open ? 'true' : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <Palette size={15} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="选择主题"
          className="absolute right-0 top-8 z-50 w-64 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5 shadow-[var(--shadow-lg)]"
        >
          <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted)]">
            主题
          </div>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={preference === 'system'}
            onClick={() => select('system')}
            className="flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2 py-1.5 text-left transition-colors hover:bg-[var(--color-surface-2)]"
            style={preference === 'system' ? { background: 'var(--color-accent-soft)' } : undefined}
          >
            <Monitor size={14} className={preference === 'system' ? 'text-[var(--color-accent)]' : 'text-[var(--color-muted)]'} />
            <span className="min-w-0 flex-1">
              <span
                className="block text-[12.5px] font-medium"
                style={{ color: preference === 'system' ? 'var(--color-accent)' : 'var(--color-ink)' }}
              >
                跟随系统
              </span>
              <span className="block text-[11px] text-[var(--color-muted)]">当前会解析为 {systemNow.label}</span>
            </span>
            {preference === 'system' && <Check size={13} className="shrink-0 text-[var(--color-accent)]" />}
          </button>

          <div className="my-1 h-px bg-[var(--color-border)]" />

          {THEMES.map((theme: (typeof THEMES)[number]) => (
            <Row
              key={theme.id}
              label={`${theme.label}${theme.kind === 'light' ? '（浅色）' : ''}`}
              hint={theme.hint}
              colors={theme.swatch}
              active={preference === theme.id}
              onSelect={() => select(theme.id)}
            />
          ))}

          <div className="mt-1 border-t border-[var(--color-border)] px-2 pt-1.5 text-[11px] text-[var(--color-muted)]">
            主题存在应用设置里，重启后保持
          </div>
        </div>
      )}
    </div>
  )
}

/** 给设置面板用的内联版本：一排卡片，点一下即切换。 */
export function ThemeGrid(): React.ReactElement {
  const preference = useThemePreference()
  const updateSettings = useAppStore((s) => s.updateSettings)
  const activeId: ThemeId | 'system' = preference === 'system' ? 'system' : resolveTheme(preference)

  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        onClick={() => void updateSettings({ theme: 'system' })}
        aria-pressed={preference === 'system'}
        className="card flex w-[132px] flex-col gap-1.5 p-2 text-left transition-colors hover:border-[var(--color-border-strong)]"
        style={preference === 'system' ? { borderColor: 'var(--color-accent)', background: 'var(--color-accent-soft)' } : undefined}
      >
        <span className="flex items-center gap-2 text-[12.5px] font-medium">
          <Monitor size={13} />
          跟随系统
        </span>
        <span className="text-[11px] text-[var(--color-muted)]">按系统亮暗自动切换</span>
      </button>
      {THEMES.map((theme) => {
        const active = activeId === theme.id && preference !== 'system'
        return (
          <button
            key={theme.id}
            type="button"
            onClick={() => void updateSettings({ theme: theme.id })}
            aria-pressed={active}
            className="card flex w-[132px] flex-col gap-1.5 p-2 text-left transition-colors hover:border-[var(--color-border-strong)]"
            style={active ? { borderColor: 'var(--color-accent)', background: 'var(--color-accent-soft)' } : undefined}
          >
            <span className="flex items-center gap-2">
              <Swatch colors={theme.swatch} active={active} />
              <span className="text-[12.5px] font-medium">{theme.label}</span>
            </span>
            <span className="text-[11px] leading-snug text-[var(--color-muted)]">{theme.hint}</span>
          </button>
        )
      })}
    </div>
  )
}
