/**
 * 编译 node-pty。
 *
 * ## 名字里的「Electron」是历史遗留（但结论仍然正确）
 *
 * 这个脚本原来叫「为 Electron 的 ABI 编译」—— **那个理由是错的**。
 * `node-pty` 用的是 Node-API（node-addon-api），ABI 跨 Node/Electron 版本稳定：
 * 实测同一个 `pty.node` 在 Node 24 与 Electron 43（Node 22）下都能加载并 spawn，
 * 二进制里有 `napi_register_module_v1` 而没有 `NODE_MODULE_VERSION`。
 * 所以**这里从来不是为了 ABI**，换 Electron 版本也不需要重编。
 *
 * 真正需要它的原因是下面这条：本机工具链缺组件，默认编译会直接失败。
 *
 * ## 为什么需要这个脚本（而不是让 electron-builder 自动做）
 *
 * `node-pty` 是编译型原生模块。它的 `binding.gyp` 给 conpty / winpty 子工程设了
 * `<SpectreMitigation>Spectre</SpectreMitigation>`，因此 MSVC 必须装有
 * **「MSVC v143 - VS 2022 C++ x64/x86 Spectre 缓解库」** 这个组件，否则 MSBuild 直接报
 * `error MSB8040`。
 *
 * 这带来两个后果，本脚本就是针对它们的：
 *
 *  1. **装不上就会拖垮整个安装**。原来放在 `postinstall` 里的
 *     `electron-builder install-app-deps` 一失败，`pnpm install` 就以退出码 1 结束 ——
 *     对只是想看看这个项目的人来说是极差的第一次体验。所以改成显式命令：
 *     不跑它，应用照常启动，只有终端面板会显示「不可用」并说明原因。
 *
 *  2. **需要一条不依赖那个组件的可行路径**。本脚本在 configure 之后、
 *     build 之前，把生成出来的 `.vcxproj` 里的 `<SpectreMitigation>` 改掉。
 *
 * ## ⚠️ 安全取舍（请如实告知使用者）
 *
 * 关掉 Spectre 缓解**确实降低了这一处原生代码针对侧信道攻击的加固强度**。
 * 如果你的环境能装那个 VS 组件，**优先装组件**，不要用本脚本：
 *
 *   vs_installer modify --add Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre
 *
 * 装好之后用任意方式重编一次即可（`pnpm rebuild:pty` 同样可用，只是它会改掉
 * `<SpectreMitigation>`；要保留加固就用 `npx node-gyp rebuild`）。
 * 本脚本只是「没有管理员权限 / 不想装几个 GB 组件」时的退路。
 *
 * 用法：`pnpm --filter @i-pi-desk/desktop rebuild:pty`
 *      （或仓库根 `pnpm rebuild:pty`）
 */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')
const requireFromApp = createRequire(join(appRoot, 'package.json'))

/** Electron 主版本，用于 gyp 的 --target。 */
function electronTarget() {
  const version = requireFromApp('electron/package.json').version
  return version
}

function findNodeGyp() {
  // node-gyp 是 pnpm 的传递依赖，不一定能被直接 resolve；退回到在 .pnpm 里找。
  try {
    return requireFromApp.resolve('node-gyp/bin/node-gyp.js')
  } catch {
    const pnpmDir = join(appRoot, '..', '..', 'node_modules', '.pnpm')
    if (existsSync(pnpmDir)) {
      const candidate = readdirSync(pnpmDir).find((name) => name.startsWith('node-gyp@'))
      if (candidate) {
        const bin = join(pnpmDir, candidate, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js')
        if (existsSync(bin)) return bin
      }
    }
    return null
  }
}

function findNodePty() {
  const packageJson = requireFromApp.resolve('node-pty/package.json')
  return dirname(packageJson)
}

/** 递归找出所有生成出来的 vcxproj（pty / conpty / winpty 都要改）。 */
function vcxprojFiles(buildDir) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.vcxproj')) out.push(full)
    }
  }
  if (existsSync(buildDir)) walk(buildDir)
  return out
}

const target = electronTarget()
const nodeGyp = findNodeGyp()
const nodePty = findNodePty()

if (!nodeGyp) {
  console.error('找不到 node-gyp。请先 `pnpm install`（它会装构建工具链）。')
  process.exit(1)
}

console.log(`node-pty : ${nodePty}`)
console.log(`electron : ${target}`)
console.log(`node-gyp : ${nodeGyp}\n`)

const run = (label, args) => {
  console.log(`── ${label} ──`)
  const result = spawnSync(process.execPath, [nodeGyp, ...args], { cwd: nodePty, stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`\n${label} 失败（退出码 ${result.status}）。`)
    console.error(
      '如果报的是 MSB8040（需要 Spectre 缓解库），说明本脚本的 vcxproj 改写没能覆盖到，\n' +
        '或者 MSBuild 版本与预期不同。此时请安装 VS 组件：\n' +
        '  Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre'
    )
    process.exit(result.status ?? 1)
  }
}

// 1) configure：生成 binding.sln 与各 .vcxproj（此时它们带着 Spectre 设置）
run('configure', [
  'configure',
  `--target=${target}`,
  `--arch=${process.arch === 'arm64' ? 'arm64' : 'x64'}`,
  '--dist-url=https://electronjs.org/headers',
  '--release'
])

// 2) 去掉 Spectre 要求。必须在 configure 之后 —— configure 会重新生成这些文件。
const files = vcxprojFiles(join(nodePty, 'build'))
let patched = 0
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  if (!text.includes('<SpectreMitigation>Spectre</SpectreMitigation>')) continue
  writeFileSync(file, text.replaceAll('<SpectreMitigation>Spectre</SpectreMitigation>', '<SpectreMitigation>false</SpectreMitigation>'))
  patched += 1
}
console.log(`── 改写 vcxproj：${patched}/${files.length} 个文件去掉了 Spectre 要求 ──\n`)
if (patched === 0) {
  console.warn('警告：没有找到需要改写的 vcxproj —— 可能这台机器本来就装了 Spectre 组件，继续尝试编译。')
}

// 3) build：只跑构建，不再触发 configure（否则上面的改写会被覆盖回去）
run('build', ['build'])

const built = existsSync(join(nodePty, 'build', 'Release', 'pty.node'))
console.log(`\n${built ? '✅ node-pty 编译完成' : '❌ 未找到 pty.node，编译可能未真正成功'}`)
console.log(`产物：${join(nodePty, 'build', 'Release')}`)
process.exit(built ? 0 : 1)
