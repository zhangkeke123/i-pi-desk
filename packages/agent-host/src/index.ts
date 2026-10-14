/**
 * `@i-pi-desk/agent-host` 库入口。
 *
 * 进程入口是 `./sidecar`（package.json 的 exports 子路径），这里导出可复用的部分，
 * 便于单测直接驱动 `AgentRuntime` 而不必走 stdio 协议。
 */

export { AgentRuntime, RuntimeFailure } from './runtime.js'
export type { AgentRuntimeOptions } from './runtime.js'

export { toPiProviderInput, toPiProviderModel, verifyProvider, registerPiProvider, describeError } from './provider.js'
export type { VerifyProviderOptions } from './provider.js'

export {
  bindProvisionalAgentDir,
  fallbackAgentDir,
  IPI_DESK_AGENT_DIR_ENV,
  PI_AGENT_DIR_ENV,
  PI_SESSION_DIR_ENV
} from './isolation.js'

export {
  log,
  readRequests,
  toRpcError,
  writeAgentEvent,
  writeError,
  writeResult
} from './protocol.js'

export { approvalFingerprint, createApprovalExtension, riskOf } from './approval.js'
export type { ApprovalDecision, ApprovalGateOptions, ApprovalRequest } from './approval.js'

export { toChatMessage, translateEvent } from './translate.js'
export type { TranslateContext } from './translate.js'
