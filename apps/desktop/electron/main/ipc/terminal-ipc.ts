import { IPC, type TerminalCreateOptions, type TerminalSession } from '@i-pi-desk/shared'
import type { AppContext } from '../context.js'
import { arg, handle, requireString } from './wrap.js'

/**
 * 交互式终端的 IPC。
 *
 * 会话归属用 `event.sender.id`（发起调用的 webContents）记录，
 * 这样窗口关掉时能精确收掉它创建的终端 —— 而不是靠「反正退出时会全清」。
 * 多窗口场景下后者会误杀其它窗口的会话。
 */
export function registerTerminalIpc(ctx: AppContext): void {
  handle<{ available: boolean; message?: string }>(IPC.invoke.terminalProbe, () => ctx.terminal.probe())

  handle<TerminalSession>(IPC.invoke.terminalCreate, (event, ...args) => {
    const options = arg<TerminalCreateOptions | undefined>(args, 0) ?? {}
    return ctx.terminal.create(options, event.sender.id)
  })

  handle<{ id: string }>(IPC.invoke.terminalWrite, (_event, ...args) => {
    const id = requireString(args[0], 'id')
    const data = typeof args[1] === 'string' ? (args[1] as string) : ''
    ctx.terminal.write(id, data)
    return { id }
  })

  handle<{ id: string }>(IPC.invoke.terminalResize, (_event, ...args) => {
    const id = requireString(args[0], 'id')
    const cols = Number(args[1])
    const rows = Number(args[2])
    ctx.terminal.resize(id, cols, rows)
    return { id }
  })

  handle<{ id: string }>(IPC.invoke.terminalDispose, (_event, ...args) => {
    const id = requireString(args[0], 'id')
    ctx.terminal.dispose(id)
    return { id }
  })

  handle<string[]>(IPC.invoke.terminalList, () => ctx.terminal.list())
}
