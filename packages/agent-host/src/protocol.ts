import { createInterface } from 'node:readline'
import type { AgentEventNotification, RpcError, RpcFrame, RpcRequest } from '@i-pi-desk/shared'

/**
 * sidecar 的 stdio 协议层。
 *
 * **最重要的一条规则：stdout 归协议，stderr 归日志。**
 * 任何 `console.log` 都会往协议流里插一帧垃圾，主进程的解析器会立刻报错或错位。
 * 因此这里提供 `log()` 统一走 stderr，业务代码不要直接用 console。
 */

export function log(line: string): void {
  process.stderr.write(`${line}\n`)
}

/** 写一帧。必须整行一次性写出，不能分片 —— 分片会被对面当成两帧。 */
function writeFrame(frame: RpcFrame): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

export function writeResult(id: string, result: unknown): void {
  writeFrame({ id, result })
}

export function writeError(id: string, error: RpcError): void {
  writeFrame({ id, error })
}

/** 推一个 agent 事件给主进程。 */
export function writeAgentEvent(sessionId: string, event: AgentEventNotification['event']): void {
  writeFrame({ method: 'agent.event', params: { sessionId, event } })
}

/** 读 stdin 上的 NDJSON 请求流。返回一个停止函数。 */
export function readRequests(onRequest: (request: RpcRequest) => void, onClose: () => void): () => void {
  const reader = createInterface({ input: process.stdin })
  reader.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      onRequest(JSON.parse(trimmed) as RpcRequest)
    } catch (error) {
      // 单帧坏了不能拖垮整个进程；但发不出应答会让主进程一直等，
      // 所以这里至少要留下痕迹。
      log(`[protocol] 无法解析请求帧: ${String(error)} | ${trimmed.slice(0, 200)}`)
    }
  })
  reader.on('close', onClose)
  return () => reader.close()
}

/** 把任意抛出物转成协议错误对象。 */
export function toRpcError(error: unknown): RpcError {
  if (error instanceof Error) {
    const code = typeof (error as { code?: unknown }).code === 'string' ? String((error as { code?: unknown }).code) : 'INTERNAL'
    const details = typeof (error as { details?: unknown }).details === 'string' ? String((error as { details?: unknown }).details) : error.stack
    return details === undefined ? { code, message: error.message } : { code, message: error.message, details }
  }
  return { code: 'INTERNAL', message: String(error) }
}
