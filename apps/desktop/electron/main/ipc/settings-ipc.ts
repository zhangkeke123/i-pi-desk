import { IPC, type AppSettings } from '@i-pi-desk/shared'
import { getSettings, updateSettings } from '../store/settings.js'
import { isEncryptionAvailable } from '../store/secrets.js'
import { applyNativeTheme } from '../window.js'
import { arg, handle } from './wrap.js'

export function registerSettingsIpc(): void {
  handle<AppSettings & { secretStorageAvailable: boolean }>(IPC.invoke.settingsGet, () => ({
    ...getSettings(),
    // UI 需要知道这台机器能不能安全存密钥：不能时应当禁用「保存 API Key」并解释原因，
    // 而不是等用户填完再报错。
    secretStorageAvailable: isEncryptionAvailable()
  }))

  handle<AppSettings>(IPC.invoke.settingsSet, (_event, ...args) => {
    const patch = arg<Partial<AppSettings>>(args, 0) ?? {}
    const updated = updateSettings(patch)
    /**
     * 主题变了要同步**原生**侧：窗口底色 + `nativeTheme.themeSource`。
     * 不跟的话，用户切到浅色主题后窗口边框、右键菜单、DevTools 仍是深色 ——
     * 这些不在渲染层能控制的范围内（原因见 window.ts 里那段说明）。
     */
    if (patch.theme !== undefined) applyNativeTheme(updated.theme)
    return updated
  })
}
