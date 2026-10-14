import { shell } from 'electron'
import { IPC, type InstalledSkill } from '@i-pi-desk/shared'
import { installSkill, listInstalledSkills, removeSkill, skillsDir } from '../store/skills.js'
import { arg, handle, requireString } from './wrap.js'

/**
 * 技能管理 IPC（磁盘视角：安装 / 删除 / 列出 / 打开目录）。
 *
 * 「哪些技能真正生效」不在这里回答 —— 那要问内核（`desk:agent/inspect`）。
 * 两者分开是因为它们回答的是不同问题，混在一起会让 UI 无法指出
 * 「文件在、但内核没加载」这种情况。
 */
export function registerSkillsIpc(): void {
  handle<InstalledSkill[]>(IPC.invoke.skillsList, () => listInstalledSkills())

  handle<InstalledSkill>(IPC.invoke.skillsInstall, (_event, ...args) => {
    const input = arg<{ name: string; content: string }>(args, 0)
    const name = requireString(input?.name, 'name')
    const content = requireString(input?.content, 'content')
    // 名字校验在 store 里（validateSkillName），错误码 INVALID_SKILL_NAME 会原样到 UI。
    return installSkill(name, content)
  })

  handle<{ name: string }>(IPC.invoke.skillsRemove, (_event, ...args) =>
    removeSkill(requireString(args[0], 'name'))
  )

  handle<{ path: string }>(IPC.invoke.skillsOpenDir, async () => {
    const dir = skillsDir()
    // openPath 返回的是错误字符串（不是抛异常）。目录刚被 ensure 过，正常不会失败；
    // 真失败也当作已打开处理 —— 用户能自己去看路径。
    await shell.openPath(dir)
    return { path: dir }
  })
}
