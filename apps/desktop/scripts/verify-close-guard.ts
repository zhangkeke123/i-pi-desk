/**
 * 关窗拦截的**规则**自测（纯函数，不启动 Electron）。
 *
 * 为什么这些规则值得单独测：拦截有个天然的坏结局 ——
 * **万一判断出错，用户就再也关不掉窗口了**，只能去任务管理器。
 * 所以这里每一条都要钉住，尤其是「兜底放行」那条。
 *
 * 用法：node --experimental-strip-types scripts/verify-close-guard.ts
 */
import { ASK_TIMEOUT_MS, decideClose } from '../electron/main/close-guard.ts'

let failures = 0
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

const base = { dirty: false, confirmed: false, askedAt: null as number | null, now: 1_000_000 }

console.log('── 基本情况 ──')
check('没有未保存改动：直接放行', decideClose({ ...base }) === 'close')
check('有未保存改动、还没问过：先问一句', decideClose({ ...base, dirty: true }) === 'ask')
check(
  '用户确认过「不保存并退出」：放行',
  decideClose({ ...base, dirty: true, confirmed: true }) === 'close'
)

console.log('\n── 问过之后的各种时序 ──')
check(
  '刚问完（1ms 后）：还没到超时，仍然拦着',
  decideClose({ ...base, dirty: true, askedAt: base.now - 1 }) === 'ask'
)
check(
  `超时前一毫秒（${ASK_TIMEOUT_MS - 1}ms）：仍然拦着`,
  decideClose({ ...base, dirty: true, askedAt: base.now - (ASK_TIMEOUT_MS - 1) }) === 'ask'
)
check(
  `正好到超时（${ASK_TIMEOUT_MS}ms）：兜底放行`,
  decideClose({ ...base, dirty: true, askedAt: base.now - ASK_TIMEOUT_MS }) === 'force-close'
)
check(
  '早就超时（1 小时）：兜底放行',
  decideClose({ ...base, dirty: true, askedAt: base.now - 3_600_000 }) === 'force-close'
)
check(
  '超时值可注入（自测不必真等 10 秒）',
  decideClose({ ...base, dirty: true, askedAt: base.now - 5, askTimeoutMs: 5 }) === 'force-close'
)

console.log('\n── 兜底不会误伤正常路径 ──')
/**
 * 最关键的一条：**干净状态下永远不该被拦住**，无论时间怎么走。
 * 反过来说：只要 `dirty` 是错误的 true，用户就会撞上「关不掉」——
 * 所以 `setDirty(false)` 必须可靠地被调到（见 store 与 WorkspacePanel 的说明）。
 */
check(
  '干净 + 确认过：放行',
  decideClose({ ...base, confirmed: true, askedAt: base.now - 3_600_000 }) === 'close'
)
check(
  '干净 + 问过很久：依然放行（不会因为超时逻辑反而拦人）',
  decideClose({ ...base, askedAt: base.now - 3_600_000 }) === 'close'
)
check(
  '脏 + 已确认：即使刚问过也放行',
  decideClose({ ...base, dirty: true, confirmed: true, askedAt: base.now }) === 'close'
)

console.log('\n── 边界：时间倒流（系统时钟被改）不该把人关在应用里 ──')
check(
  'askedAt 在未来：差值算出来是负数，按「还没超时」处理（拦一次）',
  decideClose({ ...base, dirty: true, askedAt: base.now + 60_000 }) === 'ask'
)

console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
