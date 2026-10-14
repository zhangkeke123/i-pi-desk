#!/usr/bin/env node
/**
 * 内核依赖与许可的核对。
 *
 * ## 为什么值得有一条断言
 *
 * 这一条对的是**目标里那句「复用 @earendil-works/pi-*（MIT）作为 agent 内核」**。
 * 它有三个具体的失效方式，都不会自己暴露：
 *
 *  1. **依赖被换成裸包名**：npm 上的 `pi-ai` / `pi-agent-core` / `pi-coding-agent`
 *     是**占位项目**，不是内核。第一轮就踩过这个坑（写下 `pi-ai` 之类的名字），
 *     而装上去不会报错 —— 只会在运行到某个导入时报「没有这个导出」。
 *  2. **版本漂移**：三个包必须同版本（1.1.0）。混版本在 SDK 层会出很怪的问题。
 *  3. **许可声明的义务**：我们把内核**随应用一起分发**，MIT 要求随附版权声明与许可文本，
 *     所以仓库里必须有 `THIRD-PARTY.md`，且它的内容要对得上（版权行、许可名、包名）。
 *
 * 另外断言「仓库里没有上游 LGPL 项目的痕迹」—— 它是架构参考，不是依赖，
 * 更不能有它的源码（上游最重的那部分是 Rust，所以「没有 Cargo.toml / *.rs」是一条有力证据）。
 *
 * 用法：node tools/verify-kernel-deps.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const KERNEL = ['@earendil-works/pi-ai', '@earendil-works/pi-agent-core', '@earendil-works/pi-coding-agent']
const KERNEL_VERSION = '1.1.0'
/** npm 上的同名裸包是占位项目，永远不能用。 */
const PLACEHOLDER_NAMES = ['pi-ai', 'pi-agent-core', 'pi-coding-agent']

let failures = 0
function check(label, condition, detail = '') {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

/** 读取所有 workspace 包的依赖声明。 */
function declaredDeps() {
  const out = new Map()
  const files = [
    'package.json',
    'packages/shared/package.json',
    'packages/agent-host/package.json',
    'apps/desktop/package.json'
  ]
  for (const file of files) {
    let json
    try {
      json = JSON.parse(readFileSync(join(repo, file), 'utf8'))
    } catch {
      continue
    }
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [name, version] of Object.entries(json[field] ?? {})) {
        out.set(name, { version, where: `${file}:${field}` })
      }
    }
  }
  return out
}

