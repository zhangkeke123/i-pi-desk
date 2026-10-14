/**
 * 技能文件管理的自测。
 *
 * 重点在**命名规范**与**路径安全**：技能名既是模型看到的路由键，也是文件系统里的
 * 目录名。这两件事叠在一起时，一个没校验好的名字就会同时造成
 * 「模型记不住」和「目录被写到别处」两种后果。
 *
 * 运行：`node --experimental-strip-types scripts/verify-skills.ts`
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  installSkillIn,
  listSkillsIn,
  parseSkillFrontmatter,
  removeSkillIn,
  validateSkillName
} from '../electron/main/store/skill-files.ts'

let failures = 0

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

function expectThrows(label: string, fn: () => unknown, expectedCode: string): void {
  try {
    fn()
    failures += 1
    console.log(`  FAIL  ${label} → 本该抛 ${expectedCode}，却成功返回`)
  } catch (error) {
    const code = (error as { code?: string }).code
    check(`${label} → [${code}]`, code === expectedCode, `期望 ${expectedCode}，实际 ${code}`)
  }
}

const root = mkdtempSync(join(tmpdir(), 'ipi-skills-'))
const skillsDir = join(root, 'skills')
const outside = join(root, 'outside')
mkdirSync(skillsDir, { recursive: true })
mkdirSync(outside, { recursive: true })

const GOOD = `---
name: team-conventions
description: 本仓库的提交与代码风格约定。写代码、提交前使用。
---

# 团队规范

- 提交信息用中文
`

try {
  console.log('=== 1. 技能名规范 ===')
  for (const name of ['a', 'team-conventions', 'k8s-ops', 'x1-y2-z3']) {
    let threw = false
    try {
      validateSkillName(name)
    } catch {
      threw = true
    }
    check(`合法：${name}`, !threw)
  }
  for (const [label, name] of [
    ['大写字母', 'Team-Conventions'],
    ['下划线', 'team_conventions'],
    ['前导连字符', '-team'],
    ['结尾连字符', 'team-'],
    ['连续连字符', 'team--x'],
    ['含空格', 'team conventions'],
    ['含路径分隔符', '../evil'],
    ['含反斜杠', '..\\evil'],
    ['空字符串', ''],
    ['超长（65 字符）', 'a'.repeat(65)]
  ] as const) {
    expectThrows(`非法：${label}`, () => validateSkillName(name), 'INVALID_SKILL_NAME')
  }

  console.log('\n=== 2. frontmatter 宽松解析 ===')
  const good = parseSkillFrontmatter(GOOD)
  check('解析出 name', good.name === 'team-conventions', JSON.stringify(good))
  check('解析出 description', Boolean(good.description?.includes('提交')), JSON.stringify(good))

  const quoted = parseSkillFrontmatter('---\nname: "quoted-name"\ndescription: \'单引号值\'\n---\n正文')
  check('带引号的值被去引号', quoted.name === 'quoted-name' && quoted.description === '单引号值', JSON.stringify(quoted))

  const bom = parseSkillFrontmatter(`\uFEFF${GOOD}`)
  check('带 BOM 也能解析（Windows 记事本场景）', bom.ok && bom.name === 'team-conventions', JSON.stringify(bom))

  const commented = parseSkillFrontmatter('---\n# 注释\nname: x\n---\n')
  check('忽略注释行', commented.name === 'x', JSON.stringify(commented))

  const noClosing = parseSkillFrontmatter('---\nname: x\n正文没有闭合')
  check('缺闭合 --- 时 ok=false', noClosing.ok === false, JSON.stringify(noClosing))

  const noFrontmatter = parseSkillFrontmatter('# 只有正文\n')
  check('完全没有 frontmatter 时 ok=false', noFrontmatter.ok === false, JSON.stringify(noFrontmatter))

  console.log('\n=== 3. 安装 / 列出 / 删除 ===')
  const installed = installSkillIn(skillsDir, 'team-conventions', GOOD)
  check('安装返回 description', installed.description?.includes('提交') === true, JSON.stringify(installed))
  check('SKILL.md 真的落盘', existsSync(installed.filePath), installed.filePath)
  check('declaredName 与目录名一致', installed.declaredName === 'team-conventions', JSON.stringify(installed))

  const listed = listSkillsIn(skillsDir)
  check('列出 1 个技能', listed.length === 1, JSON.stringify(listed.map((s) => s.name)))

  // 目录名与 frontmatter 声明不一致：必须能被 UI 发现（其它实现可能强制一致）
  installSkillIn(skillsDir, 'other-dir', '---\nname: declared-elsewhere\ndescription: d\n---\n')
  const mismatch = listSkillsIn(skillsDir).find((s) => s.name === 'other-dir')
  check(
    '能暴露「目录名 ≠ frontmatter 名」',
    mismatch?.declaredName === 'declared-elsewhere',
    JSON.stringify(mismatch)
  )

  // 缺 description：内核不会加载，UI 必须能标出
  installSkillIn(skillsDir, 'no-desc', '---\nname: no-desc\n---\n正文')
  const noDesc = listSkillsIn(skillsDir).find((s) => s.name === 'no-desc')
  check('缺 description 被识别', noDesc?.frontmatterOk === true && noDesc.description === undefined, JSON.stringify(noDesc))

  // frontmatter 损坏
  installSkillIn(skillsDir, 'broken', '没有 frontmatter 的内容')
  const broken = listSkillsIn(skillsDir).find((s) => s.name === 'broken')
  check('frontmatter 损坏被识别', broken?.frontmatterOk === false, JSON.stringify(broken))

  // 重复安装 = 覆盖（编辑已有技能的正常路径），必须不抛错。
  let reinstallThrew = false
  try {
    installSkillIn(skillsDir, 'team-conventions', GOOD)
  } catch {
    reinstallThrew = true
  }
  check('重复安装同名技能是覆盖而非报错', !reinstallThrew)
  check('覆盖后仍只有一份', listSkillsIn(skillsDir).filter((s) => s.name === 'team-conventions').length === 1)

  expectThrows('安装空内容', () => installSkillIn(skillsDir, 'empty', '   '), 'EMPTY_SKILL_CONTENT')

  console.log('\n=== 4. 路径安全：非法名字不得写到目录外 ===')
  expectThrows('安装时用 ../ 逃逸', () => installSkillIn(skillsDir, '../escaped', GOOD), 'INVALID_SKILL_NAME')
  expectThrows('删除时用 ../../ 逃逸', () => removeSkillIn(skillsDir, '../../outside'), 'INVALID_SKILL_NAME')
  expectThrows('删除不存在的技能', () => removeSkillIn(skillsDir, 'nope'), 'SKILL_NOT_FOUND')

  const rootEntries = readdirSync(root)
  check(
    '根目录下没有出现逃逸产物',
    !rootEntries.includes('escaped') && rootEntries.every((e) => ['skills', 'outside'].includes(e)),
    JSON.stringify(rootEntries)
  )
  check('outside 目录未被写入', readdirSync(outside).length === 0, JSON.stringify(readdirSync(outside)))

  console.log('\n=== 5. 删除 ===')
  removeSkillIn(skillsDir, 'team-conventions')
  check('删除后列表里没有它', !listSkillsIn(skillsDir).some((s) => s.name === 'team-conventions'))
  check('目录也被清掉', !existsSync(join(skillsDir, 'team-conventions')))

  console.log('\n=== 6. 目录不存在时安全返回 ===')
  check('不存在的技能目录返回空数组', listSkillsIn(join(root, 'does-not-exist')).length === 0)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
