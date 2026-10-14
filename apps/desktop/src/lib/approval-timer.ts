/**
 * 审批倒计时。
 *
 * ## 为什么要有倒计时
 *
 * 参考材料里那条「没有出口的等待是要避免的头号失败」在本项目里的落点就是这个卡片：
 * 审批默认 5 分钟后超时（超时按**拒绝**处理），但界面从来没有说过这件事 ——
 * 用户看到的是一个「等着你点」的卡片，不知道不点会怎样。
 *
 * 倒计时的起点是**卡片出现的那一刻**（渲染层记的时间），因为事件里没有带请求时间。
 * 这在正常情况下与主机侧的真实截止时间几乎一致（事件到达即渲染），
 * 差异只可能来自渲染卡顿；把这一点写在注释里，而不是假装它精确到毫秒。
 */

import { APPROVAL_TIMEOUT_MS } from '@i-pi-desk/shared'

export interface ApprovalTimer {
  remainingMs: number
  expired: boolean
  /** 直接可显示的一句话（含「超时会怎样」）。 */
  text: string
}

/** 超时会怎样 —— 这句话不能省：它决定了用户敢不敢先放着不管。 */
export const APPROVAL_TIMEOUT_NOTE = '超时按「拒绝」处理，这一步不会执行，其余步骤继续'

export function formatCountdown(remainingMs: number): string {
  const safe = Number.isFinite(remainingMs) && remainingMs > 0 ? remainingMs : 0
  const totalSeconds = Math.ceil(safe / 1000)
  if (totalSeconds <= 0) return '已超时（按「拒绝」处理），这一步没有执行'
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  const clock = minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`
  return `还有 ${clock}`
}

export function approvalTimer(
  appearedAtMs: number,
  nowMs: number,
  timeoutMs: number = APPROVAL_TIMEOUT_MS
): ApprovalTimer {
  const remainingMs = Math.max(0, timeoutMs - (nowMs - appearedAtMs))
  const expired = remainingMs <= 0
  /**
   * ⚠️ 说明只拼**一次**。
   *
   * 第一版把说明先拼进 `text`、又在返回时拼了一次，于是界面上出现
   * 「…其余步骤继续 · 超时按「拒绝」处理…其余步骤继续」——
   * 而当时的断言是 `text.includes(说明)`，**看不见重复**（包含是真的）。
   * 现在的断言改成「恰好出现一次」（见 scripts/verify-ui-logic.ts）。
   */
  const text = expired
    ? formatCountdown(0)
    : `${formatCountdown(remainingMs)} · ${APPROVAL_TIMEOUT_NOTE}`
  return { remainingMs, expired, text }
}
