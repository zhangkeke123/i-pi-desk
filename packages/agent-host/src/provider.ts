/**
 * pi provider 适配层：把自有的 `ProviderConfig` 编译成 pi 1.1.0 的 provider 输入，
 * 并提供 `provider.verify` 的最小验证实现。
 *
 * ## 为什么不走 `models.json` / 环境变量占位符
 *
 * `packages/shared/src/pi-provider.ts` 里那套（`buildPiModelsFile` 写盘 +
 * `providerEnvVarName` 注入 env）已经被主进程侧的决定废弃：
 *
 *  1. `models.json` 需要落盘，而 provider 的 baseUrl / 模型清单只活在本次进程里，
 *     为它写一个临时文件既慢又多一处「密钥/配置会不会被读到」的表面；
 *  2. `ModelRuntime.registerProvider(id, config)` 是 1.1.0 的正规扩展 provider 入口，
 *     `apiKey` 可以只作为**内存对象**传进去，天然不落盘。
 *
 * 所以本文件所有 provider 都通过 `registerProvider` 注册，密钥只存在于内存。
 *
 * ## 一个必须记住的坑（实测结论，与 `.d.ts` 的宽松处冲突，以实测为准）
 *
 * `ProviderConfigInput.models` 的类型允许只写 `{ id }`（其它字段都 optional），
 * 但**注册未知 provider（即不在 pi 内置目录里的自建 provider）时不会补默认值**：
 * `provider-composer.js` 的 `extensionModelFromDefinition()` 只是
 * `{ ...definition, api, provider, baseUrl, headers }`，不像 `modelFromJson()` 那样兜
 * `contextWindow: 128000` / `maxTokens: 16384` / `cost` / `input`。
 *
 * 实测（本地假 OpenAI 端点 + `models: [{ id: 'probe-model' }]`）：
 *   completeSimple 立刻返回 `stopReason: 'error'`，
 *   `errorMessage = "Cannot read properties of undefined (reading 'includes')"`
 * —— 补全字段后同一请求才真正发到网络上（"Connection error."）。
 *
 * 因此下面 `toPiProviderModel()` 一定把 `input` / `cost` / `contextWindow` /
 * `maxTokens` / `reasoning` 全部填满。
 */

import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { ProviderConfig, ProviderModel, ProviderVerifyParams, ProviderVerifyResult } from '@i-pi-desk/shared'

/**
 * 自有的 apiStyle → pi 认识的 api id。
 *
 * 注意：`packages/shared/src/pi-provider.ts` 里那个同名的 `toPiApi` 已经随
 * `buildPiModelsFile` 一起被删掉了（models.json 路线废弃），所以这里自带一份。
 * `openai-compatible` 是俗称，pi 里叫 `openai-completions`；其余同名字符串直传。
 */
function toPiApi(style: ProviderConfig['apiStyle']): string {
  return style === 'openai-compatible' ? 'openai-completions' : style
}

/** `ProviderConfigInput` 没有从包根导出，用方法签名把它取出来，避免手抄结构。 */
type PiProviderConfigInput = Parameters<ModelRuntime['registerProvider']>[1]
type PiProviderModelConfig = NonNullable<PiProviderConfigInput['models']>[number]
/** `Api` 也没从包根导出；provider 级别的 api 字段就是它。 */
type PiApi = NonNullable<PiProviderConfigInput['api']>

/**
 * 未知模型的兜底元数据。
 *
 * 我们的 `ProviderModel` 只有 id / label / contextWindow / supportsTools /
 * supportsReasoning，没有价格表和输出上限。价格填 0 而不是编一个数字：
 * `translate.ts` 已经约定 `cost.total === 0` 视为「没有价格表」，不冒充免费。
 */
const FALLBACK_CONTEXT_WINDOW = 128_000
const FALLBACK_MAX_TOKENS = 16_384

/** 把一个自有模型编译成 pi 的 chat 模型定义（字段必须齐全，见文件头注释）。 */
export function toPiProviderModel(provider: ProviderConfig, model: ProviderModel): PiProviderModelConfig {
  return {
    type: 'chat',
    id: model.id,
    name: model.label || model.id,
    api: toPiApi(provider.apiStyle) as PiApi,
    // 自有 ProviderModel 没有描述输入模态，保守按纯文本声明。
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: model.supportsReasoning ?? false,
    contextWindow: model.contextWindow ?? FALLBACK_CONTEXT_WINDOW,
    maxTokens: FALLBACK_MAX_TOKENS
  }
}

/**
 * 编译 provider 注册输入。
 *
 * `modelId` 用于兜底：主进程可能请求一个没写进 `provider.models` 的模型（例如
 * 自动发现出来的），这时也要能注册成功，否则会在 `getModel` 处变成「模型不存在」。
 */