try {
  const deps = declaredDeps()

  console.log('── 内核依赖 ──')
  for (const name of KERNEL) {
    const info = deps.get(name)
    check(`${name} 被声明`, info !== undefined, '没有任何 package.json 声明它')
    if (!info) continue
    check(
      `${name} 的版本是 ${KERNEL_VERSION}（三个包必须同版本）`,
      info.version === KERNEL_VERSION,
      `${info.where} 写的是 ${info.version}`
    )
  }

  console.log('\n── 不许踩的坑：npm 上的同名裸包是占位项目 ──')
  for (const name of PLACEHOLDER_NAMES) {
    check(`没有声明裸包名 ${name}`, !deps.has(name), `声明在 ${deps.get(name)?.where}`)
  }

  console.log('\n── 实际安装的内核包声明 MIT ──')
  const installed = join(repo, 'packages', 'agent-host', 'node_modules', '@earendil-works')
  check('内核包已安装（node_modules 里能找到）', existsSync(installed), installed)
  if (existsSync(installed)) {
    for (const name of ['pi-ai', 'pi-agent-core', 'pi-coding-agent']) {
      const pkgPath = join(installed, name, 'package.json')
      let json = null
      try {
        json = JSON.parse(readFileSync(pkgPath, 'utf8'))
      } catch {
        // 下面那条断言会报
      }
      check(`${name} 的 license 字段是 MIT`, json?.license === 'MIT', JSON.stringify(json?.license ?? null))
    }
  }

  console.log('\n── MIT 要求的版权声明与许可文本 ──')
  const noticePath = join(repo, 'THIRD-PARTY.md')
  check('仓库里有 THIRD-PARTY.md', existsSync(noticePath), noticePath)
  if (existsSync(noticePath)) {
    const notice = readFileSync(noticePath, 'utf8')
    check('声明里写出了版权持有人与年份', /Copyright \(c\) \d{4} Mario Zechner/.test(notice), '找不到 Copyright (c) <year> Mario Zechner')
    check('声明里含完整的 MIT 许可正文', /Permission is hereby granted, free of charge/.test(notice) && /WITHOUT WARRANTY OF ANY KIND/.test(notice), 'MIT 正文不完整')
    for (const name of KERNEL) {
      check(`声明里点名了 ${name}`, notice.includes(name), name)
    }
  }

  console.log('\n── 上游 LGPL 项目：只作参考，不是依赖、也不含其源码 ──')
  for (const name of PLACEHOLDER_NAMES) void name
  check('vastsa/PI-Desktop 不在依赖里', ![...deps.keys()].some((n) => /vastsa|pi-desktop/i.test(n)), JSON.stringify([...deps.keys()].filter((n) => /vastsa|pi-desktop/i.test(n))))

  const lock = readFileSync(join(repo, 'pnpm-lock.yaml'), 'utf8')
  check('锁文件里没有上游项目', !/vastsa|PI-Desktop/i.test(lock), '锁文件里出现了上游项目的名字')

  /** 上游最重的部分是 Rust 宿主；仓库里出现 Rust 就是「引了它的东西」的硬证据。 */
  const rust = []
  const skip = new Set(['node_modules', 'release', 'out', 'dist', 'dist-bundle', '.git', '.tmp-warm-flow'])
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === 'Cargo.toml' || entry.name.endsWith('.rs')) rust.push(full.slice(repo.length + 1))
    }
  }
  walk(repo)
  check('仓库里没有 Rust 痕迹（Cargo.toml / *.rs）', rust.length === 0, JSON.stringify(rust.slice(0, 5)))

  /**
   * 上游的名字只允许出现在文档与注释里。源码里出现就要看一眼 ——
   * 所以这条断言查的是「它在 .ts/.tsx 源码里出现的位置只有注释」。
   */
  const sourceMentions = []
  const walkSource = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name) || entry.name === 'docs') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walkSource(full)
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        const lines = readFileSync(full, 'utf8').split('\n')
        lines.forEach((line, index) => {
          if (!/PI-Desktop|vastsa/i.test(line)) return
          const trimmed = line.trim()
          const isComment = trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')
          if (!isComment) sourceMentions.push(`${full.slice(repo.length + 1)}:${index + 1} ${trimmed.slice(0, 60)}`)
        })
      }
    }
  }
  walkSource(repo)
  check(
    '源码里提到上游的地方都只是注释（没有把它的代码搬进来）',
    sourceMentions.length === 0,
    JSON.stringify(sourceMentions.slice(0, 4))
  )

  console.log('\n── 三进程边界：内核只能被 agent-host 碰 ──')
  /**
   * 这一组对的是目标里的「三进程架构」。
   *
   * 边界不是靠自觉维持的：只要 `apps/desktop` 的依赖里能解析到内核包，
   * 以后某次重构就可能顺手在渲染层或主进程里 `import` 它 —— 那会把
   * 「主进程不跑 agent、渲染层不碰内核」这条架构约束悄悄破掉。
   *
   * 起因是审计时发现 `apps/desktop` **声明**了 `@earendil-works/pi-ai` 却一处都没导入
   * （删掉之后 typecheck 照样全绿）—— 一条会削弱边界的死声明。
   */
  const desktopDeps = new Set(Object.keys(JSON.parse(readFileSync(join(repo, 'apps/desktop/package.json'), 'utf8')).devDependencies ?? {}))
  for (const name of Object.keys(JSON.parse(readFileSync(join(repo, 'apps/desktop/package.json'), 'utf8')).dependencies ?? {})) {
    desktopDeps.add(name)
  }
  check(
    'apps/desktop 不声明内核包（要用只能经 @i-pi-desk/agent-host）',
    ![...desktopDeps].some((name) => name.startsWith('@earendil-works/')),
    JSON.stringify([...desktopDeps].filter((name) => name.startsWith('@earendil-works/')))
  )

  const importViolations = []
  const walkImports = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walkImports(full)
        continue
      }
      if (!/\.(ts|tsx|mjs|js)$/.test(entry.name)) continue
      const rel = full.slice(repo.length + 1).split('\\').join('/')
      if (rel.startsWith('packages/agent-host/')) continue // 内核只能在这里被导入
      // 只看**真的导入**（import 语句），文档/注释里提到名字不算
      const text = readFileSync(full, 'utf8')
      if (/(?:^|\n)\s*import[^'\n]*from\s*['"]@earendil-works\//.test(text) || /await import\(['"]@earendil-works\//.test(text)) {
        importViolations.push(rel)
      }
    }
  }
  walkImports(repo)
  check(
    '内核对源码的导入只出现在 packages/agent-host/ 下',
    importViolations.length === 0,
    JSON.stringify(importViolations.slice(0, 5))
  )

  console.log('\n── 声明要随产物一起分发 ──')
  const desktopPkg = JSON.parse(readFileSync(join(repo, 'apps', 'desktop', 'package.json'), 'utf8'))
  const extra = JSON.stringify(desktopPkg.build?.extraResources ?? [])
  check(
    'electron-builder 配置把 THIRD-PARTY.md 放进 extraResources',
    extra.includes('THIRD-PARTY.md'),
    extra.slice(0, 200)
  )
} catch (error) {
  failures += 1
  console.log(`  FAIL  自测自身出错: ${String(error)}`)
}

console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
void statSync
