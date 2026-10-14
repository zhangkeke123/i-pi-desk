import type { ThinkingLevelValue } from '@i-pi-desk/shared'

/**
 * 思考强度的**展示**定义（值本身定义在 shared，见那里的说明）。
 *
 * ## 为什么分两档「常用」与「全部」
 *
 * 内核有七个值，但 `xhigh` / `max` 只有部分模型家族支持，`minimal` 也很少有人用。
 * 输入区是**每句话都要看**的地方，把七个值全摊在那儿只会让人犹豫；
 * 所以输入区的下拉给四个常用的（关闭/低/中/高），设置里给全部七个。
 * 真正的边界由内核的 clampThinkingLevel() 兜住 —— 选了模型不支持的档位不会报错，会被夹取。
 *
 * 与 lib/shortcuts.ts 同样的做法：**文案只写一份**，输入区与设置页都读它。
 */
export const THINKING_LEVELS: { value: ThinkingLevelValue; label: string; hint: string }[] = [
  { value: 'off', label: '关闭', hint: '不请求推理，最快也最省' },
  { value: 'minimal', label: '极少', hint: '只做最少一步推理' },
  { value: 'low', label: '低', hint: '简单任务够用' },
  { value: 'medium', label: '中', hint: '默认档位' },
  { value: 'high', label: '高', hint: '复杂改动建议' },
  { value: 'xhigh', label: '更高', hint: '只有部分模型支持' },
  { value: 'max', label: '最高', hint: '只有部分模型支持，最慢' }
]

/** 输入区只给这四个 —— 见文件头说明。 */
export const COMMON_THINKING_LEVELS: ThinkingLevelValue[] = ['off', 'low', 'medium', 'high']

export function thinkingLabel(value: ThinkingLevelValue | undefined): string {
  const found = THINKING_LEVELS.find((level) => level.value === value)
  return found ? found.label : '中'
}

export function thinkingHint(value: ThinkingLevelValue | undefined): string {
  const found = THINKING_LEVELS.find((level) => level.value === value)
  return found ? found.hint : '默认档位'
}

/**
 * 规整来自设置/协议的值。
 *
 * 认不出来就返回 `undefined`（= 交给内核默认），**不**退回某个具体值 ——
 * 静默替换会让用户以为自己选的档位生效了。
 */
export function normalizeThinkingLevel(value: unknown): ThinkingLevelValue | undefined {
  return THINKING_LEVELS.some((level) => level.value === value) ? (value as ThinkingLevelValue) : undefined
}
