import {
  IPC,
  type ControlPlaneLoginInput,
  type ControlPlaneQuota,
  type ControlPlaneStatus,
  type ControlPlaneSyncResult
} from '@i-pi-desk/shared'
import { flushAudit, getStatus, login, logout, fetchQuota, sync } from '../store/control-plane.js'
import { arg, handle } from './wrap.js'

/**
 * 控制面 IPC。
 *
 * 错误码直接来自 `ControlPlaneError`（`AUTH_REQUIRED` / `NETWORK` / `NOT_CONFIGURED` …），
 * UI 据此决定是弹登录、提示网络问题，还是引导去填地址 —— 而不是给一句笼统的「失败」。
 */
export function registerControlPlaneIpc(): void {
  handle<ControlPlaneStatus>(IPC.invoke.cpStatus, () => getStatus())

  handle<ControlPlaneStatus>(IPC.invoke.cpLogin, async (_event, ...args) => {
    const input = arg<ControlPlaneLoginInput>(args, 0)
    if (!input || typeof input.url !== 'string' || typeof input.username !== 'string') {
      throw Object.assign(new Error('登录需要 url / username / password'), { code: 'BAD_REQUEST' })
    }
    // 空密码是合法的（有些客户内网用证书/免密），所以只校验类型不校验非空。
    return login({ url: input.url, username: input.username, password: String(input.password ?? '') })
  })

  handle<ControlPlaneStatus>(IPC.invoke.cpLogout, () => logout())

  handle<ControlPlaneSyncResult>(IPC.invoke.cpSync, () => sync())

  handle<ControlPlaneQuota>(IPC.invoke.cpQuota, () => fetchQuota())

  handle<{ sent: number; pending: number }>(IPC.invoke.cpFlushAudit, () => flushAudit())
}
