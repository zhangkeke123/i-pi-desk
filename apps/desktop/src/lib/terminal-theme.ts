/**
 * 把 CSS 变量里的颜色交给**不认 CSS 变量**的消费者（xterm）。
 *
 * ## 为什么需要归一层
 *
 * 设计 token 全部是 `oklch(...)`，而 xterm 有**自己的颜色解析器**：
 * 只认命名色、`#rgb`/`#rrggbb`、`rgb()/rgba()`、`hsl()` —— `oklch()` 会被判为非法
 * （实测：`@xterm/xterm` 产物里根本没有 `oklch`/`oklab`/`hsl` 字样，只有 rgba）。
 * 直接把它塞进去，结果是终端悄悄退回默认配色，而不是报错 —— 很难发现。
 *
 * ## 归一化办法：光栅化，而不是读 `fillStyle`
 *
 * 第一版用的是「设 `ctx.fillStyle = 颜色`，再读回来」—— **这是错的**：
 * 实测（第 2 轮，我在页内探针里量过）Chrome 的 `fillStyle` 对 `oklch()` 是
 * **原样返回**，不做色彩空间转换。于是 xterm 仍然收到 `oklch(...)`，
 * 终端悄悄退回黑底白字，界面上看起来「只是没生效」，没有任何报错。
 *
 * 可靠的办法是**把它画出来再读像素**：`fillRect` + `getImageData` 得到的就是
 * sRGB 8 位值，任何色彩空间都会被浏览器光栅化成可用的颜色。
 *
 * CodeMirror 那边不需要这一层：它的样式是真的 CSS（`color: var(--color-ink)`），
 * 由浏览器解析，切主题自动生效。
 */

/** 每个主题下终端该用的颜色，全部来自语义 token。 */
export interface TerminalPalette {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

let canvasContext: CanvasRenderingContext2D | null = null

function toHexByte(value: number): string {
  return value.toString(16).padStart(2, '0')
}

/**
 * 把任意 CSS 颜色转成 `#rrggbb`（xterm 认的写法）。
 *
 * 用「画一个像素再读回来」而不是读 `fillStyle` —— 原因见文件头。
 * 读到全透明（alpha=0）或读不到时退回 `fallback`，避免把透明色当成黑色发给终端。
 */
function normalize(value: string, fallback: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) return fallback
  try {
    if (!canvasContext) {
      const canvas = document.createElement('canvas')
      canvas.width = 1
      canvas.height = 1
      canvasContext = canvas.getContext('2d', { willReadFrequently: true })
    }
    if (!canvasContext) return fallback

    canvasContext.clearRect(0, 0, 1, 1)
    canvasContext.fillStyle = trimmed
    canvasContext.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = canvasContext.getImageData(0, 0, 1, 1).data
    if (a === 0) return fallback
    return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`
  } catch {
    return fallback
  }
}

function readVar(style: CSSStyleDeclaration, name: string, fallback: string): string {
  return normalize(style.getPropertyValue(name), fallback)
}

/**
 * 从当前 `<html>` 上的主题变量读出一份 xterm 配色。
 * 必须在 `applyTheme()` 之后调用，否则读到的是上一个主题。
 */
export function terminalPalette(): TerminalPalette {
  const style = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string): string => readVar(style, name, fallback)

  return {
    background: read('--color-canvas', '#0e1014'),
    foreground: read('--color-ink', '#e6eaf0'),
    cursor: read('--color-accent', '#4c8dff'),
    cursorAccent: read('--color-canvas', '#0e1014'),
    selectionBackground: read('--color-accent-soft', '#26406b'),
    // 16 色 ANSI：用语义 token 映射，主题一换终端配色跟着换。
    black: read('--color-surface-3', '#2b2f36'),
    red: read('--color-danger', '#ff6b6b'),
    green: read('--color-ok', '#3ddc97'),
    yellow: read('--color-warn', '#f0b429'),
    blue: read('--color-accent', '#4c8dff'),
    magenta: read('--color-syn-keyword', '#c792ea'),
    cyan: read('--color-syn-operator', '#89ddff'),
    white: read('--color-ink-soft', '#c9d1dc'),
    brightBlack: read('--color-muted', '#8b95a5'),
    brightRed: read('--color-danger', '#ff6b6b'),
    brightGreen: read('--color-ok', '#3ddc97'),
    brightYellow: read('--color-warn', '#f0b429'),
    brightBlue: read('--color-accent-hover', '#6ea6ff'),
    brightMagenta: read('--color-syn-keyword', '#c792ea'),
    brightCyan: read('--color-syn-operator', '#89ddff'),
    brightWhite: read('--color-ink', '#e6eaf0')
  }
}
