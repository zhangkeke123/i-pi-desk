import { displayKeys, shortcutsByGroup } from '../../lib/shortcuts.js'

/**
 * 键盘地图（`?` 或从快速启动面板打开）。
 *
 * 内容**直接来自 `lib/shortcuts.ts`**，不在这里手写第二份 ——
 * 否则「表里改了、地图没改」这种漂移几乎必然发生，而用户查到的就是错的。
 *
 * 面板类快捷键的 tooltip 也来自同一张表（见 App.tsx 的 `tooltipWithShortcut`）。
 */
export function KeyboardMap({ open, onClose }: { open: boolean; onClose: () => void }): React.ReactElement | null {
  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-[var(--color-overlay)] px-4 pt-[10vh] backdrop-blur-[2px]"
      onClick={onClose}
      data-testid="keyboard-map-backdrop"
    >
      <div
        className="w-full max-w-2xl overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-lg)]"
        onClick={(event) => event.stopPropagation()}
        data-testid="keyboard-map"
      >
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-3">
          <span className="text-ui font-semibold">键盘快捷键</span>
          <span className="text-2xs text-[var(--color-muted)]">macOS 上 Ctrl 即 Cmd</span>
          <button type="button" onClick={onClose} className="btn ml-auto h-6 px-2 text-2xs">
            关闭
          </button>
        </div>

        <div className="grid gap-x-8 gap-y-4 p-4 sm:grid-cols-2">
          {shortcutsByGroup().map((entry) => (
            <div key={entry.group}>
              <p className="mb-1.5 text-2xs uppercase tracking-wide text-[var(--color-muted)]">{entry.group}</p>
              {entry.items.map((shortcut) => (
                <div
                  key={shortcut.id}
                  className="flex items-center gap-3 border-b border-[var(--color-border)] py-1.5 last:border-b-0"
                >
                  <span className="min-w-0 flex-1 text-xs text-[var(--color-ink-soft)]">{shortcut.label}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    {displayKeys(shortcut.keys)
                      .split(' + ')
                      .map((part) => (
                        <kbd key={part} className="kbd">
                          {part}
                        </kbd>
                      ))}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>

        <p className="border-t border-[var(--color-border)] px-4 py-2.5 text-2xs text-[var(--color-muted)]">
          面板与设置里的入口都有快捷键，鼠标悬停时也会显示在提示里。
        </p>
      </div>
    </div>
  )
}
