#!/usr/bin/env node
/**
 * 插件子进程的**生命周期终点**：父进程走了，它会不会变成孤儿。
 *
 * ## 为什么这一条值得单独验
 *
 * 插件是一个独立 Node 进程。它的正常收尾路径有两条，代码里都写了：
 *
 *  1. **礼貌退出**：`runtime.shutdown()` → `#plugins.deactivateAll()` → kill；
 *  2. **父进程消失**：`plugin-runner.mjs` 监听 stdin 的 `close` 事件
 *     ——「父进程关掉 stdin = 让我们退出。不主动 exit 会留下孤儿子进程」。
 *
 * 第 2 条才是**用户按强制退出 / sidecar 崩了**时的唯一防线。
 * 它没有任何测试：现有的插件自测全都是礼貌地调用 `deactivateAll`，
 * 也就是说「崩溃不留孤儿」这件事此前只是注释里的承诺。
 *
 * 而它的失效方式很隐蔽：用户关掉应用之后，任务管理器里还剩几个 Node 进程，
 * 谁也不会想到那是插件；下次打开应用又多几个。
 *
 * ## 怎么验
 *
 * 起一个**假的父进程**（子进程里的子进程），它：
 *  - 激活夹具插件，把插件进程的 pid 打到 stdout；
 *  - 然后挂着不动（模拟一个正在运行的 sidecar）。
 *
 * 然后分两种方式让它死：
 *  - **礼貌**：发 SIGTERM，父进程自己 `deactivateAll()` 再退出；
 *  - **强杀**：SIGKILL，什么都来不及做 —— 只能靠插件自己发现 stdin 没了。
 *
 * 判据用 `process.kill(pid, 0)`：进程没了会抛 `ESRCH`。这比「看状态字」强，
 * 因为状态是父进程内存里的事，父进程都死了就没人记得它了。
 *
 * ## 诚实标注：这条断言证明的边界
 *
 * A/B 实验（把 runner 的 stdin-close 处理关掉、**并且**加一个心跳占住事件循环）
 * 之后，强杀父进程时插件**依然**消失 —— 而且它**没有跑自己的 `exit` 钩子**
 * （临时埋点的日志文件始终没出现）。也就是说：在这台机器上，
 * 外部的**进程树清理**也在收这件事，本自测**分不清**是插件自己走的还是被外部收走的。
 *
 * 所以这条断言保证的是**性质**（强杀父进程不留孤儿进程），不是某个实现。
 * 想单独确认 runner 那条处理是承重的，要看手工实验：
 * 给 runner 加一个心跳（事件循环不再自然空转）后，**不关 stdin 就一直活着、
 * 关掉 stdin 才会退出** —— 那条处理确实是承重的，不是摆设。
 *
 * 之所以不把「runner 自己退出」写成断言：在当前环境里它会被外部清理抢先满足，
 * 于是断言恒真、也就没有意义了。
 *
 * 用法：node packages/agent-host/scripts/verify-plugin-orphan.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const fixtureDir = join(repoRoot, 'tools', 'fixture-plugin')

let failures = 0
function check(label, condition, detail = '') {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

const root = mkdtempSync(join(tmpdir(), 'ipi-orphan-'))

/**
 * 假父进程：激活插件 → 报出插件 pid → 挂住等信号。
 *
 * 它刻意尽量像 sidecar：`SIGTERM` 走 `deactivateAll()` 再退出（礼貌路径），
 * 而 `SIGKILL` 什么都做不了（模拟崩溃 / 强制退出）。
 */
