import type { ProviderConfig } from '@i-pi-desk/shared'

/**
 * provider 在「一次 run」里该用哪个 key。
 *
 * ## 为什么需要占位 key
 *
 * pi 的 OpenAI 适配层要求 `Authorization` 头 **必须存在** —— 没有 key 就直接报
 * `No API key found for <provider>` 并结束这一轮，连请求都不会发出去。
 *
 * 但**本地/内网推理端点通常不校验 key**：Ollama、llama.cpp、大多数内网 vLLM 部署
 * 都是这样。于是「用户把应用指向本机 Ollama」这个我们最主打的场景会直接跑不起来，
 * 报一个和真实问题无关的错误。
 *
 * 官方文档里给 Ollama 的例子就是 `"apiKey": "ollama"` —— 一个约定的哑值。
 * 这里做的是同一件事，只是把「什么时候该给哑值」的判断收到一处。
 *
 * ## 规则（刻意区分三种情况，而不是一刀切）
 *
 * | 情况 | 行为 | 理由 |
 * |---|---|---|
 * | 配了 `apiKeyRef` 但密钥取不到 | **报错** `PROVIDER_KEY_MISSING` | 用户配置过，是我们这边丢了（换机器后密钥环解不开）—— 这是可行动的错误 |
 * | 没配 `apiKeyRef` 且端点是本机/内网 | 用占位 key | 这正是「不需要鉴权的内网端点」，是主场景 |
 * | 没配 `apiKeyRef` 且端点是公网 | **报错** `PROVIDER_KEY_MISSING` | 公网服务几乎都要 key，多半是忘了配；此时报「缺 key」比发出去换一个 401 有用得多 |
 *
 * 最后一条是刻意保留的：一刀切地注入占位 key 会把「用户忘了配 key」变成一个
 * 语焉不详的 401，而「缺 API Key」才是能让人立刻动手的错误。
 */

/**
 * 发给「不需要鉴权的端点」的占位 key。
 *
 * 取值刻意**不像**任何真实 key 的格式（没有 `sk-` 前缀）：万一它出现在服务端日志里，
 * 一眼就能看出这是客户端占位，而不是某个真实凭据泄漏了。
 */
export const LOCAL_NO_AUTH_API_KEY = 'ipi-local-no-auth'

/** 本机/内网地址判断。控制面的明文 HTTP 告警也复用这一份。 */
export function isLoopbackOrPrivateHost(hostname: string): boolean {
  if (!hostname) return false
  if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(hostname)) return true
  if (/^10\./.test(hostname)) return true
  if (/^192\.168\./.test(hostname)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true
  if (/\.(local|internal|lan|corp)$/i.test(hostname)) return true
  // 不带点的主机名在内网里很常见（如 `gpu-node-01`）。
  if (!hostname.includes('.')) return true
  return false
}

function endpointIsPrivate(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    return isLoopbackOrPrivateHost(new URL(baseUrl).hostname)
  } catch {
    return false
  }
}

export interface ResolvedApiKey {
  /** 传给内核的 key。undefined 表示让内核自己报「缺 key」。 */
  apiKey?: string
  /** 是否用了占位 key（调用方应当记日志，便于排查「为什么没有真凭据」）。 */
  placeholder: boolean
  /** 需要 key 但拿不到时的错误码。 */
  errorCode?: 'PROVIDER_KEY_MISSING'
  errorMessage?: string
}

/**
 * 决定一次 run 用哪个 key。
 *
 * @param secret 主进程从密钥环里取到的明文（没有则为 undefined）。
 */
export function resolveRunApiKey(provider: ProviderConfig, secret: string | undefined): ResolvedApiKey {
  if (provider.apiKeyRef) {
    if (secret) return { apiKey: secret, placeholder: false }
    return {
      placeholder: false,
      errorCode: 'PROVIDER_KEY_MISSING',
      errorMessage: `provider「${provider.label}」的 API Key 读取失败（可能是换机器或换系统用户后密钥环解不开了），请在设置里重新填写`
    }
  }

  if (endpointIsPrivate(provider.baseUrl)) {
    return { apiKey: LOCAL_NO_AUTH_API_KEY, placeholder: true }
  }

  return {
    placeholder: false,
    errorCode: 'PROVIDER_KEY_MISSING',
    errorMessage: `provider「${provider.label}」缺少 API Key，请在设置里填写（该端点不是本机/内网地址，通常需要鉴权）`
  }
}
