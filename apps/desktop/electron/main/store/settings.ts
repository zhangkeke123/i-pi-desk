import { randomUUID } from 'node:crypto'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type ProviderConfig
} from '@i-pi-desk/shared'
import { getAppPaths } from '../paths.js'
import { readJson, writeJsonAtomic } from './json-store.js'
import { readInstallDefaults } from './install-defaults.js'

/**
 * 设置与 provider 配置的读写。
 *
 * 关键约束：**这里永远不落明文 API Key**。
 * provider 只保存 `apiKeyRef`（一个指针），明文由 secrets.ts 用 safeStorage 单独加密落盘。
 * 这样 settings.json 可以安全地被备份、导出、贴进工单，而密钥不会跟着走。
 */

interface SettingsFile {
  app: AppSettings
  providers: ProviderConfig[]
}

let cache: SettingsFile | null = null

function defaults(): SettingsFile {
  return { app: { ...DEFAULT_SETTINGS }, providers: [] }
}

function load(): SettingsFile {
  if (cache) return cache
  const raw = readJson<Partial<SettingsFile>>(getAppPaths().settings, {})
  const base = defaults()
  const app = { ...base.app, ...(raw.app ?? {}) }
  // 安装预置：仅当用户尚未配置默认工作空间时写入一次并落盘。
  if (!app.defaultWorkspacePath?.trim()) {
    const install = readInstallDefaults()
    const preset = install.defaultWorkspacePath?.trim()
    if (preset) {
      app.defaultWorkspacePath = preset
      cache = {
        app,
        providers: Array.isArray(raw.providers) ? raw.providers.map(normalizeProvider) : []
      }
      persist()
      return cache
    }
  }
  cache = {
    // 逐字段合并而不是整体替换：新版本新增的设置项，旧配置文件里没有也能拿到默认值。
    app,
    providers: Array.isArray(raw.providers) ? raw.providers.map(normalizeProvider) : []
  }
  return cache
}

function persist(): void {
  if (!cache) return
  writeJsonAtomic(getAppPaths().settings, cache)
}

/** 防御性归一：磁盘上的配置可能是被手改过的，缺字段不能把 UI 打崩。 */
function normalizeProvider(input: ProviderConfig): ProviderConfig {
  return {
    id: input.id || randomUUID(),
    label: input.label || 'Unnamed provider',
    apiStyle: input.apiStyle ?? 'openai-compatible',
    baseUrl: input.baseUrl,
    apiKeyRef: input.apiKeyRef,
    models: Array.isArray(input.models) ? input.models : [],
    enabled: input.enabled !== false,
    // ⚠️ `source` 必须保留。它决定控制面同步时「哪些 provider 是可以整体替换的」——
    // 丢了这个字段，同步就认不出上次下发的那些，于是每同步一次就堆积一份重复配置。
    // （这正是被 verify:renderer 里「落盘的 provider 标记为控制面来源」那条断言抓到的 bug。）
    source: input.source === 'control-plane' ? 'control-plane' : 'local',
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString()
  }
}

export function getSettings(): AppSettings {
  return load().app
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const file = load()
  file.app = { ...file.app, ...patch }
  persist()
  return file.app
}

export function listProviders(): ProviderConfig[] {
  return load().providers
}

export function getProvider(id: string): ProviderConfig | undefined {
  return load().providers.find((p) => p.id === id)
}

export function upsertProvider(input: ProviderConfig): ProviderConfig {
  const file = load()
  const now = new Date().toISOString()
  const existingIndex = file.providers.findIndex((p) => p.id === input.id)

  if (existingIndex === -1) {
    const created = normalizeProvider({ ...input, createdAt: now, updatedAt: now })
    file.providers.push(created)
    persist()
    return created
  }

  const merged = normalizeProvider({ ...file.providers[existingIndex], ...input, updatedAt: now })
  file.providers[existingIndex] = merged
  persist()
  return merged
}

export function deleteProvider(id: string): void {
  const file = load()
  file.providers = file.providers.filter((p) => p.id !== id)

  // 删 provider 时顺手把它的密钥一起删掉，避免留下无主的密文。
  if (file.app.defaultProviderId === id) {
    file.app.defaultProviderId = undefined
    file.app.defaultModelId = undefined
  }
  persist()
}
