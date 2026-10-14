import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { toAppError, type Result } from '@i-pi-desk/shared'

/**
 * IPC handler 的统一包装。
 *
 * 两件事必须在这里做掉，否则每个 handler 都要重复：
 *  1) 把「抛异常」转成 `Result` 信封 —— 跨进程后 Error 的堆栈和自定义字段会丢，
 *     只有信封能把错误码原样送到 UI。
 *  2) `removeHandler` 再注册 —— 热重载 / 重复初始化时 Electron 会因重复注册而抛错。
 */
export function handle<T>(
  channel: string,
  fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<T> | T
): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, async (event, ...args): Promise<Result<T>> => {
    try {
      return { ok: true, data: await fn(event, ...args) }
    } catch (error) {
      return { ok: false, error: toAppError(error) }
    }
  })
}

/** 取第一个参数并断言成指定类型 —— 渲染层传来的东西一律视为不可信输入。 */
export function arg<T>(args: unknown[], index: number): T {
  return args[index] as T
}

/** 校验字符串参数，避免 undefined 一路穿到 fs 调用里变成「相对路径解析到进程 cwd」。 */
export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw Object.assign(new Error(`缺少必填参数: ${field}`), { code: 'BAD_REQUEST' })
  }
  return value
}
