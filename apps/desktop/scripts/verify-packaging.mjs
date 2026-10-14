#!/usr/bin/env node
/**
 * 打包配置与产物结构检查（跨平台）。
 *
 * ## 为什么需要它
 *
 * `verify:packaged` 验的是「Windows 包能真的跑起来」—— 那需要**运行**产物，
 * 所以它只能在 Windows 上跑。而 mac / linux 的包在这台机器上**根本跑不了**，
 * 于是很容易退化成「配置写了就算完成」。
 *
 * 但「配置写了」和「产物能用」是两件事。这一轮就撞上了实证：
 * 在 Windows 上 `electron-builder --linux dir` 能顺利产出 `linux-unpacked/`，
 * 结构看起来完全正确（sidecar、plugin-runner、app.asar 全在）——
 * **可里面的 node-pty 是 Windows 二进制**（PE 文件 + MSVC 的 .vcxproj），
 * 在 Linux 上终端根本起不来。结构检查抓不到这个，只有看 native 文件的**格式**才行。
 *
 * ## 判据
 *
 * 对每个 `release/<platform>-unpacked/`：
 *  1. 公共结构必须在（sidecar、插件运行器、app.asar、被外置的 node-pty）；
 *  2. **native 模块的二进制格式必须与包的目标平台一致**（PE / ELF / Mach-O）。
 *
 * 第 2 条会在「在 Windows 上打 linux 包」时失败 —— 那正是它的用途：
 * **宁可让这条红，也不要让人拿到一个装了却用不了的包。**
 *
 * 用法：node scripts/verify-packaging.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appDir = join(here, '..')
const releaseDir = join(appDir, 'release')

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

/** 读前 4 个字节，判断可执行文件的格式。 */
function binaryFormat(file) {
  const fd = readFileSync(file).subarray(0, 4)
  if (fd[0] === 0x4d && fd[1] === 0x5a) return 'pe' // MZ
  if (fd[0] === 0x7f && fd[1] === 0x45 && fd[2] === 0x4c && fd[3] === 0x46) return 'elf'
  const magic = fd.readUInt32BE(0)
  if (magic === 0xfeedface || magic === 0xfeedfacf || magic === 0xcafebabe) return 'macho'
  return 'unknown'
}

const EXPECTED = { win: 'pe', linux: 'elf', mac: 'macho' }

// ───────────────────────── 一、配置本身 ─────────────────────────

console.log('── 打包配置 ──')

const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'))
const build = pkg.build ?? {}

for (const platform of ['win', 'mac', 'linux']) {
  check(`声明了 ${platform} 目标`, Boolean(build[platform]?.target?.length), JSON.stringify(build[platform] ?? null))
}

check('mac / linux 都给了应用分类（桌面环境要按它归类）', Boolean(build.mac?.category && build.linux?.category))
check('linux 指定了可执行名', build.linux?.executableName === 'i-pi-desk', String(build.linux?.executableName))
check('产物名带平台与架构（分发时不会认错包）', /\$\{os\}/.test(build.artifactName ?? '') && /\$\{arch\}/.test(build.artifactName ?? ''), String(build.artifactName))
check('三个平台共用同一份 sidecar 资源', Array.isArray(build.extraResources) && build.extraResources.some((e) => e.to === 'agent-host'))
/**
 * 第三方声明必须随产物一起走。
 *
 * 我们**随应用分发** MIT 许可的 agent 内核，而 MIT 要求随附版权声明与许可文本；
 * 只把 `THIRD-PARTY.md` 放在仓库里是不够的 —— 拿到安装包的人看不到仓库。
 */
check(
  '第三方声明随产物分发（extraResources 里有 THIRD-PARTY.md）',
  Array.isArray(build.extraResources) && build.extraResources.some((e) => e.to === 'THIRD-PARTY.md'),
  JSON.stringify(build.extraResources)
)
check('node-pty 被 asar 外置（否则原生模块加载不了）', Array.isArray(build.asarUnpack) && build.asarUnpack.some((p) => p.includes('node-pty')))

/**
 * 同一个平台上多个 target 的产物名必须能区分开。
 *
 * 这条是**真构建**打出来的：Windows 的 nsis 与 portable 扩展名都是 `.exe`，
 * 只按 `${os}-${arch}` 命名会撞进同一个文件 —— 后构建的 portable **静默覆盖**
 * 掉 NSIS 安装包。日志里两行 `building target=... file=<同一个路径>` 是唯一线索，
 * 产物列表看起来「也有一个 exe」，很容易就此放过。
 */
const winTargets = (build.win?.target ?? []).map((t) => (typeof t === 'string' ? t : t.target))
if (winTargets.includes('nsis') && winTargets.includes('portable')) {
  const names = [build.nsis?.artifactName, build.portable?.artifactName]
  check(
    'Windows 的 nsis / portable 产物名互不相同（否则便携版会覆盖安装包）',
    Boolean(names[0] && names[1] && names[0] !== names[1]),
    `nsis=${names[0]} portable=${names[1]}`
  )
}

