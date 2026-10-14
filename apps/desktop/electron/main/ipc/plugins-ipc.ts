import { dialog, shell } from 'electron'
import { IPC, type PluginView } from '@i-pi-desk/shared'
import {
  installPluginFrom,
  listPlugins,
  pluginsDir,
  removePlugin,
  setPluginEnabled
} from '../store/plugins.js'
import type { AppContext } from '../context.js'
import { handle, requireString } from './wrap.js'

/**
 * 插件管理 IPC。
 *
 * 安装走**目录选择对话框**（`plugins.install()` 不接收路径参数）：
 * 让渲染层传任意路径进来，就等于给它一个「把任何目录复制进应用数据目录」的能力。
 * 路径必须由用户在主进程弹出的对话框里亲手选。
 */
export function registerPluginsIpc(ctx: AppContext): void {
  handle<PluginView[]>(IPC.invoke.pluginsList, () => listPlugins())

  handle<PluginView | null>(IPC.invoke.pluginsInstall, async () => {
    const window = ctx.getWindow()
    const options: Electron.OpenDialogOptions = {
      title: '选择插件目录（必须包含 manifest.json）',
      properties: ['openDirectory']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)

    if (result.canceled || result.filePaths.length === 0) return null
    return installPluginFrom(result.filePaths[0] as string)
  })

  handle<{ id: string }>(IPC.invoke.pluginsRemove, (_event, ...args) =>
    removePlugin(requireString(args[0], 'id'))
  )

  handle<PluginView>(IPC.invoke.pluginsSetEnabled, (_event, ...args) => {
    const id = requireString(args[0], 'id')
    return setPluginEnabled(id, args[1] === true)
  })

  handle<{ path: string }>(IPC.invoke.pluginsOpenDir, async () => {
    const dir = pluginsDir()
    await shell.openPath(dir)
    return { path: dir }
  })
}
