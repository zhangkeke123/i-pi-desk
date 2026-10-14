import type { BrowserWindow } from 'electron'
import type { IpcEventChannel } from '@i-pi-desk/shared'
import type { AgentSupervisor } from './agent/supervisor.js'
import type { TerminalHost } from './terminal/host.js'

/**
 * 主进程内部的共享上下文。
 *
 * 刻意做成一个显式传入的对象，而不是到处 `import` 单例：
 * 这样每个 handler 模块的依赖是看得见的，也便于将来给测试塞一个假 supervisor。
 */
export interface AppContext {
  supervisor: AgentSupervisor
  /**
   * PTY 宿主。
   *
   * 它挂在这里（而不是在 ipc/terminal-ipc.ts 里自己 new）是因为**生命周期归启动编排管**：
   * 窗口销毁与 before-quit 都要收会话，只有拿到同一个实例才能做对。
   */
  terminal: TerminalHost
  /** 取主窗口；可能为 null（窗口还没建或已销毁）。 */
  getWindow: () => BrowserWindow | null
  /** 向渲染层推事件。窗口没了就静默丢弃。 */
  broadcast: (channel: IpcEventChannel, payload: unknown) => void
  /** 落日志。协议流之外的诊断信息都走这里。 */
  log: (line: string) => void
}
