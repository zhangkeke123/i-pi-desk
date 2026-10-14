import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InstalledSkill } from '@i-pi-desk/shared'

/**
 * 技能文件的**纯逻辑**：命名校验、frontmatter 宽松解析、按目录列出/安装/删除。
 *
 * 刻意不 import electron（`electron` 只出现在同目录的 skills.ts 里）：
 * 这样这一层可以在普通 Node 里被单测覆盖 —— 而它恰恰装着**路径安全**与
 * **名字规范**这两块最需要测试的逻辑。把环境和逻辑混在一个文件里，
 * 代价就是这些逻辑只能靠端到端测试碰运气。
 *
 * ## 关于 frontmatter 解析
 *
 * 这里只做**展示用途**的宽松解析。真正的判断（命名是否合法、description 是否缺失、
 * frontmatter 是否损坏）由内核做，结果通过 `agent.inspect` 回来。
 * 之所以不在主进程引 pi 来解析：架构上 pi 只允许出现在 agent-host 里，
 * 为了一个显示用的解析去破这条线不值得。
 */

/** 技能名规范（Agent Skills 规范）：小写字母/数字/连字符，≤64，首尾及连续连字符不允许。 */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_SKILL_NAME = 64
/** 与内核一致的上限：超大的 SKILL.md 内核不会加载，这里也不去解析它。 */
const MAX_SKILL_BYTES = 128 * 1024

export class SkillError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'SkillError'
    this.code = code
  }
}

/**
 * 校验技能名。
 *
 * 严格按规范来，而不是「随手 sanitize」：技能名既是模型看到的路由键，
 * 也是文件系统里的目录名。放宽它会同时带来两个问题 ——
 * 模型记不住模糊的名字，以及路径里出现奇怪字符。而且模糊的名字更容易撞名，
 * 内核撞名时保留先发现的，后来者静默失效。
 *
 * 顺带一个安全收益：通过校验的名字不可能含路径分隔符或 `..`，
 * 所以下面所有拼路径的地方都不需要再单独防越界。
 */
export function validateSkillName(name: string): void {
  if (!name || name.length > MAX_SKILL_NAME) {
    throw new SkillError('INVALID_SKILL_NAME', `技能名必须是 1-${MAX_SKILL_NAME} 个字符`)
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new SkillError(
      'INVALID_SKILL_NAME',
      `技能名只能用小写字母、数字和连字符，且不能以连字符开头/结尾或出现连续连字符：${name}`
    )
  }
}

/**
 * 宽松解析 frontmatter，只取 `name` 与 `description`。
 *
 * 支持 BOM（Windows 记事本存出来的文件带头）、带引号的值、注释行。
 * 找不到闭合的 `---` 块时返回 `ok: false` —— 内核会因此拒绝加载这个技能，
 * UI 需要把这件事显示出来，而不是替用户「猜」内容。
 */
export function parseSkillFrontmatter(content: string): {
  ok: boolean
  name?: string
  description?: string
} {
  const text = content.replace(/^\uFEFF/, '')
  const match = /^\s*---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text)
  if (!match) return { ok: false }

  const result: { ok: boolean; name?: string; description?: string } = { ok: true }
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator === -1) continue
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    if (key === 'name') result.name = value
    if (key === 'description') result.description = value
  }
  return result
}

function describeSkill(dir: string, name: string, filePath: string, content: string): InstalledSkill {
  const parsed = parseSkillFrontmatter(content)
  const skill: InstalledSkill = { name, filePath, frontmatterOk: parsed.ok }
  if (parsed.name !== undefined) skill.declaredName = parsed.name
  if (parsed.description !== undefined) skill.description = parsed.description
  return skill
}

/**
 * 列出某个技能根目录下的技能。
 *
 * 用**目录名**当 `name`（那也是内核 `/skill:<name>` 用的名字，以及撞名时用的键）。
 * frontmatter 里声明的名字单独放在 `declaredName` 里，供 UI 提示不一致 ——
 * 其它 Agent Skills 实现可能强制两者相同，所以这是个值得暴露的差异。
 */
export function listSkillsIn(dir: string): InstalledSkill[] {
  if (!existsSync(dir)) return []

  const skills: InstalledSkill[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const filePath = join(dir, entry.name, 'SKILL.md')
    if (!existsSync(filePath)) continue

    let content: string | null = null
    try {
      if (statSync(filePath).size <= MAX_SKILL_BYTES) content = readFileSync(filePath, 'utf8')
    } catch {
      content = null
    }
    skills.push(
      content === null
        ? { name: entry.name, filePath, frontmatterOk: false }
        : describeSkill(dir, entry.name, filePath, content)
    )
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 安装（或覆盖）一个技能。
 *
 * `content` 是完整的 SKILL.md 内容。这里**不替用户补 frontmatter**：
 * 自动生成的 description 一定是低质量的，而 description 恰恰决定模型会不会用这个技能。
 * 与其凑一句「Helps with X」，不如让用户写清楚。
 */
export function installSkillIn(dir: string, name: string, content: string): InstalledSkill {
  validateSkillName(name)
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new SkillError('EMPTY_SKILL_CONTENT', 'SKILL.md 内容不能为空')
  }
  const target = join(dir, name)
  mkdirSync(target, { recursive: true })
  const filePath = join(target, 'SKILL.md')
  writeFileSync(filePath, content, 'utf8')
  return describeSkill(dir, name, filePath, content)
}

export function removeSkillIn(dir: string, name: string): { name: string } {
  validateSkillName(name)
  const target = join(dir, name)
  if (!existsSync(target)) {
    throw new SkillError('SKILL_NOT_FOUND', `技能不存在: ${name}`)
  }
  // recursive 是必要的（技能可以带 scripts/ references/ assets/），
  // 安全性由前面的名字校验保证：name 里不可能含路径分隔符或 `..`。
  rmSync(target, { recursive: true, force: true })
  return { name }
}
