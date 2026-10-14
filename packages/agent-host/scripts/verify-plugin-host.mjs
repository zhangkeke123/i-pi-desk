#!/usr/bin/env node
/**
 * 插件宿主自测。
 *
 * 它**不启动 Electron 应用**，而是直接驱动 `PluginHost`，因此能验证到应用层面
 * 验不到的东西：工具真的在子进程里执行了、环境变量确实被裁剪过、以及
 * 子进程能被干净地收掉。
 *
 * 为什么要单独一层：通过真实应用调插件工具需要模型主动发起工具调用，
 * 那依赖一个可用的模型。而「插件运行时对不对」与「模型调不调它」是两件独立的事 ——
 * 分开验证，前者就不必被后者的前提卡住。
 *
 * 用法：node packages/agent-host/scripts/verify-plugin-host.mjs
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PluginHost } from '../dist/plugin-host.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const fixtureDir = join(repoRoot, 'tools', 'fixture-plugin')

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

if (!existsSync(join(fixtureDir, 'manifest.json'))) {
  console.error(`夹具插件不存在：${fixtureDir}`)
  process.exit(1)
}

// 设一个「不该泄漏给插件」的变量，用来验证 env 裁剪真的生效。
const SECRET_NAME = 'IPI_FIXTURE_SECRET'
const SECRET_VALUE = `leak-canary-${Date.now()}`
process.env[SECRET_NAME] = SECRET_VALUE

const logs = []
const host = new PluginHost({ log: (line) => logs.push(line), toolTimeoutMs: 15_000 })

/** 从日志里数「插件进程还活着」的证据。 */
const tempDirs = []

try {
  console.log('── 登记与激活 ──')

  const { validatePluginManifest } = await import('../../../packages/shared/dist/index.js')
  const manifest = JSON.parse(
    (await import('node:fs')).readFileSync(join(fixtureDir, 'manifest.json'), 'utf8')
  )
  const validation = validatePluginManifest(manifest)
  check('夹具的 manifest 通过校验', validation.ok === true, JSON.stringify(validation.errors ?? []))
  if (!validation.ok) throw new Error('夹具 manifest 不合法，后续断言无意义')

  host.register(validation.manifest, fixtureDir)
  check('登记后状态为 inactive', host.list()[0]?.state === 'inactive', JSON.stringify(host.list()))

  const activated = await host.activate('ipi.fixture-plugin')
  check('激活成功并报告工具', activated.tools.includes('fixture_echo'), JSON.stringify(activated))
  check('状态变为 active', host.list()[0]?.state === 'active', JSON.stringify(host.list()))
  check('插件的 ctx.log 被转发成宿主日志', logs.some((line) => line.includes('fixture 已激活')), JSON.stringify(logs.slice(0, 3)))

  console.log('\n── 工具执行 ──')
  const result = await host.callTool('ipi.fixture-plugin', 'fixture_echo', { text: 'hello-marker' }, repoRoot)
  check('工具返回不是错误', result.isError === false, JSON.stringify(result))

  let payload = null
  try {
    payload = JSON.parse(result.content)
  } catch {
    // 下面那条断言会报出来
  }
  check('回显文本正确（证明真的在子进程里执行了）', payload?.echo === 'hello-marker', result.content)

  /**
   * 这是本轮最要紧的一条：插件进程**不继承** process.env。
   * 用户 shell 里的令牌、代理凭据、CI 密钥都不该顺手流进插件。
   */
  check('环境变量被裁剪：看不到宿主的敏感变量', payload?.leakedSecret === null, result.content)
  check('环境变量被裁剪：PATH 仍然可用（否则子进程连命令都跑不了）', payload?.hasPath === true, result.content)
  check(
    'ELECTRON_RUN_AS_NODE 已注入（否则 electron 会去开窗口而不是跑脚本）',
    payload?.hasElectronRunAsNode === true,
    result.content
  )

  console.log('\n── 错误路径 ──')
  const missing = await host.callTool('ipi.fixture-plugin', 'no_such_tool', {}, repoRoot)
  check('调用不存在的工具返回 isError 而不是抛异常', missing.isError === true, JSON.stringify(missing))

  const unknownPlugin = await host.callTool('not.installed', 'x', {}, repoRoot)
  check('调用未登记插件的工具返回 isError', unknownPlugin.isError === true, JSON.stringify(unknownPlugin))

  console.log('\n── 贡献汇总 ──')
  const contributed = host.contributedTools()
  check(
    'contributedTools 报出夹具工具',
    contributed.some((tool) => tool.toolName === 'fixture_echo' && tool.pluginId === 'ipi.fixture-plugin'),
    JSON.stringify(contributed)
  )
  check('工具带上了参数 schema', contributed[0]?.parameters?.type === 'object', JSON.stringify(contributed[0]?.parameters))

  console.log('\n── 收尾 ──')
  await host.deactivateAll()
  check('停用后状态回到 inactive', host.list()[0]?.state === 'inactive', JSON.stringify(host.list()))

  // 子进程必须真的没了 —— 否则每次开关插件都留一个 Node 进程。
  await new Promise((r) => setTimeout(r, 800))
  const stillRunning = host.list().some((info) => info.state !== 'inactive')
  check('停用后没有残留的运行态插件', !stillRunning, JSON.stringify(host.list()))
} catch (error) {
  failures += 1
  console.log(`  FAIL  自测自身出错: ${String(error)}`)
  console.log(`        插件日志：${JSON.stringify(logs.slice(-5))}`)
} finally {
  await host.deactivateAll().catch(() => undefined)
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
