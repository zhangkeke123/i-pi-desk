import type {
  ControlPlaneAuditEvent,
  ControlPlaneLoginInput,
  ControlPlaneModelConfig,
  ControlPlaneQuota,
  ControlPlaneSkill,
  ControlPlaneStatus,
  ControlPlaneSyncResult,
  ControlPlaneUser,
  ProviderConfig
} from '@i-pi-desk/shared'
import { getAppPaths } from '../paths.js'
import { installSkillIn, listSkillsIn, removeSkillIn } from './skill-files.js'
import { readJson, writeJsonAtomic } from './json-store.js'
import { getSettings, updateSettings, listProviders, upsertProvider, deleteProvider } from './settings.js'
import { deleteSecret, getSecret, setSecret } from './secrets.js'
import { isLoopbackOrPrivateHost } from './provider-key.js'
import { piAgentDir } from './pi-config.js'

/**
 * 控制面客户端。
 *
 * ## 三条设计约束
 *
 * 1. **不在热路径上**。没配控制面时应用功能完整；配了之后，模型配置与技能从控制面下发。
 *    **任何一次 prompt 都不依赖控制面在线** —— 这是「本地热路径永不联网」的落地。
 * 2. **令牌纪律**。token 走 `secrets.json`（系统密钥环加密），绝不进 settings.json、
 *    绝不出现在日志里。它和 provider 的 API Key 是同一条纪律。
 * 3. **同步只替换「控制面来源」的东西**。用户手工加的 provider 永远不会被一次同步清掉 ——
 *    否则「我在控制面上配错了一次」会连带删掉用户本地的配置。
 *
 * ## 审计上报的边界
 *
 * 只上报**用量与元数据**（发生了什么类型的事、哪个模型、多少 token、什么时候），
 * **不上报对话内容与代码**。这条边界写在契约里（control-plane.ts）也写在这里，
 * 因为「审计」这个词很容易被理解成「把用户的东西都传走」。
 */

/** token 在 secrets.json 里的引用名。 */
const TOKEN_REF = 'control-plane:token'

/** 单次请求超时。控制面是内网服务，超过这个时间基本可以认为挂了。 */
const REQUEST_TIMEOUT_MS = 15_000

/** 审计队列上限。控制面长时间不可用时不能无限吃内存。 */
const AUDIT_QUEUE_LIMIT = 500

export class ControlPlaneError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ControlPlaneError'
    this.code = code
  }
}

/** 持久化的非敏感状态（用户信息与同步时间）。token 不在这里。 */
interface ControlPlaneStateFile {
  user?: ControlPlaneUser
  lastSyncAt?: string
  /** 最近一次失败原因。留档是为了让用户重启后还能看到「上次为什么没同步上」。 */
  lastError?: string
  /** 我们下发过哪些技能 —— 用于在控制面删除某个技能后，本地也能跟着清掉。 */
  managedSkills?: string[]
}

const auditQueue: ControlPlaneAuditEvent[] = []

function stateFile(): string {
  return `${getAppPaths().userData}/control-plane.json`
}

function readState(): ControlPlaneStateFile {
  return readJson<ControlPlaneStateFile>(stateFile(), {})
}

function writeState(patch: Partial<ControlPlaneStateFile>): void {
  writeJsonAtomic(stateFile(), { ...readState(), ...patch })
}

function baseUrl(): string | undefined {
  const url = getSettings().controlPlaneUrl?.trim()
  return url ? url.replace(/\/+$/, '') : undefined
}

/**
 * 明文 HTTP 的目标是否属于「内网/回环」。
 *
 * 内网私有化部署用 http 是常态，所以这里只用于**给出警告**，不作为放行条件。
 * 判定逻辑与 provider 的「本地端点」共用一份（store/provider-key.ts），
 * 免得两处对「什么算内网」给出不同答案。
 */

function insecureWarningFor(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:') return undefined
    if (isLoopbackOrPrivateHost(parsed.hostname)) return undefined
    return `控制面地址使用了明文 HTTP 且目标不是内网地址（${parsed.hostname}）。凭据与配置会以明文传输，建议改用 HTTPS。`
  } catch {
    return undefined
  }
}

