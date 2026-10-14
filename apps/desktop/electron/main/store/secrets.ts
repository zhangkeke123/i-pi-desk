import { safeStorage } from 'electron'
import { getAppPaths } from '../paths.js'
import { readJson, writeJsonAtomic } from './json-store.js'

/**
 * API Key 的加密存储。
 *
 * 用 Electron 的 safeStorage：Windows 走 DPAPI、macOS 走 Keychain、Linux 走
 * libsecret。密文与「当前操作系统用户」绑定 —— 把 secrets.json 拷到别的机器或
 * 别的用户下都解不开，这正是我们想要的。
 *
 * 落盘格式：{ "<apiKeyRef>": "<base64 密文>" }
 */

type SecretsFile = Record<string, string>

let cache: SecretsFile | null = null

function load(): SecretsFile {
  if (cache) return cache
  cache = readJson<SecretsFile>(getAppPaths().secrets, {})
  return cache
}

function persist(): void {
  if (!cache) return
  writeJsonAtomic(getAppPaths().secrets, cache)
}

export function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/**
 * 写入一个密钥。
 *
 * Linux 上若系统没有可用的 keyring，safeStorage 会不可用。此时**拒绝写入**而不是
 * 退回明文 —— 静默降级成明文存储是最危险的做法：用户以为密钥被加密了。
 */
export function setSecret(ref: string, plaintext: string): void {
  if (!isEncryptionAvailable()) {
    throw Object.assign(new Error('当前系统没有可用的密钥环（safeStorage 不可用），拒绝以明文保存 API Key'), {
      code: 'SECRET_STORAGE_UNAVAILABLE'
    })
  }
  const file = load()
  file[ref] = safeStorage.encryptString(plaintext).toString('base64')
  persist()
}

export function getSecret(ref: string | undefined): string | undefined {
  if (!ref) return undefined
  const file = load()
  const encoded = file[ref]
  if (!encoded) return undefined

  // 换了机器/用户后解密会抛异常。返回 undefined 让上层提示「密钥失效，请重填」，
  // 而不是让整个 prompt 流程崩掉。
  try {
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
  } catch {
    return undefined
  }
}

export function hasSecret(ref: string | undefined): boolean {
  if (!ref) return false
  return Boolean(load()[ref])
}

export function deleteSecret(ref: string | undefined): void {
  if (!ref) return
  const file = load()
  if (!(ref in file)) return
  delete file[ref]
  persist()
}
