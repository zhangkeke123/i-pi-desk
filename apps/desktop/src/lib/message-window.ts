/**
 * 长会话的渲染窗口。
 *
 * ## 为什么要有上限
 *
 * 消息流目前是**全量渲染**：一个跑了几百轮的会话，每次状态变化（流式 token、
 * 审批、工具状态）都会让 React 重算几百个消息节点。用户感受到的是「越用越卡」，
 * 而现象很难归因到「消息太多」。
 *
 * ## 为什么先做「窗口 + 手动展开」而不是虚拟滚动
 *
 * 虚拟滚动（`@tanstack/react-virtual` 一类）能常驻 O(1) 个节点，但它要求
 * **每一条消息的高度可预测或可测量** —— 而这里的消息高度取决于 markdown、diff、
 * 折叠的工具卡、审批卡，尺寸差异极大。引它意味着要处理「滚动位置漂移」这一整类新问题，
 * 而收益（几百条以上才明显）对这个自用工具还不成立。
 *
 * 先做窗口：**默认只渲染最近 N 条**，更早的用一个按钮展开。
 * 它把最常见的情况（一次会话几十条）钉在常数上，而且行为可解释、无副作用。
 * 真到了几百条以上再换虚拟滚动 —— 那时这条断言会成为它的对照组。
 *
 * ## 为什么是纯函数
 *
 * 「藏了几条、展开后还剩几条」这类边界（正好等于上限、展开后再折叠）最容易写错，
 * 而它们不需要跑界面就能验（见 scripts/verify-ui-logic.ts）。
 */

/** 默认窗口大小。 */
export const MESSAGE_WINDOW = 40

export interface MessageWindow<T> {
  /** 实际要渲染的消息。 */
  visible: T[]
  /** 被折叠掉的消息条数（0 表示没有折叠）。 */
  hiddenCount: number
}

/**
 * 取要渲染的那一段。
 *
 * 注意是**保留最近的**而不是最早的：用户关心的是刚发生的事，
 * 而旧消息按需展开（与终端的滚动语义一致）。
 */
export function windowMessages<T>(messages: T[], limit: number = MESSAGE_WINDOW, expanded = false): MessageWindow<T> {
  // 上限非法（0 / 负数 / NaN）时按「不折叠」处理：宁可多渲染，也不要让界面空掉。
  if (!Number.isFinite(limit) || limit <= 0) return { visible: messages, hiddenCount: 0 }
  if (expanded || messages.length <= limit) return { visible: messages, hiddenCount: 0 }
  return { visible: messages.slice(messages.length - limit), hiddenCount: messages.length - limit }
}

/** 折叠提示的文案（「显示更早的 23 条消息」）。 */
export function hiddenLabel(hiddenCount: number): string {
  return `显示更早的 ${hiddenCount} 条消息`
}