const parentScript = join(root, 'fake-parent.mjs')
writeFileSync(
  parentScript,
  `import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { PluginHost } from ${JSON.stringify(pathToFileURL(join(here, '..', 'dist', 'plugin-host.js')).href)}
import { validatePluginManifest } from ${JSON.stringify(pathToFileURL(join(repoRoot, 'packages', 'shared', 'dist', 'index.js')).href)}
import { readFileSync } from 'node:fs'

const fixtureDir = ${JSON.stringify(fixtureDir)}
const manifest = JSON.parse(readFileSync(join(fixtureDir, 'manifest.json'), 'utf8'))
const validation = validatePluginManifest(manifest)
if (!validation.ok) {
  process.stdout.write('ERROR:manifest\\n')
  process.exit(1)
}

const host = new PluginHost({ log: () => undefined, toolTimeoutMs: 5000 })
host.register(validation.manifest, fixtureDir)
const activated = await host.activate(validation.manifest.id)
const info = host.list()[0]
process.stdout.write('PID:' + info.pid + ' TOOLS:' + activated.tools.join(',') + '\\n')

process.on('SIGTERM', async () => {
  // 礼貌路径：和 runtime.shutdown() 一样，先收插件再退。
  await host.deactivateAll()
  process.stdout.write('DEACTIVATED\\n')
  process.exit(0)
})

// 挂住不动。
setInterval(() => {}, 1000)
`,
  'utf8'
)

/** 进程还活着吗（`kill(pid, 0)`）：比看状态字可靠，父进程死了也照样能判断。 */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

async function waitGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return Date.now() - (deadline - timeoutMs)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return null
}

/** 起一个假父进程，等它报出插件 pid。 */
function startParent() {
  const child = spawn(process.execPath, [parentScript], { stdio: ['pipe', 'pipe', 'pipe'] })
  const done = new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error(`假父进程 20 秒内没报出 pid：${buffer}`)), 20_000)
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      const line = buffer.split('\n').find((entry) => entry.startsWith('PID:'))
      if (!line) return
      clearTimeout(timer)
      const pid = Number(line.slice(4).split(' ')[0])
      const tools = /TOOLS:(.*)$/.exec(line)?.[1] ?? ''
      resolve({ child, pluginPid: pid, tools })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`假父进程提前退出 code=${code}：${buffer}`))
    })
  })
  return done
}

try {
  console.log('── 前提：插件真的在独立进程里跑起来了 ──')
  {
    const { child, pluginPid, tools } = await startParent()
    check('假父进程报出了插件进程的 pid', Number.isInteger(pluginPid) && pluginPid > 0, String(pluginPid))
    check('插件报告了它贡献的工具', tools.includes('fixture_echo'), tools)
    check('插件进程此刻活着', alive(pluginPid), String(pluginPid))

    console.log('\n── 路径一：礼貌退出（SIGTERM → deactivateAll）──')
    child.kill('SIGTERM')
    const politeGone = await waitGone(pluginPid, 10_000)
    check('礼貌退出后插件进程消失了', politeGone !== null, `pid=${pluginPid} 仍然活着`)
    await new Promise((resolve) => setTimeout(resolve, 300))
  }

  console.log('\n── 路径二：强杀父进程（模拟崩溃 / 强制退出）──')
  {
    const { child, pluginPid } = await startParent()
    check('新的插件进程活着', alive(pluginPid), String(pluginPid))

    /**
     * SIGKILL：父进程**什么都来不及做** —— 没有 deactivateAll，没有 exit 钩子。
     * 唯一的指望是插件自己发现 stdin 已关闭。
     */
    child.kill('SIGKILL')
    const start = Date.now()
    const gone = await waitGone(pluginPid, 15_000)
    check(
      '父进程被强杀后，插件进程也消失了（不留下孤儿）',
      gone !== null,
      `pid=${pluginPid} 在 15 秒后仍然活着 —— 用户强退应用后会留下这个进程`
    )
    if (gone !== null) console.log(`        （实测：${Date.now() - start}ms 内退出）`)
    await new Promise((resolve) => setTimeout(resolve, 300))
  }

  console.log('\n── 对照：判据本身是有效的 ──')
  {
    /**
     * 上面两条都断言「进程消失了」。如果 `alive()` 永远返回 false，
     * 它们会**恒真** —— 所以这里拿一个确实活着的进程来证明判据能分辨。
     */
    const { child, pluginPid } = await startParent()
    check('对照组：一个确实活着的插件进程被判为「活着」', alive(pluginPid), String(pluginPid))
    child.kill('SIGTERM')
    await waitGone(pluginPid, 10_000)
  }
} catch (error) {
  failures += 1
  console.log(`  FAIL  自测自身出错: ${String(error)}`)
} finally {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    console.log(`  NOTE  临时目录删不掉：${root}`)
  }
}

console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
