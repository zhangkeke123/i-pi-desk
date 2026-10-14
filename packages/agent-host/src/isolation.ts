/**
 * 进程级 home 隔离。**必须早于任何 `@earendil-works/*` 模块被求值。**
 *
 * ## 为什么单独一个文件
 *
 * pi 的 `dist/utils/tools-manager.js` 在**模块顶层**就做了
 *
 * ```js
 * const TOOLS_DIR = getBinDir();          // = join(getAgentDir(), "bin")
 * ```
 *
 * 而 `getAgentDir()` 读的是 `process.env.PI_CODING_AGENT_DIR`（名字由
 * `config.js` 的 `ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`` 决定）。
 * 也就是说：**这个值在我们第一次 `import` pi 的那一刻就被固化了**，
 * 之后无论怎么改 `process.env` 都不会再变（已核对 1.1.0 全量 dist：
 * `= getBinDir()` / `= getAgentDir()` / `= getSessionsDir()` 只有这一处是模块级常量，
 * 其余调用点都是运行时求值）。
 *
 * ESM 的静态 import 会先于本模块的任何语句执行，所以把 `process.env[...] = ...`
 * 写在 `sidecar.ts` 的模块体里是**太晚的**。放在这个不 import pi 的模块里，
 * 并让 `sidecar.ts` 把它写在 `./runtime.js` 之前，就能保证求值顺序：
 * isolation.js → runtime.js（才拉起 pi 的模块图）。
 *
 * ## 为什么需要一个「临时兜底值」
 *
 * `agentDir` 是随请求（`PromptParams.agentDir`）进来的，进程启动时**不可能知道**。
 * 如果启动时不绑定，pi 就会把 `TOOLS_DIR` 指向用户真实的 `~/.pi/agent/bin`，
 * 一旦模型用了 grep/find 而系统 PATH 里没有 rg/fd，pi 就会把二进制下载进用户主目录 ——
 * 这正是要避免的污染。
 *
 * 于是启动时按优先级绑定：
 *   1. 主进程已设好的 `PI_CODING_AGENT_DIR`（最佳：连 rg/fd 缓存也落在真实 agentDir）；
 *   2. 我们自己的提示变量 `IPI_DESK_AGENT_DIR`（主进程 spawn 侧车时加一行即可，等价于 1）；
 *   3. 稳定的临时目录 `<os.tmpdir()>/i-pi-desk/agent`（永远不碰用户主目录）。
 *
 * 之后第一次拿到 `PromptParams.agentDir` 时，runtime 会把环境变量改写成真实目录
 * （auth.json / sessions / shell 的 PATH 预置都按真实目录走）；
 * 只有上面那个已被固化的 `TOOLS_DIR` 留在兜底目录 —— 这是刻意的取舍：
 * **宁可 rg/fd 缓存放临时目录，也不写用户主目录。**
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** pi 1.1.0 的 agent 目录环境变量（`PI` = `APP_NAME.toUpperCase()`）。 */
export const PI_AGENT_DIR_ENV = 'PI_CODING_AGENT_DIR'
/**
 * 1.1.0 里 `config.js` 会导出 `ENV_SESSION_DIR`，但全量 dist grep 下来**没有任何读取点**：
 * 会话目录实际是 `join(getAgentDir(), "sessions")`。设置它无害（也照要求设了），
 * 但不能指望它做隔离 —— 真正起作用的是 PI_CODING_AGENT_DIR 与 SessionManager.inMemory()。
 */
export const PI_SESSION_DIR_ENV = 'PI_CODING_AGENT_SESSION_DIR'
/** 主进程可以（可选）在 spawn 侧车时设置的提示变量，用来换取「零兜底」的完美隔离。 */
export const IPI_DESK_AGENT_DIR_ENV = 'IPI_DESK_AGENT_DIR'

/** 兜底 agent 目录：稳定（跨进程复用 rg/fd 缓存），且不在用户主目录下。 */
export function fallbackAgentDir(): string {
  return join(tmpdir(), 'i-pi-desk', 'agent')
}

/**
 * 在 import pi 之前调用。返回实际绑定的目录，便于启动日志。
 *
 * 幂等：已经绑定过就直接返回现值。
 */
export function bindProvisionalAgentDir(): string {
  const existing = process.env[PI_AGENT_DIR_ENV]
  if (existing) return existing

  const hinted = process.env[IPI_DESK_AGENT_DIR_ENV]
  const chosen = hinted && hinted.length > 0 ? hinted : fallbackAgentDir()
  process.env[PI_AGENT_DIR_ENV] = chosen
  process.env[PI_SESSION_DIR_ENV] = join(chosen, 'sessions')
  return chosen
}
