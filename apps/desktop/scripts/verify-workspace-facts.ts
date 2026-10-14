/**
 * 工作区扫描器的单测：在临时目录里造一个迷你项目，看它**读出来的是什么**。
 *
 * 跑法：node --experimental-strip-types scripts/verify-workspace-facts.ts（挂在 `pnpm test` 链上）
 *
 * 为什么值得单独测：这个模块的每一个数字都会**出现在界面上**（「扫到 12 个源文件」），
 * 而它在真实项目上面临的是几万文件的目录树 —— 闸门（深度/文件数/读取数）一旦失效，
 * 症状不是报错而是「界面卡住」，那种问题只有在测试里造得出来。
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectWorkspace } from '../electron/main/store/workspace-facts.ts'

let failures = 0
let checks = 0
function check(label: string, condition: boolean, detail = ''): void {
  checks += 1
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

const root = await mkdtemp(join(tmpdir(), 'ipi-facts-'))

try {
  // ── 一个像样的迷你项目 ──
  await mkdir(join(root, 'src', 'deep', 'deeper'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'junk'), { recursive: true })
  await mkdir(join(root, '.git'), { recursive: true })
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { test: 'node --test', build: 'tsc', lint: 'eslint .' } })
  )
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  await writeFile(join(root, 'README.md'), '# fixture\n')
  await writeFile(join(root, 'src', 'main.ts'), '// TODO: 入口\nconst a = 1\n')
  await writeFile(join(root, 'src', 'util.ts'), '// FIXME: 边界\nexport const b = 2\n')
  await writeFile(join(root, 'src', 'main.test.ts'), 'test("x", () => {})\n')
  await writeFile(join(root, 'src', 'deep', 'deeper', 'nested.ts'), 'export const c = 3\n')
  // 这些**不该**被数进去
  await writeFile(join(root, 'node_modules', 'junk', 'index.ts'), '// TODO: 不该被数到\n')
  await writeFile(join(root, 'notes.md'), 'TODO: 这不是源码文件\n')

  const facts = await inspectWorkspace(root)
  console.log('\n── 扫描结果 ──')
  console.log(`  ${JSON.stringify(facts)}`)

  check('识别出包管理器', facts.packageManager === 'pnpm', String(facts.packageManager))
  check('读出 package.json 的脚本', facts.scripts.join(',') === 'test,build,lint', facts.scripts.join(','))
  check('认出源码根目录', facts.srcDir === 'src', String(facts.srcDir))
  check('认得出 README 与 git', facts.hasReadme && facts.hasGit)
  check('数到 4 个源文件（含嵌套的那一层）', facts.sourceFiles === 4, String(facts.sourceFiles))
  check('数到 1 个测试文件', facts.testFiles === 1, String(facts.testFiles))
  check('TODO / FIXME 各算一处，共 2 处', facts.todoCount === 2, String(facts.todoCount))
  check('node_modules 里的文件既不计入源文件也不计入 TODO', !facts.topLevelDirs.includes('node_modules'))
  check('markdown 里的 TODO 不算（只数源码）', facts.todoCount !== 3, String(facts.todoCount))
  check('顶层目录列表里没有隐藏目录', facts.topLevelDirs.every((dir) => !dir.startsWith('.')))
  check('目录不大时没有被截断', facts.truncated === false, JSON.stringify(facts))
  check('源文件数 > 0 时给出的建议才有依据（事实里带得到 srcDir）', facts.sourceFiles > 0 && facts.srcDir === 'src')

  // ── 源文件很多：源文件计数要**完整**，只有 TODO 统计是部分 ──
  const bigRoot = await mkdtemp(join(tmpdir(), 'ipi-facts-big-'))
  try {
    await mkdir(join(bigRoot, 'src'), { recursive: true })
    for (let index = 0; index < 80; index += 1) {
      await writeFile(join(bigRoot, 'src', `f${index}.ts`), index === 0 ? '// TODO: 唯一一处\n' : 'export const x = 1\n')
    }
    const big = await inspectWorkspace(bigRoot)
    check('80 个源文件时计数仍然完整', big.sourceFiles === 80, String(big.sourceFiles))
    check('源文件计数完整时**不**标记目录被截断', big.truncated === false, JSON.stringify({ truncated: big.truncated, todoPartial: big.todoPartial }))
    check('只有 TODO 统计被标记为部分（读取有上限）', big.todoPartial === true, JSON.stringify(big.todoPartial))
  } finally {
    await rm(bigRoot, { recursive: true, force: true })
  }

  // ── 不存在的目录：不能抛，要返回已知的部分 ──
  const missing = await inspectWorkspace(join(root, '并不存在的目录'))
  check('目录不存在时不抛异常', typeof missing === 'object' && missing !== null)
  check('目录不存在时标记为不完整（界面据此退回通用建议）', missing.truncated === true)
  check('目录不存在时计数为 0（不编造）', missing.sourceFiles === 0 && missing.todoCount === 0)

  // ── 坏掉的 package.json：整体仍然可用 ──
  const brokenRoot = await mkdtemp(join(tmpdir(), 'ipi-facts-broken-'))
  try {
    await writeFile(join(brokenRoot, 'package.json'), '{ 这不是 JSON')
    await mkdir(join(brokenRoot, 'src'), { recursive: true })
    await writeFile(join(brokenRoot, 'src', 'a.ts'), 'export const a = 1\n')
    const broken = await inspectWorkspace(brokenRoot)
    check('package.json 坏掉时不抛异常', typeof broken === 'object')
    check('package.json 坏掉时标记为不完整', broken.truncated === true)
  } finally {
    await rm(brokenRoot, { recursive: true, force: true })
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`\n（跑了 ${checks} 条断言）`)
console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