export function toPiProviderInput(
  provider: ProviderConfig,
  apiKey: string | undefined,
  modelId?: string
): PiProviderConfigInput {
  const models = provider.models.map((model) => toPiProviderModel(provider, model))
  if (modelId && !models.some((model) => model.id === modelId)) {
    models.push(
      toPiProviderModel(provider, { id: modelId, label: modelId, supportsTools: true, supportsReasoning: false })
    )
  }

  const input: PiProviderConfigInput = {
    name: provider.label || provider.id,
    api: toPiApi(provider.apiStyle) as PiApi,
    models
  }
  if (provider.baseUrl) input.baseUrl = provider.baseUrl
  // 密钥只在这里以内存字符串的形式交给 pi；不写盘、不进环境变量。
  if (apiKey !== undefined && apiKey !== '') input.apiKey = apiKey
  return input
}

/**
 * 把一个 provider 注册到给定的 ModelRuntime 上。
 *
 * 单独抽出来是为了让 runtime（会话）和 verify 用同一段编译逻辑 —— 否则
 * 「验证通过但真跑起来不一样」这类问题会很难查。
 */
export function registerPiProvider(
  runtime: ModelRuntime,
  provider: ProviderConfig,
  apiKey: string | undefined,
  modelId?: string
): void {
  // registerProvider 在 baseUrl 缺失时会同步抛错，这里先给出更可读的原因。
  if (!provider.baseUrl) {
    throw new Error(
      `provider "${provider.label || provider.id}" 未配置 baseUrl：pi 的自建 provider 必须有端点地址`
    )
  }
  runtime.registerProvider(provider.id, toPiProviderInput(provider, apiKey, modelId))
}

/** 沿 cause 链收集错误信息 —— 网络类错误的关键原因通常藏在 cause 里。 */
export function describeError(error: unknown): string {
  const messages: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (!messages.includes(current.message)) messages.push(current.message)
    current = current.cause
  }
  if (messages.length === 0) return String(error)
  return messages.join(' ← ')
}

export interface VerifyProviderOptions {
  /** 上游请求超时（毫秒）。默认 20s，避免「验证」把 UI 挂住。 */
  timeoutMs?: number
}

/** 最小验证只要求一个 token 级回复；给 16 留出个别 provider 的强制最小输出。 */
const VERIFY_MAX_TOKENS = 16
const DEFAULT_VERIFY_TIMEOUT_MS = 20_000

/**
 * `provider.verify`：发一条最小 completion 验证「端点可达 + 鉴权可用 + 模型名存在」。
 *
 * 约定：**任何失败都返回 `ok: false` + `message`，绝不抛**（主进程要把它渲染到设置页）。
 *
 * 已知限制（老实记在这里，不猜）：
 *  - `ProviderVerifyParams` 没有 modelId，所以只验证 `provider.models[0]`；
 *    provider 未声明模型时无法验证，直接返回 `ok: false`。
 *  - 未配密钥的本地无鉴权端点（Ollama 之类）在 pi 里仍然需要**任意**一个 key
 *    （pi 文档里给的例子就是 `"apiKey": "ollama"`）。这里不替主进程伪造 key，
 *    否则会出现「验证通过、真跑挂掉」的假阳性；错误原文会放进 message。
 */
export async function verifyProvider(
  params: ProviderVerifyParams,
  options: VerifyProviderOptions = {}
): Promise<ProviderVerifyResult> {
  const { provider, apiKey } = params
  const checkedBy = 'minimal-completion' as const

  const modelId = provider.models[0]?.id
  if (!modelId) {
    return {
      ok: false,
      checkedBy,
      message: `provider "${provider.label || provider.id}" 未声明任何模型，无法验证。请先填写模型 ID。`
    }
  }
  if (!provider.baseUrl) {
    return {
      ok: false,
      checkedBy,
      message: `provider "${provider.label || provider.id}" 未配置 baseUrl，无法验证。`
    }
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS

  // 注意：这里用一个**独立的**内存 ModelRuntime，不碰 agentDir，也不落盘任何文件。
  let runtime: ModelRuntime
  try {
    runtime = await ModelRuntime.create({ modelsPath: null })
  } catch (error) {
    return { ok: false, checkedBy, models: [modelId], message: `初始化模型运行时失败：${describeError(error)}` }
  }

  try {
    registerPiProvider(runtime, provider, apiKey, modelId)
  } catch (error) {
    return { ok: false, checkedBy, models: [modelId], message: describeError(error) }
  }

  const model = runtime.getModel(provider.id, modelId)
  if (!model) {
    return {
      ok: false,
      checkedBy,
      models: [modelId],
      message: `pi 未能解析出模型 ${provider.id}/${modelId}，请检查 apiStyle 与 baseUrl。`
    }
  }

  try {
    const message = await runtime.completeSimple(
      model,
      { messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }] },
      // maxRetries: 0 —— 验证要快速失败，不要把 UI 挂在 SDK 的默认重试上。
      { maxTokens: VERIFY_MAX_TOKENS, maxRetries: 0, timeoutMs }
    )
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      return {
        ok: false,
        checkedBy,
        models: [modelId],
        message: message.errorMessage ?? `上游以 ${message.stopReason} 结束，未返回可用回复。`
      }
    }
    return {
      ok: true,
      checkedBy,
      models: [modelId],
      message: `已用一次最小补全验证 ${modelId}（baseUrl: ${provider.baseUrl}）。`
    }
  } catch (error) {
    return { ok: false, checkedBy, models: [modelId], message: describeError(error) }
  }
}
