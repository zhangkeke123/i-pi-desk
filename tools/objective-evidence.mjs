#!/usr/bin/env node
/**
 * 目标兑现的**取证报告**：逐条对照目标，列出证据与结果。
 *
 * ## 为什么要一个脚本，而不是写一份文档
 *
 * 「做完了没有」不该靠叙述，也不该靠一份会过期的静态文档。
 * 这个脚本每次跑都会：读一次全量验证日志 → 按脚本数断言 → 检查每条要求的**产物**是否存在
 * → 输出一份可复核的报告；任何一条证据缺失或失败，它自己就红。
 *
 * 它是 `docs/HANDOVER.md` §9 那张核对表的可执行版本：那张表说「对应哪个脚本」，
 * 这个脚本负责把那句话跑出来。
 *
 * ## 用法
 *
 * ```powershell
 * pnpm verify *> "$env:TEMP\verify.log"
 * pnpm --filter @i-pi-desk/desktop run verify:packaging *>> "$env:TEMP\verify.log"
 * pnpm --filter @i-pi-desk/desktop run verify:packaged  *>> "$env:TEMP\verify.log"
 * node tools/objective-evidence.mjs "$env:TEMP\verify.log"
 * ```
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { argv, exit } from 'node:process'
import { fileURLToPath } from 'node:url'

const logPath = argv[2]
if (!logPath) {
  console.error('用法：node tools/objective-evidence.mjs <全量验证日志>')
  exit(2)
}
const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const log = readFileSync(logPath, 'utf8')

/** 与 reconcile-counts 同一套切桶规则（这里只用来给每条要求报出条数）。 */
function countedPerScript(text) {
  const out = new Map()
  let current = null
  const bump = (name) => out.set(name, (out.get(name) ?? 0) + 1)
  for (const line of text.split('\n')) {
    if (/^[>$] /.test(line)) {
      const pkgBanner = /^[>$] .*@[\d.]+\s+([a-z][a-z0-9:-]*)\b/.exec(line)
      const fromFile = /(verify-[a-z-]+)\.mjs/.exec(line)
      if (pkgBanner) {
        const name = pkgBanner[1]
        if (name.startsWith('verify:')) current = name
        else if (name === 'test' || name === 'typecheck') current = '(unit)'
      } else if (fromFile && line.startsWith('$ ')) {
        current = fromFile[1].replace(/^verify-/, 'verify:')
      }
      continue
    }
    if (/^\s*\S+ test:\s+PASS {2}/.test(line)) bump('(unit)')
    else if (/^\s*PASS {2}/.test(line) && current) bump(current)
  }
  return out
}

const counted = countedPerScript(log)
const unitPass = counted.get('(unit)') ?? 0
const failLines = (log.match(/^ {2}FAIL {2}/gm) ?? []).length

/**
 * 目标逐条 → 证据。
 *
 * `scripts` 里的名字必须在日志里出现且断言数 > 0；`artifacts` 是必须存在的路径；
 * `caveat` 是**必须一起说出口**的边界（不许只报喜）。
 */
