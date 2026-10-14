import { join, resolve } from 'node:path'
import { app } from 'electron'
import { userFile } from './store/json-store.js'

/** 所有落盘位置的唯一出口。别在业务代码里拼路径。 */

export interface AppPaths {
  userData: string
  settings: string
  secrets: string
  workspaces: string
  sessionsDir: string
  logsDir: string
}

export function getAppPaths(): AppPaths {
  const userData = app.getPath('userData')
  return {
    userData,
    settings: userFile(userData, 'settings.json'),
    secrets: userFile(userData, 'secrets.json'),
    workspaces: userFile(userData, 'workspaces.json'),
    sessionsDir: userFile(userData, 'sessions'),
    logsDir: userFile(userData, 'logs')
  }
}

/**
 * sidecar 入口文件的定位。
 *
 * dev：从 `apps/desktop` 上溯两级到仓库根，取 `packages/agent-host/dist/sidecar.js`。
 * 打包：electron-builder 把 `packages/agent-host/dist-bundle` 放进 extraResources/agent-host。
 */
export function resolveSidecarEntry(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'agent-host', 'sidecar.js')
  }
  const appPath = app.getAppPath()
  return resolve(appPath, '..', '..', 'packages', 'agent-host', 'dist', 'sidecar.js')
}
