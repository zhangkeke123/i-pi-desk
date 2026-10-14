/**
 * 快捷键的**单一来源**。
 *
 * ## 为什么要有这个文件
 *
 * 同一个快捷键会出现在三个地方：键盘地图（用户查的地方）、按钮的 tooltip
 * （用户碰巧看到的地方）、以及实际的绑定。三处各写一遍的话，改一处就会漂 ——
 * 而「tooltip 里写的键按下去没反应」是最伤信任的那种不一致。
 *
 * 所以：绑定用这里的 `keys`（交给 react-hotkeys-hook），tooltip 用
 * `tooltipWithShortcut()` 拼，键盘地图直接遍历这张表。**断言也钉在这张表上**
 * （见 scripts/verify-ui-logic.ts）：id 唯一、每个都有说明、没有两个功能抢同一个键。
 *
 * 平台写法统一用 `Ctrl`（macOS 上对应 Cmd，键盘地图里说明一次）。
 */

export interface Shortcut {
  /** 稳定的标识，绑定与断言都用它。 */
  id: string
  /** 展示与绑定用的键（react-hotkeys-hook 的写法）。 */
  keys: string
  /** 人话说明（键盘地图里显示）。 */
  label: string
  group: ShortcutGroup
  /**
   * 是否挂在按钮上（会出现在 tooltip 里）。
   * 纯输入类的快捷键（Enter 发送、↑ 翻历史）没有对应的按钮，所以是 false。
   */
  onButton?: boolean
}

export type ShortcutGroup = '全局' | '面板' | '对话' | '文件与编辑器'

export const SHORTCUTS: Shortcut[] = [
  { id: 'launcher', keys: 'ctrl+k', label: '快速启动（面板 / 会话 / 设置）', group: '全局', onButton: true },
  { id: 'keyboard-map', keys: 'shift+slash', label: '这张快捷键表', group: '全局' },
  { id: 'new-session', keys: 'ctrl+n', label: '新建临时会话', group: '全局' },
  {
    id: 'toggle-session-sidebar',
    keys: 'ctrl+shift+s',
    label: '显示/隐藏侧边栏',
    group: '全局',
    onButton: true
  },
  { id: 'toggle-files', keys: 'ctrl+b', label: '开合工作区文件面板', group: '面板', onButton: true },
  { id: 'toggle-terminal', keys: 'ctrl+backquote', label: '开合终端面板', group: '面板', onButton: true },
  { id: 'open-skills', keys: 'ctrl+i', label: '打开技能', group: '面板', onButton: true },
  { id: 'open-settings', keys: 'ctrl+comma', label: '打开模型与设置', group: '面板', onButton: true },
  { id: 'nav-back', keys: 'alt+arrowleft', label: '后退（视图历史）', group: '全局' },
  { id: 'nav-forward', keys: 'alt+arrowright', label: '前进（视图历史）', group: '全局' },
  { id: 'send', keys: 'enter', label: '发送', group: '对话' },
  { id: 'newline', keys: 'shift+enter', label: '换行（不发送）', group: '对话' },
  { id: 'history', keys: 'arrowup', label: '翻输入历史（单行时）', group: '对话' },
  { id: 'abort', keys: 'escape', label: '关掉最上层浮层 / 中止本次运行（按两次）', group: '对话' },
  { id: 'save', keys: 'ctrl+s', label: '保存编辑器', group: '文件与编辑器' },
  { id: 'search-in-file', keys: 'ctrl+f', label: '编辑器内搜索', group: '文件与编辑器' }
]

/** 表里没有的 id 会抛错：拼错 id 时应该在开发期就炸，而不是显示成空括号。 */
export function shortcutFor(id: string): Shortcut {
  const found = SHORTCUTS.find((shortcut) => shortcut.id === id)
  if (!found) throw new Error(`未知的快捷键 id: ${id}`)
  return found
}

/** 键的展示写法：`ctrl+backquote` → `Ctrl+\``。 */
export function displayKeys(keys: string): string {
  return keys
    .split('+')
    .map((part) => {
      if (part === 'ctrl') return 'Ctrl'
      if (part === 'shift') return 'Shift'
      if (part === 'alt') return 'Alt'
      if (part === 'enter') return 'Enter'
      if (part === 'escape') return 'Esc'
      if (part === 'backquote') return '`'
      if (part === 'comma') return ','
      if (part === 'slash') return '/'
      if (part === 'arrowup') return '↑'
      if (part === 'arrowdown') return '↓'
      if (part === 'arrowleft') return '←'
      if (part === 'arrowright') return '→'
      return part.length === 1 ? part.toUpperCase() : part
    })
    .join(' + ')
}

/** 按钮 tooltip：`终端（Ctrl + \`）`。没有绑定快捷键的按钮就返回原标题。 */
export function tooltipWithShortcut(label: string, id: string): string {
  const shortcut = SHORTCUTS.find((item) => item.id === id)
  return shortcut ? `${label}（${displayKeys(shortcut.keys)}）` : label
}

/** 按分组返回，供键盘地图渲染（组顺序固定，不随表里的书写顺序变）。 */
export function shortcutsByGroup(): { group: ShortcutGroup; items: Shortcut[] }[] {
  const groups: ShortcutGroup[] = ['全局', '面板', '对话', '文件与编辑器']
  return groups
    .map((group) => ({ group, items: SHORTCUTS.filter((shortcut) => shortcut.group === group) }))
    .filter((entry) => entry.items.length > 0)
}

/**
 * `aria-keyshortcuts` 用的紧凑写法（规范要求 `Control+K` 这种形式，不含空格）。
 *
 * 与 tooltip 里的展示写法分开：展示要好看（`Ctrl + K`），aria 要合规（`Control+K`）。
 */
export function ariaKeysFor(id: string): string {
  return shortcutFor(id)
    .keys.split('+')
    .map((part) => {
      if (part === 'ctrl') return 'Control'
      if (part === 'shift') return 'Shift'
      if (part === 'alt') return 'Alt'
      if (part === 'backquote') return '`'
      if (part === 'comma') return ','
      if (part === 'slash') return '/'
      if (part === 'arrowup') return 'ArrowUp'
      if (part === 'arrowleft') return 'ArrowLeft'
      if (part === 'arrowright') return 'ArrowRight'
      if (part === 'enter') return 'Enter'
      if (part === 'escape') return 'Escape'
      return part.length === 1 ? part.toUpperCase() : part
    })
    .join('+')
}
