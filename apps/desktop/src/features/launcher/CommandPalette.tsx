import { Command } from 'cmdk'
import { useEffect, useState } from 'react'
import type { Session } from '@i-pi-desk/shared'
import { displayKeys, shortcutFor } from '../../lib/shortcuts.js'

/**
 * 快速启动面板（`Ctrl+K`）。
 *
 * ## 为什么用 cmdk 而不是自己撸
 *
 * 要的东西全是**行为**而不是样式：↑↓ 在列表里移动、输入即过滤（按中文也能筛）、
 * 回车执行、Esc 关闭、以及一整套 `aria-*`（这是它真正难自制的部分 ——
 * 自己写的列表几乎总是把「当前项」只表达成背景色）。cmdk 是这套交互的事实标准，
 * MIT、82KB、**完全无样式**，所以它不带来任何视觉决定，配色/圆角/字号仍然全走我们的 token。
 *
 * ## 为什么值得做
 *
 * 上游 PI-Desktop 用 `Alt+Space` 做同一件事。它解决的是「功能长了以后，
 * 入口只能藏在角落的图标里」——把「打开某个面板」变成一个键盘动作，
 * 用户不用先找到图标、也不用记住它在哪一侧。
 */

export interface LauncherAction {
  id: string
  label: string
  /** 右侧提示（快捷键或分类）。 */
  hint?: string
  run: () => void
}

export function CommandPalette({
  open,
  onOpenChange,
  actions,
  sessions,
  onSelectSession
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  actions: LauncherAction[]
  sessions: Session[]
  onSelectSession: (sessionId: string) => void
}): React.ReactElement | null {
  const [query, setQuery] = useState('')

  /**
   * 每次打开都从空查询开始。
   *
   * 不清空的话，第二次按 `Ctrl+K` 会看到上次的筛选结果 —— 用户会以为「面板里只有这一项」。
   */
  useEffect(() => {
    if (open) setQuery('')
  }, [open])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-[var(--color-overlay)] px-4 pt-[12vh] backdrop-blur-[2px]"
      // 点遮罩关闭：面板是「随时叫出来、随手关掉」的东西，不该逼用户找关闭按钮。
      onClick={() => onOpenChange(false)}
      data-testid="launcher-backdrop"
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-lg)]"
        onClick={(event) => event.stopPropagation()}
      >
        <Command
          // cmdk 默认按 label 过滤，中文也能筛；`shouldFilter` 保留默认行为。
          className="flex flex-col"
          loop
          data-testid="launcher"
        >
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="搜索面板、会话或设置…"
            className="h-11 w-full border-b border-[var(--color-border)] bg-transparent px-4 text-body outline-none placeholder:text-[var(--color-muted)]"
            data-testid="launcher-input"
          />
          <Command.List className="max-h-[52vh] overflow-y-auto p-2">
            <Command.Empty className="px-3 py-6 text-center text-xs text-[var(--color-muted)]">
              没有匹配的项
            </Command.Empty>

            <Command.Group
              heading="面板与设置"
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-[var(--color-muted)]"
            >
              {actions.map((action) => (
                <LauncherItem
                  key={action.id}
                  value={`${action.label} ${action.id}`}
                  label={action.label}
                  hint={action.hint}
                  onSelect={() => {
                    onOpenChange(false)
                    action.run()
                  }}
                />
              ))}
            </Command.Group>

            {sessions.length > 0 && (
              <Command.Group
                heading="会话"
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-[var(--color-muted)]"
              >
                {sessions.slice(0, 30).map((session) => (
                  <LauncherItem
                    key={session.id}
                    value={`会话 ${session.title}`}
                    label={session.title}
                    hint="会话"
                    onSelect={() => {
                      onOpenChange(false)
                      onSelectSession(session.id)
                    }}
                  />
                ))}
              </Command.Group>
            )}
          </Command.List>

          <div className="flex items-center gap-2 border-t border-[var(--color-border)] px-3 py-2 text-2xs text-[var(--color-muted)]">
            <kbd className="kbd">↑</kbd>
            <kbd className="kbd">↓</kbd> 选择
            <span className="opacity-60">·</span>
            <kbd className="kbd">Enter</kbd> 执行
            <span className="opacity-60">·</span>
            <kbd className="kbd">Esc</kbd> 关闭
          </div>
        </Command>
      </div>
    </div>
  )
}

function LauncherItem({
  value,
  label,
  hint,
  onSelect
}: {
  value: string
  label: string
  hint?: string
  onSelect: () => void
}): React.ReactElement {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 py-2 text-xs text-[var(--color-ink-soft)] data-[selected=true]:bg-[var(--color-accent-soft)] data-[selected=true]:text-[var(--color-accent)]"
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="shrink-0 text-2xs text-[var(--color-muted)]">{hint}</span>}
    </Command.Item>
  )
}

/** 面板里显示的快捷键提示（与键盘地图同源）。 */
export function launcherHintFor(id: string): string {
  return displayKeys(shortcutFor(id).keys)
}
