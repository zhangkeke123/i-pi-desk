/**
 * 谁可以走应用内更新。
 *
 * 只有打进系统的 NSIS 安装版能被新安装包替换。
 * 便携版是单文件，开发模式没有安装器，两者都不要下包。
 */

export type UpdateMode = 'disabled' | 'notify' | 'in-app'

export function resolveUpdateMode(input: {
  isPackaged: boolean
  platform: string
  portable: boolean
}): UpdateMode {
  if (!input.isPackaged) return 'disabled'
  if (input.platform !== 'win32') return 'disabled'
  if (input.portable) return 'notify'
  return 'in-app'
}

/** 便携版由 electron 设置这个环境变量。 */
export function isPortableExecutable(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.PORTABLE_EXECUTABLE_FILE || env.PORTABLE_EXECUTABLE_DIR)
}

/** 空字符串、非 https 都不拿来检查，避免打到占位域名。 */
export function usableFeedUrl(raw: string | undefined | null): string | null {
  const value = (raw ?? '').trim()
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return null
    if (url.hostname.endsWith('.invalid')) return null
    return url.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}
