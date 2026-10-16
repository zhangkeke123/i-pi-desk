import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, shell } from 'electron'
import type { UpdateStatus } from '@i-pi-desk/shared'
import { log } from './logger.js'
import { isPortableExecutable, resolveUpdateMode, usableFeedUrl } from './update-policy.js'

type UpdaterLike = {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
  on: (event: string, listener: (...args: unknown[]) => void) => void
  setFeedURL: (
    options: { provider: 'github'; owner: string; repo: string } | { provider: 'generic'; url: string }
  ) => void
  checkForUpdates: () => Promise<{ updateInfo?: { version?: string }; isUpdateAvailable?: boolean } | null>
  downloadUpdate: () => Promise<unknown>
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void
}

const RELEASES_PAGE = 'https://github.com/zhangkeke123/i-pi-desk/releases/latest'
const GITHUB_FEED = { provider: 'github' as const, owner: 'zhangkeke123', repo: 'i-pi-desk' }

export class AppUpdater {
  private state: UpdateStatus
  private updater: UpdaterLike | null = null
  private listenersReady = false
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly emit: (status: UpdateStatus) => void) {
    const mode = resolveUpdateMode({
      isPackaged: app.isPackaged,
      platform: process.platform,
      portable: isPortableExecutable()
    })
    this.state = {
      mode,
      phase: mode === 'disabled' ? 'disabled' : 'idle',
      currentVersion: app.getVersion(),
      message:
        mode === 'disabled'
          ? '开发模式不检查更新'
          : mode === 'notify'
            ? '便携版请到发布页下载新的 exe'
            : '安装版从 GitHub Releases 检查更新'
    }
  }

  status(): UpdateStatus {
    return this.state
  }

  start(): void {
    if (this.state.mode !== 'in-app') return
    this.timer = setTimeout(() => {
      void this.check()
    }, 15_000)
  }

  async check(): Promise<UpdateStatus> {
    if (this.state.mode === 'notify') {
      this.patch({ phase: 'notify', url: RELEASES_PAGE, message: '便携版不能在应用内替换，请下载新的 exe' })
      return this.state
    }
    if (this.state.mode !== 'in-app') return this.state
    this.patch({ phase: 'checking', message: '正在检查更新…' })
    try {
      const updater = await this.ensure()
      const result = await updater.checkForUpdates()
      const version = result?.updateInfo?.version
      if (!version || result?.isUpdateAvailable === false) {
        this.patch({ phase: 'idle', message: '已是最新版本', latestVersion: undefined })
        return this.state
      }
      this.patch({ phase: 'downloading', latestVersion: version, message: `正在下载 ${version}` })
      await updater.downloadUpdate()
      this.patch({ phase: 'ready', latestVersion: version, message: `${version} 已下载，重启后安装` })
    } catch (error) {
      this.patch({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
    }
    return this.state
  }

  async openPage(): Promise<UpdateStatus> {
    const url = this.state.url ?? RELEASES_PAGE
    await shell.openExternal(url)
    this.patch({ url, message: '已打开发布页' })
    return this.state
  }

  install(): UpdateStatus {
    if (this.state.phase !== 'ready' || !this.updater) {
      this.patch({ phase: this.state.phase, message: '还没有已下载的更新' })
      return this.state
    }
    this.updater.quitAndInstall(false, true)
    return this.state
  }

  private async ensure(): Promise<UpdaterLike> {
    if (this.updater) return this.updater
    const imported = (await import('electron-updater')) as { autoUpdater?: UpdaterLike; default?: { autoUpdater: UpdaterLike } }
    const updater = imported.autoUpdater ?? imported.default?.autoUpdater
    if (!updater) throw new Error('electron-updater 未导出 autoUpdater')
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.logger = {
      info: (...args) => log(`[update] ${args.map(String).join(' ')}`),
      warn: (...args) => log(`[update] ${args.map(String).join(' ')}`),
      error: (...args) => log(`[update] ${args.map(String).join(' ')}`)
    }
    const override = feedUrl()
    updater.setFeedURL(override ? { provider: 'generic', url: override } : GITHUB_FEED)
    if (!this.listenersReady) {
      updater.on('download-progress', (progress: unknown) => {
        const percent = typeof progress === 'object' && progress && 'percent' in progress ? Number((progress as { percent: number }).percent) : NaN
        if (Number.isFinite(percent)) {
          this.patch({ phase: 'downloading', message: `正在下载 ${Math.round(percent)}%` })
        }
      })
      this.listenersReady = true
    }
    this.updater = updater
    return updater
  }

  private patch(next: Partial<UpdateStatus>): void {
    this.state = { ...this.state, ...next }
    this.emit(this.state)
  }
}

function feedUrl(): string | null {
  const fromEnv = usableFeedUrl(process.env.IPI_UPDATE_URL)
  if (fromEnv) return fromEnv
  try {
    const file = join(process.resourcesPath, 'update-feed.json')
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { url?: string }
    return usableFeedUrl(parsed.url)
  } catch {
    return null
  }
}
