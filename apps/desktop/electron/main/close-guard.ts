/**
 * 关窗前的「有未保存改动」拦截。
 *
 * ## 为什么这件事必须在主进程做
 *
 * 「关窗口」是操作系统/窗口管理器的事件，只有主进程的 `close` 事件拿得到；
 * 而「编辑器里有没有未保存的改动」只有渲染层知道。所以这是一个**主进程拦下、
 * 渲染层决定**的协议：
 *
 * ```text
 * 用户点 X
 *   → 主进程 close 事件：有未保存改动？ → preventDefault() + 通知渲染层
 *   → 渲染层弹一句「有未保存的改动，退出会丢弃它们」
 *   → 用户选「不保存并退出」→ confirmQuit() → 主进程这次真的关
 * ```
 *
 * ## 最要紧的一条：**不能把用户关在应用里**
 *
 * 拦截有个天然的坏结局：万一渲染层卡住（或忘了回应），窗口就再也关不掉了 ——
 * 用户只能去任务管理器。所以这里有一条兜底：**问过一次之后，超过
 * `ASK_TIMEOUT_MS` 还没等到回应，下一次关窗就放行**，并在日志里写明原因。
 *
 * 宁可丢掉一次未保存的改动，也不能让一个卡住的渲染层把整个应用变成「关不掉」。
 * 这条规则被抽成纯函数（`decideClose`），所以它能被单独测 —— 包括超时那条分支。
 */

/** 问了但一直没回音多久之后就放行。 */
export const ASK_TIMEOUT_MS = 10_000

export interface CloseGateState {
  /** 编辑器里有没有未保存的改动（由渲染层上报）。 */
  dirty: boolean
  /** 用户已经在「不保存并退出」上确认过。 */
  confirmed: boolean
  /** 上一次「问一句」的时间戳；没问过是 `null`。 */
  askedAt: number | null
  /** 当前时间（注入进来，便于测试）。 */
  now: number
  /** 兜底超时，默认 `ASK_TIMEOUT_MS`。 */
  askTimeoutMs?: number
}

export type CloseDecision =
  /** 直接放行。 */
  | 'close'
  /** 拦下并问渲染层。 */
  | 'ask'
  /** 问过但没回音，兜底放行（要记日志）。 */
  | 'force-close'

export function decideClose(state: CloseGateState): CloseDecision {
  if (state.confirmed) return 'close'
  if (!state.dirty) return 'close'
  const timeout = state.askTimeoutMs ?? ASK_TIMEOUT_MS
  if (state.askedAt !== null && state.now - state.askedAt >= timeout) return 'force-close'
  return 'ask'
}
