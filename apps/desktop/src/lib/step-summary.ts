import type { MessagePart } from '@i-pi-desk/shared'

/**
 * 一轮里「工具 + 审批」该怎么折叠。
 *
 * 成功步骤默认收起，避免长 run 把正文挤掉；
 * 失败、拒绝、还在等审批时必须展开 —— 那是用户现在就要看的。
 */
export interface StepSummary {
  total: number
  /** 失败的工具调用 + 被拒绝的审批。 */
  issues: number
  startOpen: boolean
}

export function summarizeSteps(parts: MessagePart[]): StepSummary {
  let issues = 0
  let startOpen = false
  for (const part of parts) {
    if (part.kind === 'tool-call') {
      if (part.state === 'failed' || part.state === 'denied') issues += 1
      if (part.state === 'awaiting-approval' || part.state === 'failed' || part.state === 'running') {
        startOpen = true
      }
    } else if (part.kind === 'approval') {
      if (part.decision === 'deny') issues += 1
      if (!part.decision) startOpen = true
    }
  }
  return { total: parts.length, issues, startOpen }
}