export function getStatus(): ControlPlaneStatus {
  const url = baseUrl()
  const state = readState()
  const status: ControlPlaneStatus = {
    configured: Boolean(url),
    loggedIn: Boolean(url && getSecret(TOKEN_REF))
  }
  if (url) status.url = url
  if (state.user) status.user = state.user
  if (state.lastSyncAt) status.lastSyncAt = state.lastSyncAt
  if (state.lastError) status.lastError = state.lastError
  const warning = insecureWarningFor(url)
  if (warning) status.insecureWarning = warning
  return status
}

/**
 * 发一个控制面请求。
 *
 * 令牌只放在 Authorization 头里，**不进 URL**（URL 会进日志、进代理记录、进浏览器历史）。
 */
async function request<T>(path: string, init: RequestInit & { auth?: boolean } = {}): Promise<T> {
  const url = baseUrl()
  if (!url) throw new ControlPlaneError('NOT_CONFIGURED', '还没有配置控制面地址')

  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  if (init.body) headers.set('Content-Type', 'application/json')

  if (init.auth !== false) {
    const token = getSecret(TOKEN_REF)
    if (!token) throw new ControlPlaneError('AUTH_REQUIRED', '尚未登录控制面')
    headers.set('Authorization', `Bearer ${token}`)
  }

  let response: Response
  try {
    response = await fetch(`${url}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeState({ lastError: message })
    throw new ControlPlaneError('NETWORK', `无法连接控制面（${url}）：${message}`)
  }

  if (response.status === 401 || response.status === 403) {
    // 令牌失效就地清掉，避免后续每个请求都白跑一趟再失败。
    // 注意**不**把响应体当作错误信息往外抛 —— 它可能含服务端内部细节。
    deleteSecret(TOKEN_REF)
    writeState({ user: undefined })
    throw new ControlPlaneError('AUTH_REQUIRED', '控制面登录已失效，请重新登录')
  }

  if (!response.ok) {
    throw new ControlPlaneError('HTTP_ERROR', `控制面返回 ${response.status} ${response.statusText}（${path}）`)
  }

  try {
    return (await response.json()) as T
  } catch {
    throw new ControlPlaneError('BAD_RESPONSE', `控制面返回的不是合法 JSON（${path}）`)
  }
}

export async function login(input: ControlPlaneLoginInput): Promise<ControlPlaneStatus> {
  const url = input.url.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(url)) {
    throw new ControlPlaneError('INVALID_URL', '控制面地址必须以 http:// 或 https:// 开头')
  }
  // 先写地址再请求 —— request() 从设置里读地址。
  updateSettings({ controlPlaneUrl: url })

  const result = await request<{ token: string; user: ControlPlaneUser }>('/api/auth/login', {
    method: 'POST',
    auth: false,
    body: JSON.stringify({ username: input.username, password: input.password })
  })

  if (!result?.token || typeof result.token !== 'string') {
    throw new ControlPlaneError('BAD_RESPONSE', '控制面登录响应缺少 token')
  }

  setSecret(TOKEN_REF, result.token)
  writeState({ user: result.user, lastError: undefined })
  return getStatus()
}

export function logout(): ControlPlaneStatus {
  deleteSecret(TOKEN_REF)
  writeState({ user: undefined })
  return getStatus()
}

export async function fetchQuota(): Promise<ControlPlaneQuota> {
  return request<ControlPlaneQuota>('/api/quota')
}

// ───────────────────────────── 同步 ─────────────────────────────

async function fetchModelConfig(): Promise<ControlPlaneModelConfig> {
  return request<ControlPlaneModelConfig>('/api/config/models')
}

async function fetchSkills(): Promise<ControlPlaneSkill[]> {
  const result = await request<{ skills: ControlPlaneSkill[] }>('/api/skills')
  return Array.isArray(result?.skills) ? result.skills : []
}

/**
 * 落模型配置。
 *
 * 合并策略：**保留本地 provider，整体替换控制面 provider**。
 * 这样「控制面配错了」最多影响它自己下发的那部分，不会连带清掉用户手工配置。
 */
function applyModelConfig(config: ControlPlaneModelConfig): number {
  const incoming = Array.isArray(config?.providers) ? config.providers : []

  // 先删掉旧的「控制面来源」，再写入新的 —— 顺序反了会把刚写的也删掉。
  for (const provider of listProviders()) {
    if (provider.source === 'control-plane') deleteProvider(provider.id)
  }

  const now = new Date().toISOString()
  for (const provider of incoming) {
    if (!provider?.id) continue
    upsertProvider({
      ...provider,
      source: 'control-plane',
      // 控制面下发的配置不带本地密钥引用（密钥由控制面自己的端点代理或由用户本地填）。
      apiKeyRef: provider.apiKeyRef,
      createdAt: provider.createdAt ?? now,
      updatedAt: now
    })
  }

  const patch: { defaultProviderId?: string; defaultModelId?: string } = {}
  if (config.defaultProviderId) patch.defaultProviderId = config.defaultProviderId
  if (config.defaultModelId) patch.defaultModelId = config.defaultModelId
  if (Object.keys(patch).length > 0) updateSettings(patch)

  return incoming.length
}

/**
 * 落技能。
 *
 * 有一个**必须报出来的失败模式**：控制面下发的技能名如果不合规（大写、下划线…），
 * `installSkillIn` 会拒绝。静默丢弃会让用户以为配置生效了 —— 所以收集成 `skipped` 返回。
 */
function applySkills(skills: ControlPlaneSkill[]): ControlPlaneSyncResult['skills'] {
  const dir = `${piAgentDir()}/skills`
  const previous = new Set(readState().managedSkills ?? [])
  const seen = new Set<string>()
  let added = 0
  let updated = 0
  const skipped: string[] = []

  const existing = new Set(listSkillsIn(dir).map((skill) => skill.name))

  for (const skill of skills) {
    if (!skill?.name || typeof skill.content !== 'string') continue
    try {
      installSkillIn(dir, skill.name, skill.content)
    } catch (error) {
      skipped.push(`${skill.name}（${error instanceof Error ? error.message : String(error)}）`)
      continue
    }
    seen.add(skill.name)
    if (existing.has(skill.name)) updated += 1
    else added += 1
  }

  // 清掉「上次由控制面下发、这次不再下发」的技能。
  // 只动我们自己下发的（previous 里记着的），用户手工放的技能不碰。
  let removed = 0
  for (const name of previous) {
    if (seen.has(name)) continue
    try {
      removeSkillIn(dir, name)
      removed += 1
    } catch {
      // 用户可能已经手动删了。这不是错误。
    }
  }

  writeState({ managedSkills: [...seen] })
  return { added, updated, removed, skipped }
}

export async function sync(): Promise<ControlPlaneSyncResult> {
  // 先取数据再落盘：网络失败时本地配置保持原样，不会出现「删了旧的、新的没拿到」。
  const [modelConfig, skills] = await Promise.all([fetchModelConfig(), fetchSkills()])

  const providers = applyModelConfig(modelConfig)
  const skillResult = applySkills(skills)
  const syncedAt = new Date().toISOString()
  writeState({ lastSyncAt: syncedAt, lastError: undefined })

  return {
    providers,
    defaultProviderId: modelConfig.defaultProviderId,
    defaultModelId: modelConfig.defaultModelId,
    skills: skillResult,
    syncedAt
  }
}

// ───────────────────────────── 审计 ─────────────────────────────

export function recordAuditEvent(event: ControlPlaneAuditEvent): void {
  if (!getSecret(TOKEN_REF)) return
  if (auditQueue.length >= AUDIT_QUEUE_LIMIT) auditQueue.shift()
  auditQueue.push(event)
}

export function pendingAuditCount(): number {
  return auditQueue.length
}

/**
 * 推送积压的审计事件。
 *
 * 失败时**保留队列**（下次再试），而不是清空 —— 审计数据丢了就再也补不回来。
 * 但队列有上限，且控制面不可用时不会阻塞任何本地功能。
 */
export async function flushAudit(): Promise<{ sent: number; pending: number }> {
  if (auditQueue.length === 0) return { sent: 0, pending: 0 }
  if (!baseUrl() || !getSecret(TOKEN_REF)) return { sent: 0, pending: auditQueue.length }

  const batch = [...auditQueue]
  await request('/api/audit/events', { method: 'POST', body: JSON.stringify({ events: batch }) })

  // 只移除确实发出去的那批：期间可能有新事件入队。
  auditQueue.splice(0, batch.length)
  return { sent: batch.length, pending: auditQueue.length }
}

/** 供 UI 显示「控制面 provider 是只读的」。 */
export function isManagedProvider(provider: ProviderConfig): boolean {
  return provider.source === 'control-plane'
}
