import { randomUUID } from 'node:crypto'
import {
  IPC,
  type ProviderConfig,
  type ProviderVerifyResult,
  type ProviderView
} from '@i-pi-desk/shared'
import { deleteProvider, listProviders, upsertProvider } from '../store/settings.js'
import { deleteSecret, getSecret, hasSecret, setSecret } from '../store/secrets.js'
import { resolveRunApiKey } from '../store/provider-key.js'
import type { AppContext } from '../context.js'
import { arg, handle, requireString } from './wrap.js'

/**
 * provider 配置域。
 *
 * 密钥纪律：进出的 `ProviderConfig` 只带 `apiKeyRef`，**明文 key 只在 save/verify
 * 这两个方法的入参里出现一次**，且绝不写进 settings.json。
 * 渲染层拿到的 provider 列表里，密钥字段被替换成 `hasApiKey: boolean`。
 */

function toView(provider: ProviderConfig): ProviderView {
  return { ...provider, hasApiKey: hasSecret(provider.apiKeyRef) }
}

export function registerProviderIpc(ctx: AppContext): void {
  handle<ProviderView[]>(IPC.invoke.providerList, () => listProviders().map(toView))

  handle<ProviderView>(IPC.invoke.providerSave, (_event, ...args) => {
    const input = arg<{ provider: ProviderConfig; apiKey?: string }>(args, 0)
    const incoming = input?.provider
    if (!incoming || typeof incoming !== 'object') {
      throw Object.assign(new Error('缺少 provider 配置'), { code: 'BAD_REQUEST' })
    }

    // 新 provider 需要先有一个 ref 才能挂密钥；复用时沿用旧 ref，避免 UI 不回传导致密钥丢失。
    const apiKeyRef = incoming.apiKeyRef ?? (input.apiKey ? `provider:${incoming.id || randomUUID()}` : undefined)

    if (input.apiKey) {
      if (!apiKeyRef) {
        throw Object.assign(new Error('无法为 provider 生成密钥引用'), { code: 'BAD_REQUEST' })
      }
      // setSecret 在系统无密钥环时会抛 SECRET_STORAGE_UNAVAILABLE，直接冒泡给 UI，
      // 让它明确告诉用户「这台机器不能安全保存密钥」。
      setSecret(apiKeyRef, input.apiKey)
    }

    const saved = upsertProvider({ ...incoming, apiKeyRef })
    /**
     * 这里曾经广播一条 `provider-changed`（而且发在**会话**通道上）。
     *
     * 它没有任何消费方：渲染层保存 provider 后自己会把返回值写进 store，
     * 不需要别人再通知一次。一条没人听的广播不只是无用 ——
     * 它会让后来的人以为「改 provider 会自动同步到界面」，
     * 而实际上并没有这回事。所以删掉，而不是留着。
     */
    return toView(saved)
  })

  handle<{ id: string }>(IPC.invoke.providerDelete, (_event, ...args) => {
    const id = requireString(args[0], 'providerId')
    const existing = listProviders().find((p) => p.id === id)
    deleteProvider(id)
    // 顺手清掉密钥密文，不留无主密文。
    deleteSecret(existing?.apiKeyRef)
    return { id }
  })

  handle<ProviderVerifyResult>(IPC.invoke.providerVerify, async (_event, ...args) => {
    const input = arg<{ provider: ProviderConfig; apiKey?: string }>(args, 0)
    if (!input?.provider) {
      throw Object.assign(new Error('缺少 provider 配置'), { code: 'BAD_REQUEST' })
    }

    // 未传新 key 时用已存的密文；仍然没有就按 provider-key.ts 的规则解析 ——
    // 否则「测试连接」会对本地 Ollama 报「缺 key」，而那正是最该能测通的一类端点。
    const apiKey = input.apiKey ?? getSecret(input.provider.apiKeyRef)
    const resolved = apiKey ? { apiKey, placeholder: false } : resolveRunApiKey(input.provider, undefined)

    return ctx.supervisor.request<ProviderVerifyResult>('provider.verify', {
      provider: input.provider,
      apiKey: resolved.apiKey
    })
  })
}
