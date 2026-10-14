/**
 * IPC 统一返回信封。
 *
 * 为什么不用「抛异常」：Electron 的 ipcRenderer.invoke 在跨进程后会把 Error 序列化得
 * 面目全非（堆栈丢失、自定义字段丢失）。统一走信封，错误码和结构化细节才能原样到达 UI。
 */

export interface AppError {
  /** 机器可读错误码，UI 据此决定展示方式（如 AUTH_REQUIRED 弹登录）。 */
  code: string
  /** 面向用户的一句话说明。 */
  message: string
  /** 附加调试信息，不上屏。 */
  details?: string
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: AppError }

export function ok<T>(data: T): Result<T> {
  return { ok: true, data }
}

export function fail<T = never>(code: string, message: string, details?: string): Result<T> {
  return { ok: false, error: details === undefined ? { code, message } : { code, message, details } }
}

/** 主进程内部：把任意抛出物转成 AppError，避免堆栈跨进程丢失。 */
export function toAppError(error: unknown, fallbackCode = 'INTERNAL'): AppError {
  if (error instanceof Error) {
    const code = typeof (error as { code?: unknown }).code === 'string' ? String((error as { code?: unknown }).code) : fallbackCode
    return { code, message: error.message, details: error.stack }
  }
  return { code: fallbackCode, message: String(error) }
}
