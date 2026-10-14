/**
 * sidecar 线协议自测。
 *
 * 之前这套验证是手工跑的（`echo '{"id":"1","method":"ping"}' | node sidecar.js`），
 * 手工的东西不会每次都跑。这里固化成脚本，让「stdout 只有合法协议帧」这条硬约束
 * 在每次改动后都能被机器检查 —— 它是那种一旦破坏就极难排查的问题
 * （一行 console.log 就能让主进程的解析器吃到垃圾帧）。
 *
 * 用法：
 *   node scripts/verify-protocol.mjs            # 测 dist/sidecar.js（开发产物）
 *   node scripts/verify-protocol.mjs --bundle   # 测 dist-bundle/sidecar.js（打包产物）
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')
const useBundle = process.argv.includes('--bundle')
const entry = join(packageRoot, useBundle ? 'dist-bundle' : 'dist', 'sidecar.js')

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

if (!existsSync(entry)) {
  console.error(`sidecar 产物不存在: ${entry}\n请先执行 pnpm --filter @i-pi-desk/agent-host build${useBundle ? ' && ... run bundle' : ''}`)
  process.exit(1)
}

console.log(`测试目标：${entry}\n`)

// 用临时 agent 目录，绝不碰用户真实的 ~/.pi 或应用 userData。
const agentDir = mkdtempSync(join(tmpdir(), 'ipi-proto-'))

const child = spawn(process.execPath, [entry], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }
})

let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => {
  stdout += chunk.toString('utf8')
})
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString('utf8')
})

const requests = [
  { id: 'a', method: 'ping' },
  { id: 'b', method: 'session.list' },
  // 未知方法必须回错误帧而不是崩掉进程 —— 前向兼容的基础。
  { id: 'c', method: 'definitely.not.a.method' }
]

for (const request of requests) {
  child.stdin.write(`${JSON.stringify(request)}\n`)
}
// 关闭 stdin 应当触发主动退出，不留下孤儿进程。
child.stdin.end()

const exitCode = await new Promise((resolve) => {
  const timer = setTimeout(() => {
    child.kill()
    resolve('TIMEOUT')
  }, 30_000)
  child.on('exit', (code) => {
    clearTimeout(timer)
    resolve(code)
  })
})

console.log('── stdout ──')
console.log(stdout.trim() || '(空)')
console.log('\n── stderr（前 6 行）──')
console.log(stderr.split('\n').slice(0, 6).join('\n'))
console.log('')

const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
const frames = []
let invalid = 0
for (const line of lines) {
  try {
    frames.push(JSON.parse(line))
  } catch {
    invalid += 1
    console.log(`  非法 JSON 帧: ${line.slice(0, 200)}`)
  }
}

console.log('── 断言 ──')
check('stdout 每一行都是合法 JSON', invalid === 0, `${invalid} 行无法解析`)
check('收到 3 个应答帧', frames.length === 3, `实际 ${frames.length}`)
check('应答 id 与请求一一对应', ['a', 'b', 'c'].every((id) => frames.some((f) => f.id === id)))

const ping = frames.find((f) => f.id === 'a')
check('ping 返回 ok:true', ping?.result?.ok === true, JSON.stringify(ping))

const unknown = frames.find((f) => f.id === 'c')
check('未知方法返回错误帧而不是崩溃', Boolean(unknown?.error), JSON.stringify(unknown))
check('错误帧带机器可读的 code', typeof unknown?.error?.code === 'string', JSON.stringify(unknown))

check('进程正常退出（stdin 关闭即退出）', exitCode === 0, `exitCode=${exitCode}`)
check('启动日志走的是 stderr', stderr.includes('[sidecar]'), 'stderr 里没有 sidecar 日志')
check(
  'agent 目录被环境变量接管',
  stderr.includes(agentDir),
  `期望 stderr 出现 ${agentDir}`
)

rmSync(agentDir, { recursive: true, force: true })

console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
