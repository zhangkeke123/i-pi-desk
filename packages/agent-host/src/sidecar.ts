/**
 * sidecar 进程入口：把 stdin 上的 NDJSON 请求分发到 `AgentRuntime`，把结果写回 stdout。
 *
 * ## stdout 纪律（最重要的一条）
 *
 * stdout **只**归协议。本文件与 runtime / provider 里没有一处 `console.log`；
 * 所有日志走 `protocol.ts` 的 `log()`（写 stderr）。任何一帧垃圾都会让主进程的
 * 解析器错位，而且症状往往出现在几十帧之后，极难定位。
 *
 * ## 退出纪律
 *
 *  - `shutdown` RPC：清理所有会话 → flush stdout（否则应答会被截断）→ `process.exit(0)`；
 *  - stdin 关闭（主进程没了）：同样走这条路径，否则会留下孤儿进程；
 *  - 单个请求抛异常只回一帧 `writeError`，**绝不**退出进程。
 */

// ⚠️ 顺序不能动：isolation.js 必须在 runtime.js（它拉起整个 pi 模块图）之前求值，
// 因为 pi 的 tools-manager.js 在模块顶层就把 agent 目录固化成了常量。详见 isolation.ts。
import { bindProvisionalAgentDir, PI_AGENT_DIR_ENV } from './isolation.js'

import { log, readRequests, toRpcError, writeAgentEvent, writeError, writeResult } from './protocol.js'
import { AgentRuntime, RuntimeFailure } from './runtime.js'
import type { PromptParams, ProviderVerifyParams, ResolveApprovalParams, RpcRequest, SessionCreateParams } from '@i-pi-desk/shared'

/** 启动时就把 agent 目录绑到一个安全的兜底值（见 isolation.ts 的说明）。 */
const provisionalAgentDir = bindProvisionalAgentDir()

const runtime = new AgentRuntime({
  writeEvent: writeAgentEvent,
  log
})

let exiting = false

/** 等到 stdout 缓冲真正交给操作系统再退出，避免最后一帧被 process.exit 截断。 */
function flushStdout(): Promise<void> {
  return new Promise((resolve) => {
    if (process.stdout.writableLength === 0) {
      resolve()
      return
    }
    process.stdout.write('', () => resolve())
  })
}

/** 优雅退出：清理会话 → 关掉 stdin 读取 → flush → exit。幂等。 */
async function exitGracefully(code: number, reason: string): Promise<void> {
  if (exiting) return
  exiting = true
  log(`[sidecar] 退出（${reason}），code=${code}`)
  try {
    const result = await runtime.shutdown()
    log(`[sidecar] 已清理 ${result.disposed} 个会话`)
  } catch (error) {
    log(`[sidecar] 清理会话失败：${String(error)}`)
  }
  try {
    stopReading()
  } catch (error) {
    log(`[sidecar] 关闭 stdin 读取失败：${String(error)}`)
  }
  await flushStdout()
  process.exit(code)
}

function paramsOf<T>(request: RpcRequest<unknown>): T {
  const params = request.params
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new RuntimeFailure('INVALID_PARAMS', `${request.method} 需要一个对象参数`)
  }
  return params as T
}

/** 分发单个请求。抛出的任何东西都会被调用点转成 `writeError`。 */
async function dispatch(request: RpcRequest<unknown>): Promise<unknown> {
  switch (request.method) {
    case 'ping':
      return runtime.ping()
    case 'provider.verify':
      return runtime.verifyProvider(paramsOf<ProviderVerifyParams>(request))
    case 'session.create':
      return runtime.createSession(paramsOf<SessionCreateParams>(request))
    case 'session.load':
      return runtime.loadSession(paramsOf<{ sessionId: string }>(request).sessionId)
    case 'session.list':
      return runtime.listSessions()
    case 'session.prompt':
      return runtime.prompt(paramsOf<PromptParams>(request))
    case 'session.inspect':
      return runtime.inspect(paramsOf<PromptParams>(request))
    case 'session.abort':
      return runtime.abortSession(paramsOf<{ sessionId: string }>(request).sessionId)
    case 'session.dispose':
      return runtime.disposeSession(paramsOf<{ sessionId: string }>(request).sessionId)
    case 'approval.resolve':
      return runtime.resolveApproval(paramsOf<ResolveApprovalParams>(request))
    case 'shutdown':
      return { ok: true, agentDir: runtime.agentDir ?? provisionalAgentDir }
    default: {
      // RpcMethod 是闭集；走到这里说明线上协议多了一个本进程不认识的 method。
      const unknown = request.method as string
      throw new RuntimeFailure('METHOD_NOT_FOUND', `不支持的 RPC 方法：${unknown}`)
    }
  }
}

async function handle(request: RpcRequest<unknown>): Promise<void> {
  const started = Date.now()
  try {
    const result = await dispatch(request)
    writeResult(request.id, result)
    if (request.method !== 'ping') {
      log(`[sidecar] ${request.method} ok (${Date.now() - started}ms)`)
    }
  } catch (error) {
    // 健壮性的核心：单个请求失败只回一帧错误，进程继续活着。
    log(`[sidecar] ${request.method} 失败：${String(error instanceof Error ? error.stack ?? error.message : error)}`)
    writeError(request.id, toRpcError(error))
  }

  if (request.method === 'shutdown') {
    // 应答已经写出去（成功或失败都无所谓），现在才轮到退出。
    await exitGracefully(0, '收到 shutdown 请求')
  }
}

log(`[sidecar] 启动 pid=${process.pid} node=${process.version} ` +
  `${PI_AGENT_DIR_ENV}=${provisionalAgentDir}`)

const stopReading = readRequests(
  (request) => {
    if (exiting) return
    // readRequests 是同步回调，这里绝不能 await —— 否则会阻塞 stdin 的解析。
    void handle(request)
  },
  () => {
    // stdin 关闭 = 主进程没了。必须主动退出，否则会留下孤儿进程。
    void exitGracefully(0, 'stdin 已关闭')
  }
)

// 被 kill / Ctrl-C 时也走清理路径，尽量不留半开的会话。
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void exitGracefully(0, `收到 ${signal}`)
  })
}
