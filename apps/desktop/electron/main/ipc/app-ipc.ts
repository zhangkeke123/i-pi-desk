import { app, dialog } from 'electron'
import { IPC, type AppInfo } from '@i-pi-desk/shared'
import { getAppPaths } from '../paths.js'
import { closeGuard } from '../close-guard-host.js'
import type { AppContext } from '../context.js'
import { handle, arg } from './wrap.js'

export function registerAppIpc(ctx: AppContext): void {
  handle<AppInfo>(IPC.invoke.appInfo, () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron ?? 'unknown',
    node: process.versions.node,
    chrome: process.versions.chrome ?? 'unknown',
    platform: process.platform,
    userDataPath: getAppPaths().userData
  }))

  /**
   * 渲染层上报「编辑器里有没有未保存的改动」。
   *
   * 用一个布尔值同步上去，是因为关窗这件事**只能**在主进程拦 ——
   * 而「有没有未保存」只有渲染层知道（见 `close-guard.ts` 的说明）。
   */
  handle<{ dirty: boolean }>(IPC.invoke.editorDirty, (_event, ...args) => {
    const dirty = Boolean(arg<{ dirty?: unknown }>(args, 0)?.dirty)
    closeGuard.setDirty(dirty)
    return { dirty }
  })

  /** 用户在「不保存并退出」上确认过：这一次关窗不再拦截。 */
  handle<{ closing: boolean }>(IPC.invoke.quitConfirmed, () => ({ closing: closeGuard.confirmQuit() }))

  handle<string | null>(IPC.invoke.dialogPickDirectory, async () => {
    const window = ctx.getWindow()
    const options: Electron.OpenDialogOptions = {
      title: '选择工作目录',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)

    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}
