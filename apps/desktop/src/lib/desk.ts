import type { DeskApi } from '@i-pi-desk/shared'

/**
 * 渲染层拿到 preload 注入的 API。
 *
 * 为什么用「运行时取 + 显式判空」而不是直接 `window.desk`：
 * 如果 preload 加载失败（路径错、构建格式不对），`window.desk` 会是 undefined。
 * 这时应当给出一句能定位问题的提示，而不是让第一个组件在渲染时抛
 * "Cannot read properties of undefined" —— 那种报错完全看不出是 preload 的问题。
 */
declare global {
  interface Window {
    desk?: DeskApi
  }
}

export function getDesk(): DeskApi {
  const desk = window.desk
  if (!desk) {
    throw new Error('preload 未注入 window.desk —— 检查 preload 构建产物路径与加载是否成功')
  }
  return desk
}

/** 带错误码的 IPC 异常。UI 可以按 code 分支（例如 PROVIDER_NOT_CONFIGURED 弹设置）。 */
export class IpcError extends Error {
  readonly code: string
  readonly details?: string

  constructor(code: string, message: string, details?: string) {
    super(message)
    this.name = 'IpcError'
    this.code = code
    this.details = details
  }
}

/**
 * 把 `Result<T>` 拆开：成功返回数据，失败抛 IpcError。
 *
 * 抛异常而不是返回联合类型，是为了让调用方可以直接 `await` 并用 try/catch —— 
 * 在 store 的 action 里这比每个调用点都判 `ok` 干净得多。
 */
export async function call<T>(promise: Promise<{ ok: true; data: T } | { ok: false; error: { code: string; message: string; details?: string } }>): Promise<T> {
  const result = await promise
  if (result.ok) return result.data
  throw new IpcError(result.error.code, result.error.message, result.error.details)
}
