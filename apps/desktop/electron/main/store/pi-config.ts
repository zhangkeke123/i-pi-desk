import { join } from 'node:path'
import { getAppPaths } from '../paths.js'
import { ensureDir } from './json-store.js'

/**
 * pi 内核自己的状态目录（agent directory）与会话目录。
 *
 * **必须重定向出用户 home。** 这不是洁癖：pi 默认把状态写在 `~/.pi/agent`，
 * 实测一次 `createAgentSession()` 就会在那里建出 `auth.json`、`models-store.json`，
 * 以及 `sessions/--<编码后的 cwd>--/`；启用 grep/find 时还会把 `rg`/`fd`
 * 下载到 `<agentDir>/bin/`。
 *
 * 直接用它默认值的后果有三条：
 *  1) 我们的应用往用户 home 里塞文件，卸载后留垃圾；
 *  2) 和用户自己装的 pi CLI 抢同一份 auth.json / settings.json，互相覆盖；
 *  3) 备份/迁移时把内核状态和我们自己的数据混在一起。
 *
 * 放在 userData 下就完全隔离：卸载即随应用数据一起清理。
 * 实际生效靠 sidecar 进程启动时设置 `PI_CODING_AGENT_DIR` 与
 * `PI_CODING_AGENT_SESSION_DIR` 两个环境变量。
 */

export function piAgentDir(): string {
  const dir = join(getAppPaths().userData, 'pi-agent')
  ensureDir(dir)
  return dir
}

export function piSessionsDir(): string {
  const dir = join(piAgentDir(), 'sessions')
  ensureDir(dir)
  return dir
}
