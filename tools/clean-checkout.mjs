#!/usr/bin/env node
/**
 * 「干净检出」实跑：只复制源码，从装依赖开始把入口全部走一遍。
 *
 * ## 为什么需要它
 *
 * 开发目录天然带着历史产物（`dist/`、`out/`、下载好的 Electron 二进制），
 * 足以把「**新克隆下来能不能用**」这类问题完全遮住。ARCHITECTURE §15.6 记过一次
 * 这样跑出来的三处错误（typecheck 找不到 shared 的类型、shared 的测试 import 构建产物、
 * `pnpm dev` 找不到 Electron 二进制）—— 修法都是「让入口自己把前提造出来」。
 *
 * 那次之后，构建与打包配置又改过若干轮，所以这件事要能**随时重跑**，
 * 而不是只留在文档的一段叙述里。
 *
 * ## 它证明什么、不证明什么（别混为一谈）
 *
 * - 证明：**源码自足** —— 只有源码的副本能装、能类型检查、能构建、能跑验证脚本；
 * - 不证明：**离线/冷机器能装**（pnpm store 是热的，输出里会是 `reused N, downloaded 0`）；
 * - 不证明：**`pnpm dev` 能开窗口**（那要图形环境；这里用 typecheck + build + 两个验证脚本覆盖入口）。
 *
 * ## 用法
 *
 * ```bash
 * node tools/clean-checkout.mjs            # 默认留 40 分钟预算
 * node tools/clean-checkout.mjs --keep     # 保留副本目录（排查用）
 * ```
 *
 * 它**不在 `pnpm verify` 链里**：装依赖 + 全量构建要一分多钟，而且依赖网络/store，
 * 放进日常验证链只会让人想跳过整条链。
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const keep = process.argv.includes('--keep')
const dest = join(tmpdir(), `ipi-clean-${Date.now()}`)
const reportPath = join(tmpdir(), 'ipi-clean-checkout-report.txt')

/**
 * 怎么调用 pnpm。
 *
 * `IPI_PNPM` 指向 **pnpm 的 JS 入口**（`pnpm.mjs`）时，必须用
 * `node <入口> ...` 这种形式；**不能用 `shell: true`** ——
 * Windows 上把 `.mjs` 路径交给 shell 会变成「用关联程序打开它」并返回 0，
 * 于是每一步都「成功」而其实什么都没执行（第一版就是这样：六步全 PASS、各 0–1 秒）。
 *
 * 没设 `IPI_PNPM` 时按普通命令调 `pnpm`（正常安装出来的 shim 可以直接执行）。
 */
const pnpmJs = process.env.IPI_PNPM
const pnpmCommand = pnpmJs ? process.execPath : 'pnpm'
const pnpmArgs = (args) => (pnpmJs ? [pnpmJs, ...args] : args)

const log = []
function note(line) {
  console.log(line)
  log.push(line)
}

async function step(label, args, timeoutMs) {
  const started = Date.now()
  try {
    await run(pnpmCommand, pnpmArgs(args), {
      cwd: dest,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CI: '1' }
    })
    note(`PASS  ${label}（${Math.round((Date.now() - started) / 1000)}s）`)
    return true
  } catch (error) {
    note(`FAIL  ${label}（${Math.round((Date.now() - started) / 1000)}s）`)
    note(String(error.stdout ?? '').split('\n').slice(-25).join('\n'))
    note(String(error.stderr ?? '').split('\n').slice(-25).join('\n'))
    return false
  }
}

/** 某个目录里有没有东西 —— 用来证明「上一步真的产出了什么」。 */
const countFiles = (dir) => (existsSync(dir) ? readdirSync(dir).length : 0)

