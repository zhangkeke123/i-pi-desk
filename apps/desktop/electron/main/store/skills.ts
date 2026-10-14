import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { InstalledSkill } from '@i-pi-desk/shared'
import { piAgentDir } from './pi-config.js'
import {
  installSkillIn,
  listSkillsIn,
  removeSkillIn,
  SkillError,
  validateSkillName
} from './skill-files.js'

/**
 * 技能的文件管理：把纯逻辑（skill-files.ts）绑到应用自己的 agent 目录上。
 *
 * ## 为什么技能放在 agent 目录下
 *
 * pi 会自动扫描 `<agentDir>/skills/**\/SKILL.md`，而我们的 agentDir 已经被重定向到
 * `<userData>/pi-agent`。所以**主进程只要往那个目录写文件，内核下次建会话就会发现它** ——
 * 不需要任何 RPC 去「注册」技能。少一条链路就少一处不一致的可能。
 *
 * 技能名相关的错误统一用 `INVALID_SKILL_NAME` / `SKILL_NOT_FOUND` 等错误码返回，
 * UI 据此区分「名字写错了」和「技能不存在」，而不是给一句笼统的失败提示。
 */

export function skillsDir(): string {
  const dir = join(piAgentDir(), 'skills')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function listInstalledSkills(): InstalledSkill[] {
  return listSkillsIn(skillsDir())
}

export function installSkill(name: string, content: string): InstalledSkill {
  return installSkillIn(skillsDir(), name, content)
}

export function removeSkill(name: string): { name: string } {
  return removeSkillIn(skillsDir(), name)
}

export { SkillError, validateSkillName }
