/**
 * 渲染层共用的短标签。
 *
 * 抽出来的理由不是「复用」，而是**同一个概念在两处写法不一致**：
 * 设置页的下拉写「只读（最安全）/ 每次询问（推荐）/ 自动放行」，
 * 而输入框旁边只需要一个短标签。两处各写一份，早晚会出现
 * 「设置里叫自动放行、状态栏叫 auto」这种对不上的情况。
 */

import type { PermissionMode } from '@i-pi-desk/shared'

/** 权限模式的短标签（状态、输入框上下文条用）。 */
export const PERMISSION_LABEL: Record<PermissionMode, string> = {
  readonly: '只读',
  ask: '每次询问',
  auto: '自动放行'
}

/** 一句话说明，用在需要解释的场合（设置页、tooltip）。 */
export const PERMISSION_HINT: Record<PermissionMode, string> = {
  readonly: '只读模式：只能看，不能改',
  ask: '写文件与跑命令前都会问你',
  auto: '常规操作直接执行；危险命令仍会问'
}
