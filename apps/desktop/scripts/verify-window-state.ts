/**
 * 窗口尺寸/位置恢复规则自测。
 *
 * 这个功能的风险不在「记不住」，而在「记住了但位置已经不存在」——
 * 用户拔掉外接显示器后，上次的坐标可能落在不存在的屏幕上，窗口会在屏幕外打开，
 * 表现为「点了图标没反应」。这是这类功能最常见的翻车方式，所以要逐条覆盖。
 *
 * 用法：node --experimental-strip-types scripts/verify-window-state.ts
 */

import {
  DEFAULT_BOUNDS,
  MIN_HEIGHT,
  MIN_WIDTH,
  resolveWindowBounds,
  type DisplayArea
} from '../electron/main/store/window-bounds.ts'

let failures = 0
const check = (label: string, condition: boolean, detail = ''): void => {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

/** 一块 1920×1080 主屏。 */
const main: DisplayArea = { x: 0, y: 0, width: 1920, height: 1080 }
/** 右侧一块扩展屏。 */
const right: DisplayArea = { x: 1920, y: 0, width: 1920, height: 1080 }

console.log('[1] 没有保存过 → 用默认尺寸，且不指定位置（交给 Electron 居中）')
const fresh = resolveWindowBounds(null, [main])
check('用默认尺寸', fresh.width === DEFAULT_BOUNDS.width && fresh.height === DEFAULT_BOUNDS.height, JSON.stringify(fresh))
check('不带位置', fresh.x === undefined && fresh.y === undefined, JSON.stringify(fresh))

console.log('\n[2] 保存的位置在当前屏幕上 → 原样恢复')
const ok = resolveWindowBounds({ x: 100, y: 80, width: 1000, height: 700 }, [main])
check('位置与尺寸都被恢复', ok.x === 100 && ok.y === 80 && ok.width === 1000 && ok.height === 700, JSON.stringify(ok))

console.log('\n[3] 保存的位置来自一块**已拔掉**的显示器 → 必须放弃位置')
const offScreen = resolveWindowBounds({ x: 2400, y: 200, width: 1000, height: 700 }, [main])
check(
  '位置被丢弃（否则窗口开在屏幕外，表现为点不开）',
  offScreen.x === undefined && offScreen.y === undefined,
  JSON.stringify(offScreen)
)
check('但尺寸仍然保留（用户对大小的偏好有效）', offScreen.width === 1000 && offScreen.height === 700, JSON.stringify(offScreen))

console.log('\n[4] 多屏：第二块屏上的位置应当被保留')
const onSecond = resolveWindowBounds({ x: 2400, y: 200, width: 1000, height: 700 }, [main, right])
check('第二块屏上的位置可用', onSecond.x === 2400 && onSecond.y === 200, JSON.stringify(onSecond))

console.log('\n[5] 只露出一角也算可用（用户刻意贴边是合理用法）')
// 横露 120px、纵露 80px：确实伸到屏幕外，但用户抓得到标题栏。
const corner = resolveWindowBounds({ x: 1800, y: 1000, width: 1000, height: 700 }, [main])
check('露出足够一角时保留位置', corner.x === 1800 && corner.y === 1000, JSON.stringify(corner))

console.log('\n[6] 只剩一条缝算不可用（用户其实抓不到窗口）')
// 横向只露 5px：这在屏幕上看不见，用户也没法拖回来。
const sliver = resolveWindowBounds({ x: 1915, y: 1075, width: 1000, height: 700 }, [main])
check('只剩几像素时丢弃位置', sliver.x === undefined && sliver.y === undefined, JSON.stringify(sliver))

console.log('\n[7] 尺寸夹到合法区间（换了更小的显示器）')
const huge = resolveWindowBounds({ x: 0, y: 0, width: 5000, height: 4000 }, [main])
check('超大尺寸被保留而不是夹掉（由系统处理）', huge.width === 5000, JSON.stringify(huge))
const tiny = resolveWindowBounds({ x: 0, y: 0, width: 200, height: 100 }, [main])
check(`过小尺寸抬到下限 ${MIN_WIDTH}×${MIN_HEIGHT}`, tiny.width === MIN_WIDTH && tiny.height === MIN_HEIGHT, JSON.stringify(tiny))

console.log('\n[8] 脏数据不应让应用起不来')
for (const [label, saved] of [
  ['width 是字符串', { width: 'abc' as unknown as number, height: 700 }],
  ['width 是 NaN', { width: Number.NaN, height: 700 }],
  ['只有 x/y 没有尺寸', { x: 1, y: 2, width: 0, height: 0 }]
] as const) {
  const resolved = resolveWindowBounds(saved as never, [main])
  check(
    `${label} → 回退到合法值`,
    Number.isFinite(resolved.width) && resolved.width >= MIN_WIDTH && Number.isFinite(resolved.height) && resolved.height >= MIN_HEIGHT,
    JSON.stringify(resolved)
  )
}

console.log('\n[9] 最大化状态被保留')
const maximized = resolveWindowBounds({ x: 100, y: 100, width: 1000, height: 700, maximized: true }, [main])
check('maximized 透传', maximized.maximized === true, JSON.stringify(maximized))
const offButMax = resolveWindowBounds({ x: 9999, y: 9999, width: 1000, height: 700, maximized: true }, [main])
check('位置不可用时最大化状态仍保留', offButMax.maximized === true && offButMax.x === undefined, JSON.stringify(offButMax))

console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
