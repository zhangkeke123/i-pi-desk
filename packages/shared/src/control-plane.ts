/**
 * 控制面接入点的**跨边界契约**。
 *
 * ## 定位：控制面是「管理服务」，不是 agent 运行时
 *
 * 它只做四件事：**认证 / 配置下发 / 技能分发 / 审计与配额**。
 * agent 循环仍然完全在本地 sidecar 里 —— 这是「本地热路径永不联网」这条铁律的具体含义：
 * 写代码时的模型推理可以走内网端点，但**任何一次 prompt 都不依赖控制面在线**。
 *
 * ## 为什么这些类型放在 shared
 *
 * 它们同时被三方使用：主进程（发请求、写盘）、渲染层（显示状态与配额）、
 * 以及将来的 Java 控制面（作为接口契约的参考实现）。
 * 后者尤其重要 —— `docs/CONTROL-PLANE.md` 里的 HTTP 契约与这里的类型是同一份东西的两种表述，
 * 放在一起才不会漂移。
 *
 * ## 密钥与令牌纪律
 *
 * `token` 是凭据，走 `secrets.json`（系统密钥环加密），**绝不进 settings.json**，
 * 也绝不出现在日志里。这和 provider 的 API Key 是同一条纪律。
 */

import type { ProviderConfig } from './types.js'

/** 控制面连接状态。UI 据此决定显示登录表单还是已登录信息。 */
export interface ControlPlaneStatus {
  /** 是否配置了地址。 */
  configured: boolean
  url?: string
  loggedIn: boolean
  user?: ControlPlaneUser
  /**
   * 明文 HTTP 且目标不是内网/回环地址时的警告文案。
   *
   * 刻意**只警告不阻断**：私有化部署的客户内网用 http 是常态，
   * 硬拦会把主要场景挡在门外。但用户有权知道自己正在明文传输凭据。
   */
  insecureWarning?: string
  /** 上次同步时间，便于 UI 显示「配置有多旧」。 */
  lastSyncAt?: string
  lastError?: string
}

export interface ControlPlaneUser {
  id: string
  name: string
  roles: string[]
}

export interface ControlPlaneLoginInput {
  url: string
  username: string
  password: string
}

/** 控制面下发的模型配置。 */
export interface ControlPlaneModelConfig {
  providers: ProviderConfig[]
  defaultProviderId?: string
  defaultModelId?: string
}

/** 控制面下发的技能。`content` 是完整的 SKILL.md 文本。 */
export interface ControlPlaneSkill {
  name: string
  description?: string
  version?: string
  content: string
}

/** 配额。`limitTokens <= 0` 表示不限量。 */
export interface ControlPlaneQuota {
  usedTokens: number
  limitTokens: number
  /** ISO 时间；配额窗口的重置时刻。 */
  resetAt?: string
}

/** 同步结果。分开计数是为了让 UI 能说清「改了 3 个模型、新增 2 个技能」。 */
export interface ControlPlaneSyncResult {
  providers: number
  defaultProviderId?: string
  defaultModelId?: string
  skills: {
    added: number
    updated: number
    removed: number
    /** 名字不合法、被内核拒绝因而跳过的技能 —— 必须报出来，不能静默丢。 */
    skipped: string[]
  }
  syncedAt: string
}

/**
 * 审计事件：一次 run 的用量。
 *
 * 只上报**用量与元数据**，不上报对话内容 —— 这条边界要在契约里写明，
 * 否则「审计」很容易被理解成「把用户的代码和对话都传走」。
 * 我们上报：发生了什么类型的事、用了哪个模型、多少 token、什么时候。
 */
export interface ControlPlaneAuditEvent {
  /**
   * `run.failed` 也要上报：审计的意义恰恰在于**失败也要留痕**。
   * 只报成功的用量，会让「这个模型老是超时」这类问题永远看不出来。
   */
  type: 'run.completed' | 'run.failed' | 'tool.approved' | 'tool.denied'
  sessionId: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  toolName?: string
  /** 失败时的原因（截断后上报，避免把整段堆栈塞进去）。 */
  error?: string
  at: string
}