const CLAUSES = [
  {
    id: 1,
    text: 'Electron + React + TypeScript + Vite',
    scripts: ['verify:bundle'],
    artifacts: ['apps/desktop/src', 'apps/desktop/electron', 'packages/shared/src', 'apps/desktop/package.json'],
    caveat: '三份产物（main / preload / renderer）与按需 chunk 由 verify:bundle 断言；类型检查由 pnpm typecheck 覆盖'
  },
  {
    id: 2,
    text: '复用 @earendil-works/pi-*（MIT）作为 agent 内核',
    scripts: ['verify:kernel-deps'],
    artifacts: ['THIRD-PARTY.md', 'packages/agent-host/src/runtime.ts'],
    caveat: 'MIT 声明随产物分发；上游 LGPL 项目只作架构参考、未使用其源码（依赖、锁文件、Rust 痕迹三项断言）'
  },
  {
    id: 3,
    text: '可跑的桌面壳 + 三进程架构',
    scripts: ['verify:protocol', 'verify:packaged'],
    artifacts: ['packages/agent-host/src/sidecar.ts', 'apps/desktop/electron/main/index.ts', 'apps/desktop/electron/preload'],
    caveat: '内核只能被 agent-host 导入（verify:kernel-deps 有越界导入断言）；打包产物真的启动过（verify:packaged）'
  },
  {
    id: 4,
    text: 'agent 会话与工具调用闭环（read/write/edit/bash/glob/grep）',
    scripts: ['verify:api-matrix', 'verify:anthropic-tool-loop', 'verify:renderer'],
    artifacts: ['packages/agent-host/src/translate.ts'],
    caveat: '目标里写的 glob 在 pi 当前版本叫 find（同为只读类）；工具集是 read/grep/find/ls/write/edit/bash(+Windows powershell)'
  },
  {
    id: 5,
    text: '多模型 provider 配置',
    scripts: ['verify:api-matrix'],
    artifacts: ['packages/agent-host/src/provider.ts'],
    caveat: '四种 apiStyle 的请求构建已离线验完；真实厂商的用量/流式格式差异需要真端点（见 §4）'
  },
  {
    id: 6,
    text: '会话持久化',
    scripts: ['verify:history', 'verify:no-persistence'],
    artifacts: ['apps/desktop/electron/main/store'],
    caveat: '主进程落盘 + 内核回灌；重启后恢复由 verify:renderer 的重启段落实测'
  },
  {
    id: 7,
    text: '工作区 / 编辑器 / 终端 / 差异等面板',
    scripts: ['verify:renderer', 'verify:packaging'],
    artifacts: [
      'apps/desktop/src/features/workspace/WorkspacePanel.tsx',
      'apps/desktop/src/features/workspace/CodeEditor.tsx',
      'apps/desktop/src/features/terminal/TerminalPanel.tsx',
      'apps/desktop/src/features/diff/DiffView.tsx'
    ],
    caveat:
      '编辑器与文件树同在 features/workspace（CodeEditor.tsx / WorkspacePanel.tsx）；终端依赖本机 node-pty 原生构建；mac/linux 产物在本机无法产出可用的（配置已就位）'
  },
  {
    id: 8,
    text: 'skills 与插件扩展机制',
    scripts: ['verify:plugins', 'verify:plugin-failure', 'verify:plugin-orphan'],
    artifacts: ['tools/fixture-plugin', 'packages/agent-host/src/plugin-host.ts'],
    caveat: '插件没有 OS 级沙箱（设计决定）；热重载未做（改文件后要重建会话）'
  },
  {
    id: 9,
    text: '对齐控制面（登录 / 模型下发 / skill 分发 / 配额 / 审计）的接入点',
    scripts: ['verify:contract'],
    artifacts: ['docs/CONTROL-PLANE.md', 'tools/mock-control-plane/server.mjs'],
    caveat: '**只有客户端侧接入点**；服务端不在本仓库、不在交付范围（§9.0 说明了原因）'
  },
  {
    id: 10,
    text: '交付物：可运行代码',
    scripts: ['verify:protocol'],
    artifacts: ['tools/clean-checkout.mjs', 'pnpm-lock.yaml'],
    caveat: '「只有源码的副本也能装、能构建、能跑验证」由 tools/clean-checkout.mjs 证明（不在 verify 链里，按需跑）'
  },
  {
    id: 11,
    text: '交付物：架构文档',
    scripts: ['verify:doc-claims'],
    artifacts: ['docs/ARCHITECTURE.md', 'docs/HANDOVER.md', 'docs/PI-SDK-NOTES.md', 'README.md'],
    caveat: '四类引用（链接 / 小节 / 脚本 / 代码文件名）都必须能解析；过时说法有负向锚点'
  },
  {
    id: 12,
    text: '交付物：里程碑计划',
    scripts: ['verify:doc-claims'],
    artifacts: ['docs/ARCHITECTURE.md'],
    caveat: 'M0–M6 表在 §11（含每阶段验收标准与状态）；§11.1 是逐条标明验证程度的未验证清单'
  }
]

let problems = 0
const lines = []
const out = (line) => {
  console.log(line)
  lines.push(line)
}

out(`# 目标兑现取证报告`)
out(``)
out(`日志：${logPath}`)
out(`日志里的断言：**${(log.match(/ {2}PASS {2}/g) ?? []).length} 条**（其中单测 ${unitPass} 条）｜FAIL 行：**${failLines}**`)
out(``)

for (const clause of CLAUSES) {
  const evidence = []
  let ok = true

  for (const script of clause.scripts) {
    const count = counted.get(script)
    if (count === undefined || count === 0) {
      ok = false
      evidence.push(`❌ \`${script}\`：日志里没有它的断言（没跑？）`)
    } else {
      evidence.push(`✅ \`${script}\`：${count} 条`)
    }
  }

  const missing = clause.artifacts.filter((path) => !existsSync(join(repo, path)))
  if (missing.length > 0) {
    ok = false
    evidence.push(`❌ 产物缺失：${missing.join(', ')}`)
  } else {
    evidence.push(`✅ 产物在位：${clause.artifacts.join(', ')}`)
  }

  if (failLines > 0) ok = false
  if (!ok) problems += 1

  out(`## ${ok ? '✅' : '❌'} ${clause.id}. ${clause.text}`)
  for (const line of evidence) out(`- ${line}`)
  out(`- ⚠️ 边界：${clause.caveat}`)
  out(``)
}

out(`---`)
out(``)
out(`**结论：${problems === 0 ? '12 条要求全部有可复核的证据' : `${problems} 条要求的证据不完整`}**`)
out(``)
out(`> 这份报告是生成的，不是写死的：\`node tools/objective-evidence.mjs <全量日志>\`。
> 它只证明「这些脚本跑了且全绿、这些产物在位」——**不证明**目标里那些需要真实端点/真实机器的部分，
> 那些逐条列在 \`docs/HANDOVER.md\` §4，并且明确标注为未验证。`)

exit(problems === 0 ? 0 : 1)
