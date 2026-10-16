import { IPC, type UpdateStatus } from '@i-pi-desk/shared'
import type { AppContext } from '../context.js'
import { AppUpdater } from '../updater.js'
import { handle } from './wrap.js'

export function registerUpdateIpc(ctx: AppContext, prepareQuit: () => Promise<void>): AppUpdater {
  const updater = new AppUpdater((status) => ctx.broadcast(IPC.event.update, status))

  handle<UpdateStatus>(IPC.invoke.updateStatus, () => updater.status())
  handle<UpdateStatus>(IPC.invoke.updateCheck, () => updater.check())
  handle<UpdateStatus>(IPC.invoke.updateOpen, () => updater.openPage())
  handle<UpdateStatus>(IPC.invoke.updateInstall, async () => {
    if (updater.status().phase !== 'ready') return updater.status()
    await prepareQuit()
    return updater.install()
  })

  updater.start()
  return updater
}
