/**
 * 窗口尺寸与位置的**纯逻辑**。
 *
 * 刻意与 `window-state.ts`（读写文件、依赖 Electron 的路径）分开：
 * 这一层不 import 任何 Electron API，于是可以被 node 直接跑测试 ——
 * 而这里恰好是**唯一有真实后果**的部分（见 `resolveWindowBounds` 的说明）。
 */

export interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
  /** 关闭时是否处于最大化。 */
  maximized?: boolean
}

export interface DisplayArea {
  x: number
  y: number
  width: number
  height: number
}

/** 默认尺寸（`window.ts` 里的初始值）。 */
export const DEFAULT_BOUNDS: WindowBounds = { width: 1280, height: 840 }
export const MIN_WIDTH = 900
export const MIN_HEIGHT = 600

/**
 * 至少要有这么多像素落在某块屏幕上，才认为这个位置可用。
 *
 * 取 80×80 而不是「完整可见」：用户刻意把窗口拖到只露一条边是合理用法
 * （放不下的宽窗口、临时看一眼），不该被强行搬回来。
 * 但只剩几个像素就算「找不到」了 —— 那种情况用户实际上点不到窗口。
 */
const MIN_VISIBLE = 80

/**
 * 决定这次该用哪个窗口矩形。
 *
 * ## 真正需要小心的地方：恢复一个「已经不存在的位置」
 *
 * 直接存什么位置就用什么位置是危险的：用户拔掉外接显示器后，
 * 上次保存的坐标可能完全落在不存在的屏幕上 —— 窗口会**在屏幕外打开**，
 * 表现为「点了图标没反应」。这是这类功能最常见的翻车方式。
 *
 * 所以校验：保存的矩形必须与**当前某块屏幕的可视区域**有足够重叠，
 * 否则放弃位置（保留尺寸）。放弃位置时**不传 x/y**，让 Electron 自己居中 ——
 * 比我们自己算一个「大概居中」的值更稳。
 */
export function resolveWindowBounds(
  saved: WindowBounds | null | undefined,
  displays: DisplayArea[]
): WindowBounds {
  if (!saved) return { ...DEFAULT_BOUNDS }

  // 尺寸先夹到合法区间：显示器换了（比如从 4K 换到 1080p）时，
  // 保存的尺寸可能比当前屏幕还大，也不能小于窗口自身的最小尺寸。
  const width = Math.max(MIN_WIDTH, Math.round(Number(saved.width) || DEFAULT_BOUNDS.width))
  const height = Math.max(MIN_HEIGHT, Math.round(Number(saved.height) || DEFAULT_BOUNDS.height))
  const maximized = saved.maximized === true

  const hasPosition = Number.isFinite(saved.x) && Number.isFinite(saved.y)
  if (!hasPosition) {
    // 只有尺寸没有位置：位置交回默认（居中）。
    return { width, height, maximized }
  }

  const x = Math.round(saved.x as number)
  const y = Math.round(saved.y as number)

  const visible = displays.some((display) => {
    const overlapX = Math.min(x + width, display.x + display.width) - Math.max(x, display.x)
    const overlapY = Math.min(y + height, display.y + display.height) - Math.max(y, display.y)
    return overlapX >= MIN_VISIBLE && overlapY >= MIN_VISIBLE
  })

  if (!visible) return { width, height, maximized }

  return { x, y, width, height, maximized }
}
