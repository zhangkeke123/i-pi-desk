/**
 * 「部分完成」的汇总。
 *
 * ## 为什么需要它
 *
 * 多步任务最常见的结局不是成功也不是失败，而是**做了一半**：
 * 几个文件改好了、两个因为权限失败、一个被用户拒绝。
 * 界面上如果没有汇总，用户只能自己在消息流里数工具卡 —— 而工具卡会折叠、
 * 会滚出视野，于是「刚才到底成没成」变成一个要靠记忆回答的问题。
 *
 * 设计稿 §3.4 定的规矩：**结论先说数字**（「8 步里完成了 6 步」），
 * 再逐条列出没做成的那些与原因，并说明已完成的工作都还在。
 *
 * 全部成功时返回 `null`：那种情况不需要汇总，多一块卡片只是噪音。
 */

import type { MessagePart } from '@i-pi-desk/shared'

export interface RunSummaryItem {
  name: string
  reason: string
  kind: 'failed' | 'denied'
}

export interface RunSummary {
  total: number
  succeeded: number
  failed: number
  denied: number
  /** 「8 步里完成了 6 步」 */
  headline: string
  /** 「2 步没做成，原因见下」 */
  detail: string
  /**
   * 「已完成的工作去哪了」。
   *
   * 两句话都放在这里（而不是写在 JSX 里），因为它必须能被单测钉住：
   * 零成功时说「已完成的 0 步都还在磁盘上」是废话 —— 这个毛病在端到端自测里出现过一次。
   */
  keptText: string
  items: RunSummaryItem[]
}

/** 只取第一行并截断：错误信息经常是一整段堆栈，卡片里放不下也不该放。 */
function shortReason(text: string | undefined, fallback: string): string {
  const line = (text ?? '').split('\n')[0]?.trim() ?? ''
  if (line.length === 0) return fallback
  return line.length > 80 ? `${line.slice(0, 77)}…` : line
}

export function summarizeRun(parts: MessagePart[]): RunSummary | null {
  const calls = parts.filter((part): part is Extract<MessagePart, { kind: 'tool-call' }> => part.kind === 'tool-call')
  if (calls.length === 0) return null

  const succeeded = calls.filter((call) => call.state === 'succeeded').length
  const failed = calls.filter((call) => call.state === 'failed').length
  const denied = calls.filter((call) => call.state === 'denied').length

  // 还没跑完（有 pending/running/awaiting-approval）就不下结论。
  const unfinished = calls.length - succeeded - failed - denied
  if (unfinished > 0) return null
  if (failed === 0 && denied === 0) return null

  const items: RunSummaryItem[] = calls
    .filter((call) => call.state === 'failed' || call.state === 'denied')
    .map((call) => {
      /**
       * 「被拒绝」要认两种信号。
       *
       * 主机把**用户拒绝**记成 `state: 'failed'` 并在错误里写
       *「用户拒绝执行 write。请换一种方式，或先征得用户同意。」——
       * 那段话是**写给模型看的**（第三人称、带指令），直接搬到卡片上，
       * 用户会读到一句像是别人在汇报他的话。
       *
       * 所以：认得出拒绝就换成第一人称的短句；认不出才当成普通失败。
       * 只看 `state === 'denied'` 是不够的 —— 那条路径在真实运行里根本没被用到，
       * 这一点是端到端自测（拒绝一次审批之后看卡片）暴露出来的。
       */
      const denied = call.state === 'denied' || /用户拒绝|用户已拒绝/.test(call.error ?? '')
      return {
        name: call.name,
        kind: denied ? ('denied' as const) : ('failed' as const),
        reason: denied ? '你拒绝了这次操作' : shortReason(call.error, '执行失败（没有返回原因）')
      }
    })

  return {
    total: calls.length,
    succeeded,
    failed,
    denied,
    headline: `${calls.length} 步里完成了 ${succeeded} 步`,
    detail: `${failed + denied} 步没做成，原因见下`,
    keptText:
      succeeded > 0
        ? `已完成的 ${succeeded} 步都还在磁盘上，也各自有 diff 记录。想接着做，直接发下一条即可。`
        : '这一步没有产生任何改动。想换个做法，直接发下一条即可。',
    items
  }
}
