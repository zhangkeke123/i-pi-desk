#!/usr/bin/env node
/**
 * 确保 Electron 的二进制就位（缺了就下载）。
 *
 * ## 为什么需要它
 *
 * `pnpm install` 之后，`node_modules/electron/dist/` 里**可能没有二进制** ——
 * electron 的 postinstall 要下载约 100 MB。而 pnpm 会把「构建副作用」缓存进 store：
 * 一旦某台机器上是手工跑 `install.js` 补上的，后续安装会认为「已经构建过」而跳过，
 * 于是新克隆下来的目录里始终没有二进制。
 *
 * 现象是 `pnpm dev` 直接报「找不到 Electron」，而 README 里只能让你手动跑一条命令。
 * **第一次上手就撞上一条要手查文档才能过的坎**，是交付质量里很实际的一项。
 *
 * 所以这里做成幂等的自举检查：有就立刻返回（毫秒级），没有就下载。
 * `dev` 与 `verify:renderer` 都会先过它。
 *
 * 镜像优先用 npm 配置里的 `electron_mirror`（`.npmrc` 里已设国内镜像，
 * 通过 pnpm 跑时会以 `npm_config_electron_mirror` 传进来），
 * 否则退回官方源。
 */

import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

/** 各平台下 Electron 可执行文件相对包根的位置。 */
const BINARY_BY_PLATFORM = {
  win32: ['dist', 'electron.exe'],
  darwin: ['dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'],
  linux: ['dist', 'electron']
}

const relative = BINARY_BY_PLATFORM[process.platform]
if (!relative) {
  console.log(`[ensure-electron] 不认识的平台 ${process.platform}，跳过`)
  process.exit(0)
}

let packageDir
try {
  packageDir = dirname(require.resolve('electron/package.json'))
} catch {
  console.log('[ensure-electron] 还没装 electron（先跑 pnpm install），跳过')
  process.exit(0)
}

const binary = join(packageDir, ...relative)
if (existsSync(binary)) {
  console.log(`[ensure-electron] 已就位：${binary}`)
  process.exit(0)
}

console.log('[ensure-electron] 缺少 Electron 二进制，开始下载…')
const mirror =
  process.env.ELECTRON_MIRROR ??
  process.env.npm_config_electron_mirror ??
  'https://github.com/electron/electron/releases/download/'

const result = spawnSync(process.execPath, [join(packageDir, 'install.js')], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_MIRROR: mirror }
})

if (result.status !== 0 || !existsSync(binary)) {
  console.error(
    `[ensure-electron] 下载失败（exit=${result.status}）。\n` +
      `  可以手动重试：node ${join(packageDir, 'install.js')}\n` +
      `  国内网络建议先设镜像：ELECTRON_MIRROR=${mirror}`
  )
  process.exit(1)
}

console.log(`[ensure-electron] 完成：${binary}`)
