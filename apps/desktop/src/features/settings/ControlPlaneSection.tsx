import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, CloudDownload, Cloud, LogOut, RefreshCw, Send, ShieldAlert } from 'lucide-react'
import type { ControlPlaneQuota, ControlPlaneStatus } from '@i-pi-desk/shared'
import { call, getDesk, IpcError } from '../../lib/desk.js'
import { useAppStore } from '../../stores/app-store.js'

/**
 * 控制面配置区块。
 *
 * 界面上要如实表达一件事：**控制面是可选的，且不在热路径上**。
 * 没配它，应用功能完整；配了它，模型与技能从控制面下发。
 * 这句话如果只写在文档里，用户会以为「不连控制面就用不了」。
 *
 * 另一个必须显示的：控制面下发的 provider 是**只读**的 ——
 * 否则用户在这里改了它，下次同步就被覆盖，会以为是 bug。
 */
export function ControlPlaneSection(): React.ReactElement {
  const [status, setStatus] = useState<ControlPlaneStatus | null>(null)
  const [quota, setQuota] = useState<ControlPlaneQuota | null>(null)
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await call(getDesk().controlPlane.status())
      setStatus(next)
      if (next.url) setUrl((current) => current || next.url || '')
      if (next.loggedIn) {
        // 配额拿不到不是错误（控制面可能没实现这个接口），静默即可。
        try {
          setQuota(await call(getDesk().controlPlane.quota()))
        } catch {
          setQuota(null)
        }
      } else {
        setQuota(null)
      }
    } catch (error) {
      setMessage({ ok: false, text: error instanceof IpcError ? error.message : String(error) })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const run = async (action: () => Promise<string>): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      setMessage({ ok: true, text: await action() })
    } catch (error) {
      setMessage({ ok: false, text: error instanceof IpcError ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const doLogin = (): void =>
    void run(async () => {
      const next = await call(getDesk().controlPlane.login({ url, username, password }))
      setStatus(next)
      setPassword('')
      await refresh()
      return `已登录：${next.user?.name ?? username}`
    })

  const doSync = (): void =>
    void run(async () => {
      const result = await call(getDesk().controlPlane.sync())
      await refresh()
      // ⚠️ 必须同时刷新 store 里的设置与 provider 列表：同步会在主进程侧改掉
      // defaultProviderId 与 provider 列表，而 newSession() 用的正是渲染层缓存的那份 ——
      // 不刷新的话，同步之后新建的会话会被钉在旧 provider 上（表现为「新会话发不出请求」）。
      await useAppStore.getState().reloadConfig()
      const skills = `技能 新增 ${result.skills.added} / 更新 ${result.skills.updated} / 移除 ${result.skills.removed}`
      const skipped = result.skills.skipped.length > 0 ? `；跳过 ${result.skills.skipped.length} 个（命名不合规）` : ''
      return `已同步：模型 provider ${result.providers} 个；${skills}${skipped}`
    })

  return (
    <section className="mb-5 border-b border-[var(--color-border)] pb-4">
      <h3 className="mb-1 flex items-center gap-2 text-xs uppercase tracking-wide text-[var(--color-muted)]">
        <Cloud size={13} />
        控制面（可选）
      </h3>
      <p className="mb-3 text-[11px] leading-relaxed text-[var(--color-muted)]">
        客户内网的「管理服务」：统一发模型配置与团队技能、收集用量。
        <strong className="text-[var(--color-ink)]">不配也能完整使用</strong>
        —— 对话与推理始终在本地，控制面离线不影响任何一次请求。
      </p>

      {status?.insecureWarning && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-[var(--color-warn)]/50 bg-[var(--color-warn)]/8 px-3 py-2 text-[11px]">
          <ShieldAlert size={13} className="mt-0.5 shrink-0 text-[var(--color-warn)]" />
          <span>{status.insecureWarning}</span>
        </div>
      )}

      {status?.loggedIn ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs">
            <CheckCircle2 size={13} className="text-[var(--color-ok)]" />
            <span>{status.user?.name ?? '已登录'}</span>
            {status.user?.roles && status.user.roles.length > 0 && (
              <span className="rounded bg-[var(--color-canvas)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-muted)]">
                {status.user.roles.join(', ')}
              </span>
            )}
            <span className="ml-auto truncate font-mono text-[10px] text-[var(--color-muted)]">{status.url}</span>
          </div>

          {status.lastSyncAt && (
            <p className="text-[10px] text-[var(--color-muted)]">
              上次同步：{new Date(status.lastSyncAt).toLocaleString()}
            </p>
          )}

          {quota && quota.limitTokens > 0 && <QuotaBar quota={quota} />}

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={doSync}
              disabled={busy}
              className="flex items-center gap-1 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? <RefreshCw size={12} className="animate-spin" /> : <CloudDownload size={12} />}
              同步配置与技能
            </button>
            <button
              type="button"
              onClick={() => void run(async () => {
                const result = await call(getDesk().controlPlane.flushAudit())
                return `审计已上报 ${result.sent} 条，剩余 ${result.pending} 条`
              })}
              disabled={busy}
              className="flex items-center gap-1 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs hover:bg-[var(--color-surface-2)] disabled:opacity-50"
            >
              <Send size={12} />
              推送审计
            </button>
            <button
              type="button"
              onClick={() => void run(async () => {
                const next = await call(getDesk().controlPlane.logout())
                setStatus(next)
                setQuota(null)
                return '已退出控制面'
              })}
              disabled={busy}
              className="ml-auto flex items-center gap-1 rounded-md px-3 py-1.5 text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]"
            >
              <LogOut size={12} />
              退出
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="http://10.0.0.5:8080"
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-canvas)] px-2.5 py-1.5 font-mono text-xs outline-none focus:border-[var(--color-accent)]"
          />
          <div className="flex gap-2">
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="用户名"
              className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-canvas)] px-2.5 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]"
            />
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="密码"
              onKeyDown={(event) => {
                if (event.key === 'Enter') doLogin()
              }}
              className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-canvas)] px-2.5 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={doLogin}
              disabled={busy || !url.trim() || !username.trim()}
              className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40"
            >
              登录
            </button>
            <span className="text-[10px] text-[var(--color-muted)]">
              令牌由系统密钥环加密保存，不写进配置文件
            </span>
          </div>
        </div>
      )}

      {message && (
        <div
          className={`mt-2 flex items-start gap-2 rounded-md px-2.5 py-1.5 text-[11px] ${
            message.ok
              ? 'bg-[var(--color-ok)]/10 text-[var(--color-ok)]'
              : 'bg-[var(--color-danger)]/10 text-[var(--color-danger)]'
          }`}
        >
          {!message.ok && <AlertTriangle size={12} className="mt-0.5 shrink-0" />}
          <span className="min-w-0 flex-1">{message.text}</span>
        </div>
      )}
    </section>
  )
}

function QuotaBar({ quota }: { quota: ControlPlaneQuota }): React.ReactElement {
  const ratio = quota.limitTokens > 0 ? Math.min(1, quota.usedTokens / quota.limitTokens) : 0
  const percent = Math.round(ratio * 100)
  // 80% 起变黄、95% 起变红：让「快超了」在视觉上先于「已经超了」出现。
  const color = ratio >= 0.95 ? 'var(--color-danger)' : ratio >= 0.8 ? 'var(--color-warn)' : 'var(--color-accent)'

  return (
    <div className="pt-1">
      <div className="mb-1 flex items-center gap-2 text-[10px] text-[var(--color-muted)]">
        <span>用量配额</span>
        <span className="ml-auto">
          {quota.usedTokens.toLocaleString()} / {quota.limitTokens.toLocaleString()} tokens（{percent}%）
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-canvas)]">
        <div className="h-full rounded-full transition-all" style={{ width: `${percent}%`, background: color }} />
      </div>
      {quota.resetAt && (
        <p className="mt-1 text-[10px] text-[var(--color-muted)]">
          重置时间：{new Date(quota.resetAt).toLocaleString()}
        </p>
      )}
    </div>
  )
}
