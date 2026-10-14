/**
 * 把插件运行器拷进产物目录。
 *
 * `plugin-runner.mjs` 是**独立脚本**，不参与 TS 编译（它要能被 `spawn` 直接执行），
 * 所以 `tsc` 不会把它带进 `dist/`。但 plugin-host 用
 * `new URL('./plugin-runner.mjs', import.meta.url)` 找它 —— 也就是说它必须和
 * 产物文件**同目录**。
 *
 * 用脚本显式拷贝而不是靠构建工具的 assets 机制：这样 build 与 bundle 两条路径
 * 用的是同一份逻辑，不会出现「开发能跑、打包后插件全失效」这种只在发布时暴露的问题。
 *
 * 用法：node scripts/copy-runner.mjs <目标目录>
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')
const source = join(packageRoot, 'src', 'plugin-runner.mjs')

const targetDir = process.argv[2]
if (!targetDir) {
  console.error('用法：node scripts/copy-runner.mjs <目标目录>')
  process.exit(1)
}

const target = join(packageRoot, targetDir)
if (!existsSync(source)) {
  console.error(`源文件不存在：${source}`)
  process.exit(1)
}
mkdirSync(target, { recursive: true })
copyFileSync(source, join(target, 'plugin-runner.mjs'))
console.log(`plugin-runner.mjs → ${join(target, 'plugin-runner.mjs')}`)