// ───────────────────────── 二、已有产物的结构 ─────────────────────────

const unpacked = existsSync(releaseDir)
  ? readdirSync(releaseDir).filter((name) => name.endsWith('-unpacked') && statSync(join(releaseDir, name)).isDirectory())
  : []

if (unpacked.length === 0) {
  console.log('\n  SKIP  还没有任何 *-unpacked 产物（先跑 package 的 pack 命令）')
} else {
  for (const dir of unpacked) {
    const platform = dir.replace('-unpacked', '')
    const root = join(releaseDir, dir)
    console.log(`\n── 产物结构：${dir} ──`)

    const resources = join(root, 'resources')
    check(`${dir}: sidecar 随包分发`, existsSync(join(resources, 'agent-host', 'sidecar.js')))
    check(
      `${dir}: 插件运行器与 sidecar 同目录`,
      existsSync(join(resources, 'agent-host', 'plugin-runner.mjs'))
    )
    check(`${dir}: app.asar 存在`, existsSync(join(resources, 'app.asar')))

    const ptyRoot = join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty')
    check(`${dir}: node-pty 被外置到 asar.unpacked`, existsSync(ptyRoot))

    /**
     * 最要紧的一条：包里的原生模块必须**属于这个平台**。
     *
     * Windows 的 node-pty 编译产物是 `build/Release/pty.node`（PE），
     * Linux / mac 用的是同一路径下的 ELF / Mach-O。文件格式对不上，
     * 那个包装上去终端一定起不来 —— 而结构检查会一路绿灯。
     */
    const ptyBinary = join(ptyRoot, 'build', 'Release', 'pty.node')
    if (!existsSync(ptyBinary)) {
      check(`${dir}: 找得到 pty.node（终端原生模块）`, false, ptyBinary)
    } else {
      const format = binaryFormat(ptyBinary)
      const expected = EXPECTED[platform] ?? 'unknown'
      check(
        `${dir}: 原生模块格式与平台一致（${expected}）`,
        format === expected,
        format === expected
          ? ''
          : `实际是 ${format}（${ptyBinary}）。` +
            `这个包在此平台上**终端一定起不来**。` +
            `原因通常是 native 模块没有为目标平台重建 —— 本项目 Windows 侧显式 npmRebuild:false ` +
            `并做了 Spectre 补丁，所以只能产出 Windows 可用的包；` +
            `mac / linux 包必须在对应平台上构建（或用对应平台的 node-pty 预编译产物）。`
      )
    }
  }
}

/**
 * **交付包是否比源码旧** —— 只提示，不判失败。
 *
 * 这一条来自一次真实的坑（第 59 轮，用户要求「卸载重装跑一下」时发现）：
 * `pnpm pack` 只刷新**解包目录**（`release/win-unpacked`），而 **NSIS 安装包与便携版
 * 只有 `pnpm dist` 才会重新生成**。于是完全可能：源码已经修完，`verify:packaged`
 * 全绿（它验的是解包目录），而用户手上那个安装包还是几天前的 ——
 * 里面没有那些修复。第一次装上时 `resources/` 里连 `THIRD-PARTY.md` 都没有，
 * 就是因为那个安装包早于这次改动。
 *
 * 不判失败的理由：日常 `pnpm verify` 链里并不跑 `dist`（那要多花一分钟），
 * 每次都红只会让人习惯性忽略。所以它只在**明显过期**时提醒一句。
 */
{
  const newestSource = (() => {
    let newest = 0
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', 'out', 'dist', 'dist-bundle'].includes(entry.name)) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(ts|tsx|mjs)$/.test(entry.name)) newest = Math.max(newest, statSync(full).mtimeMs)
      }
    }
    for (const dir of [join(appDir, 'src'), join(appDir, 'electron'), join(appDir, '..', '..', 'packages', 'agent-host', 'src')]) {
      if (existsSync(dir)) walk(dir)
    }
    return newest
  })()

  const installers = existsSync(releaseDir)
    ? readdirSync(releaseDir).filter((name) => name.endsWith('.exe') && !name.includes('unpacked'))
    : []
  const stale = installers.filter((name) => statSync(join(releaseDir, name)).mtimeMs < newestSource)
  if (stale.length > 0) {
    const newestSourceTime = new Date(newestSource).toLocaleString()
    console.log(`\n  NOTE  安装包比源码旧（源码最后改动 ${newestSourceTime}）：`)
    for (const name of stale) console.log(`          ${name}`)
    console.log('        解包目录（verify:packaged 验的那份）是新的，但**交付给用户的安装包不是**。')
    console.log('        要刷新它们：pnpm --filter @i-pi-desk/desktop run dist')
  }
}

console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
process.exit(failures === 0 ? 0 : 1)