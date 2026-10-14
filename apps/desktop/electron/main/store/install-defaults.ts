import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * 安装预置（打包资源旁的 `install-defaults.json`）。
 *
 * 企业包可在打安装包前写入默认工作空间路径，例如：
 * `{ "defaultWorkspacePath": "D:\\\\work\\\\code\\\\shudao\\\\a3-lib" }`
 *
 * 仅在用户设置里尚未指定 `defaultWorkspacePath` 时合并一次，不覆盖人工配置。
 */
export interface InstallDefaults {
  defaultWorkspacePath?: string
}

export function readInstallDefaults(): InstallDefaults {
  const candidates = [
    join(process.resourcesPath, 'install-defaults.json'),
    join(app.getAppPath(), 'install-defaults.json'),
    join(app.getPath('exe'), '..', 'install-defaults.json')
  ]
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue
      const raw = JSON.parse(readFileSync(file, 'utf8')) as InstallDefaults
      if (raw && typeof raw === 'object') return raw
    } catch {
      // 坏文件忽略，别挡启动
    }
  }
  return {}
}
