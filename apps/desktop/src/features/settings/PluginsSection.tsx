import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, FolderOpen, Loader2, Package, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react'
import type { PluginView } from '@i-pi-desk/shared'
import { PLUGIN_PERMISSION_LABELS } from '@i-pi-desk/shared'
import { call, getDesk, IpcError } from '../../lib/desk.js'

/**
 * 插件管理区块。
 *
 * 界面上必须说清两件事，否则用户无法做出知情决定：
 *  1. **插件是任意代码**，没有 OS 级沙箱（我们不假装有）；
 *  2. 每个插件**声明了哪些能力**，以及「启用」这个动作才是同意发生的地方。
 *
 * 所以布局是：先风险说明 → 再列插件（含权限清单）→ 每个插件单独启用开关。
 * 权限清单直接放在启用按钮旁边，而不是折叠在详情里。
 */
export function PluginsSection(): React.ReactElement {
  const [plugins, setPlugins] = useState<PluginView[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const refresh = useCallback(async () => {
    try {
      setPlugins(await call(getDesk().plugins.list()))
    } catch (error) {
      setMessage({ ok: false, text: error instanceof IpcError ? error.message : String(error) })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const run = async (key: string, action: () => Promise<string>): Promise<void> => {
    setBusy(key)
    setMessage(null)
    try {
      setMessage({ ok: true, text: await action() })
    } catch (error) {
      setMessage({ ok: false, text: error instanceof IpcError ? error.message : String(error) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="mb-5 border-b border-[var(--color-border)] pb-4">
      <h3 className="mb-1 flex items-center gap-2 text-xs uppercase tracking-wide text-[var(--color-muted)]">
        <Package size={13} />
        插件
      </h3>

      <div className="mb-3 flex items-start gap-2 rounded-lg border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/8 px-3 py-2 text-[11px] leading-relaxed">
        <ShieldAlert size={13} className="mt-0.5 shrink-0 text-[var(--color-warn)]" />
        <span>
          插件是<strong className="text-[var(--color-ink)]">任意代码</strong>，运行在独立子进程里，
          拥有与本应用同级的系统权限 —— 我们<strong>没有</strong>操作系统级沙箱。
          安装后默认不启用；请先看清它声明的能力再决定是否启用。
        </span>
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() =>
            void run('install', async () => {
              const installed = await call(getDesk().plugins.install())
              await refresh()
              return installed ? `已安装 ${installed.id}（默认未启用）` : '已取消'
            })
          }
          disabled={busy !== null}
          className="flex items-center gap-1 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs hover:bg-[var(--color-surface-2)] disabled:opacity-50"
        >
          {busy === 'install' ? <Loader2 size={13} className="animate-spin" /> : <Package size={13} />}
          从目录安装
        </button>
        <button
          type="button"
          onClick={() => void call(getDesk().plugins.openDir())}
          className="flex items-center gap-1 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs hover:bg-[var(--color-surface-2)]"
        >
          <FolderOpen size={13} />
          打开插件目录
        </button>
        <button
          type="button"
          onClick={() => void refresh()}
          className="grid h-7 w-7 place-items-center rounded-md text-[var(--color-muted)] hover:bg-[var(--color-surface-2)]"
          title="刷新"
        >
          <RefreshCw size={13} />
        </button>
      </div>

      {plugins === null ? (
        <p className="flex items-center justify-center gap-2 py-4 text-xs text-[var(--color-muted)]">
          <Loader2 size={12} className="animate-spin" />
          读取插件目录…
        </p>
      ) : plugins.length === 0 ? (
        <p className="py-4 text-center text-xs text-[var(--color-muted)]">还没有安装插件。</p>
      ) : (
        <ul className="space-y-2">
          {plugins.map((plugin) => (
            <li key={plugin.dir} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{plugin.name}</span>
                <span className="rounded bg-[var(--color-canvas)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-muted)]">
                  {plugin.id}@{plugin.version}
                </span>
                {plugin.loadError ? (
                  <span className="flex items-center gap-1 text-[10px] text-[var(--color-danger)]">
                    <AlertTriangle size={11} />
                    不可用
                  </span>
                ) : (
                  <span
                    className={`text-[10px] ${plugin.enabled ? 'text-[var(--color-ok)]' : 'text-[var(--color-muted)]'}`}
                  >
                    {plugin.enabled ? '已启用' : '未启用'}
                  </span>
                )}

                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    disabled={busy !== null || Boolean(plugin.loadError)}
                    onClick={() =>
                      void run(plugin.id, async () => {
                        const next = await call(getDesk().plugins.setEnabled(plugin.id, !plugin.enabled))
                        await refresh()
                        return next.enabled ? `已启用 ${next.id}` : `已停用 ${next.id}`
                      })
                    }
                    className="rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] hover:bg-[var(--color-surface-2)] disabled:opacity-40"
                  >
                    {plugin.enabled ? '停用' : '启用'}
                  </button>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      void run(plugin.id, async () => {
                        await call(getDesk().plugins.remove(plugin.id))
                        await refresh()
                        return `已删除 ${plugin.id}`
                      })
                    }
                    className="grid h-6 w-6 place-items-center rounded-md text-[var(--color-muted)] hover:text-[var(--color-danger)] disabled:opacity-40"
                    title="删除插件"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>

              {plugin.loadError ? (
                <p className="mt-1 text-[11px] text-[var(--color-danger)]">{plugin.loadError}</p>
              ) : (
                <>
                  {plugin.description && (
                    <p className="mt-1 text-xs text-[var(--color-muted)]">{plugin.description}</p>
                  )}

                  <div className="mt-2 text-[11px]">
                    <span className="text-[var(--color-muted)]">声明能力：</span>
                    {plugin.permissions.length === 0 ? (
                      <span className="text-[var(--color-muted)]">未声明任何权限</span>
                    ) : (
                      plugin.permissions.map((permission) => (
                        <span
                          key={permission}
                          className="mr-1 inline-block rounded bg-[var(--color-canvas)] px-1.5 py-0.5 font-mono text-[10px]"
                          title={permission}
                        >
                          {PLUGIN_PERMISSION_LABELS[permission] ?? permission}
                        </span>
                      ))
                    )}
                  </div>

                  <div className="mt-1 text-[11px] text-[var(--color-muted)]">
                    {plugin.tools.length > 0 && (
                      <span className="mr-3">
                        提供工具：<span className="font-mono">{plugin.tools.join(', ')}</span>
                      </span>
                    )}
                    {plugin.skillDirs.length > 0 && <span>附带技能目录：{plugin.skillDirs.length} 个</span>}
                    {plugin.tools.length === 0 && plugin.skillDirs.length === 0 && <span>未声明任何贡献</span>}
                  </div>
                </>
              )}

              <p className="mt-1 truncate font-mono text-[10px] text-[var(--color-muted)]">{plugin.dir}</p>
            </li>
          ))}
        </ul>
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