try {
  mkdirSync(dest, { recursive: true })
  note(`干净副本：${dest}`)

  // robocopy 用退出码 1 表示「复制成功」，所以 <8 都算正常。
  const EXCLUDE_DIRS = ['node_modules', 'dist', 'dist-bundle', 'out', 'release', '.git']
  try {
    await run(
      'robocopy',
      [root, dest, '/E', '/XD', ...EXCLUDE_DIRS, '/XF', '*.log', '*.tsbuildinfo', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'],
      { timeout: 300_000 }
    )
  } catch (error) {
    if (!(typeof error.code === 'number' && error.code < 8)) throw error
  }

  note(`副本里没有 node_modules：${!existsSync(join(dest, 'node_modules'))}`)
  note(`副本里有 pnpm-lock.yaml：${existsSync(join(dest, 'pnpm-lock.yaml'))}`)

  let ok = await step('pnpm install --frozen-lockfile', ['install', '--frozen-lockfile'], 900_000)
  if (ok) {
    /**
     * **每一步都要证明它真的产出了东西。**
     *
     * 第一版没有这几条，于是「六步全 PASS、各 0–1 秒」看起来像完美通过，
     * 其实一条命令都没执行 —— 空过的检查和没有检查一样，而且更容易骗人。
     *
     * 注意 pnpm workspace 的形状：`node_modules` 顶层只有两三个条目
     * （`.pnpm` / `.modules.yaml`），真正的包都在 `.pnpm/` 里面。
     * 第一版按「顶层 > 5」判，于是把一次成功的安装判成了失败。
     */
    const pnpmStoreEntries = countFiles(join(dest, 'node_modules', '.pnpm'))
    note(`install 之后 node_modules/.pnpm 条目数：${pnpmStoreEntries}`)
    ok = existsSync(join(dest, 'node_modules', '.modules.yaml')) && pnpmStoreEntries > 5 && ok

    ok = (await step('pnpm typecheck（会先 build:packages）', ['typecheck'], 900_000)) && ok
    note(`typecheck 之后 packages/shared/dist 文件数：${countFiles(join(dest, 'packages', 'shared', 'dist'))}`)
    ok = countFiles(join(dest, 'packages', 'shared', 'dist')) > 0 && ok

    ok = (await step('pnpm build', ['build'], 900_000)) && ok
    ok = (await step('pnpm test', ['test'], 600_000)) && ok
    ok = (await step('pnpm verify:doc-claims', ['verify:doc-claims'], 300_000)) && ok
    ok = (await step('pnpm verify:protocol', ['verify:protocol'], 300_000)) && ok
  }

  /**
   * 产物名对比：构建可复现是「交付给别人的包和我验过的包是不是同一个」的前提。
   * 只比文件名（哈希在其中），不比内容 —— 名字相同足以说明输入与压缩方式一致。
   */
  const pick = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.js')).sort() : [])
  const devAssets = pick(join(root, 'apps', 'desktop', 'out', 'renderer', 'assets'))
  const cleanAssets = pick(join(dest, 'apps', 'desktop', 'out', 'renderer', 'assets'))
  const same = devAssets.length > 0 && JSON.stringify(devAssets) === JSON.stringify(cleanAssets)
  note(`\n产物名一致（= 构建可复现）：${same}（开发目录 ${devAssets.length} 个 / 干净副本 ${cleanAssets.length} 个）`)
  if (!same) {
    note(`  开发目录：${JSON.stringify(devAssets)}`)
    note(`  干净副本：${JSON.stringify(cleanAssets)}`)
  }

  writeFileSync(reportPath, log.join('\n'), 'utf8')
  note(`\n报告：${reportPath}`)
  /**
   * ⚠️ 用 `process.exitCode` 而不是 `process.exit()`。
   *
   * `process.exit()` **不会执行 `finally`** —— 第一版在 try 里直接 exit，
   * 于是那份 386 MB 的干净副本**从来没被删掉**，而且没有任何东西会抱怨
   * （脚本退出码 0、报告正常）。前几轮我把这些残留归因于「被中断的运行」，
   * 其实是正常路径：清理代码压根没跑到。
   */
  process.exitCode = ok && same ? 0 : 1
} catch (error) {
  note(`实跑自身出错：${String(error)}`)
  writeFileSync(reportPath, log.join('\n'), 'utf8')
  process.exitCode = 1
} finally {
  if (!keep) {
    try {
      rmSync(dest, { recursive: true, force: true })
    } catch (error) {
      note(`NOTE  副本没删掉（${String(error)}）：${dest}`)
    }
  } else {
    note(`（副本保留在 ${dest}）`)
  }
}
