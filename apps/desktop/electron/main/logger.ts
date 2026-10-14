import { appendFileSync } from 'node:fs'

/**
 * 主进程日志。
 *
 * 单独成模块的原因：它被 `index.ts` 与 `security.ts` 同时需要，
 * 放在 index.ts 里会造成循环 import（index → security → index）。
 *
 * 日志文件路径由 `initLogger()` 注入，避免本模块反过来依赖 paths/electron。
 */

let logFile = ''

export function initLogger(file: string): void {
  logFile = file
}

export function log(line: string): void {
  const text = `[${new Date().toISOString()}] ${line}`
  process.stderr.write(`${text}\n`)
  if (!logFile) return
  try {
    appendFileSync(logFile, `${text}\n`, 'utf8')
  } catch {
    // 日志写不进去不是致命问题，绝不能因为它把主流程搞崩。
  }
}
