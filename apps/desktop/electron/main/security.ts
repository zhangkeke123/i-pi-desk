import { session } from 'electron'
import { log } from './logger.js'

/**
 * Content-Security-Policy。
 *
 * **为什么不写在 index.html 的 `<meta>` 里**：CSP 需要按环境分档。
 * 开发模式下 Vite 会注入内联的 HMR 客户端与 React Refresh preamble，
 * 生产模式下渲染层则完全可以做到「零内联脚本」。
 * meta 标签是静态的，只能取两者的交集 —— 要么开发被 CSP 拦死，
 * 要么生产白白放宽。放在主进程按环境下发，两边都能拿到正确的策略。
 *
 * 生产策略的要点：
 *  - `script-src 'self'`：渲染层不允许任何内联/远程脚本。这是防 XSS 的第一道墙。
 *  - `style-src 'unsafe-inline'`：Tailwind 与 React 会写内联 style，这条必须留。
 *    它不是可以随手删的「多余放宽」，删了会直接白屏。
 *  - `connect-src 'self'`：**渲染层不应该直连模型 API**。所有出网都在 sidecar 里发生；
 *    把这条收紧，等于从协议层保证「密钥与请求不经过渲染层」。
 *  - `object-src 'none'` / `frame-src 'none'`：Electron 里这两个基本只会被用来做坏事。
 */
function buildPolicy(isDev: boolean): string {
  const common = [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ]

  if (isDev) {
    return [
      ...common,
      // 开发期必须放宽的两条：Vite 注入内联脚本；HMR 走 ws。
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self' ws: http: https:"
    ].join('; ')
  }

  return [
    ...common,
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'"
  ].join('; ')
}

export function applyContentSecurityPolicy(isDev: boolean): void {
  const policy = buildPolicy(isDev)

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
        // Electron 的额外加固：不允许渲染层加载未授权的跨源资源。
        'X-Content-Type-Options': ['nosniff']
      }
    })
  })

  log(`CSP 已下发（${isDev ? '开发' : '生产'}档）`)
}
