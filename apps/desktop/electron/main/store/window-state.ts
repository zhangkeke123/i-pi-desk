import { join } from 'node:path'
import { getAppPaths } from '../paths.js'
import { readJson, writeJsonAtomic } from './json-store.js'
import type { WindowBounds } from './window-bounds.js'

/**
 * 窗口尺寸/位置的**持久化**。
 *
 * ## 为什么这件小事值得单独做
 *
 * 不然每次启动都回到 1280×840、屏幕中间。用户调好窗口、换个显示器、
 * 或者习惯把窗口贴在右侧窄条里 —— 重启全白费。这是**每天都会碰到一次**的摩擦，
 * 而修它的成本很低。
 *
 * 判断「保存的位置还能不能用」的逻辑在 `window-bounds.ts`（纯函数、可单独测试）；
 * 这里只管读写文件。
 */

function stateFile(): string {
  return join(getAppPaths().userData, 'window-state.json')
}

export function readWindowBounds(): WindowBounds | null {
  const saved = readJson<WindowBounds | null>(stateFile(), null)
  if (!saved || typeof saved !== 'object') return null
  return saved
}

export function writeWindowBounds(bounds: WindowBounds): void {
  try {
    writeJsonAtomic(stateFile(), bounds)
  } catch {
    // 写不进去（磁盘满 / 权限）不该影响应用退出或使用。下次启动用默认尺寸即可。
  }
}
