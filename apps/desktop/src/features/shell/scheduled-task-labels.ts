import type { ScheduledTaskRepeat } from '@i-pi-desk/shared'

export const REPEAT_OPTIONS: { value: ScheduledTaskRepeat; label: string }[] = [
  { value: 'daily', label: '每天' },
  { value: 'weekdays', label: '每个工作日' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' }
]

export function repeatLabel(repeat: ScheduledTaskRepeat): string {
  return REPEAT_OPTIONS.find((o) => o.value === repeat)?.label ?? repeat
}

/** 半小时一档，供时间下拉。 */
export function buildTimeOptions(): string[] {
  const slots: string[] = []
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 30]) {
      slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`)
    }
  }
  return slots
}

export const DEFAULT_TIMEZONE_LABEL = '中国时间'

export function formatTaskTime(timeLocal: string, timezoneLabel: string): string {
  return `${timezoneLabel} ${timeLocal}`
}

/** 列表/详情用的调度状态文案（执行器未接入前由 enabled 推导）。 */
export function taskStatusLabel(enabled: boolean): string {
  return enabled ? '已启用' : '已暂停'
}

/** 最近执行时间；无记录时返回占位文案。 */
export function formatLastRunAt(lastRunAt: string | undefined): string {
  if (!lastRunAt) return '尚未执行'
  const d = new Date(lastRunAt)
  if (Number.isNaN(d.getTime())) return '尚未执行'
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${mo}-${day} ${h}:${mi}`
}
