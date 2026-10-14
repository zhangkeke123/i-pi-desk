import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginPermission, PluginView } from '@i-pi-desk/shared'
import { validatePluginManifest } from '@i-pi-desk/shared'
import { getAppPaths } from '../paths.js'
import { readJson, writeJsonAtomic } from './json-store.js'

/**
 * 插件的文件管理（安装 / 列出 / 删除 / 启停）。
 *
 * ## 默认不启用
 *
 * 安装后 `enabled: false`，必须由用户显式启用。这不是多余的摩擦：
 * 插件是**任意代码**，而 `permissions` 是我们唯一的知情同意载体
 * （见 shared/plugin.ts）。如果装完就自动跑起来，那份权限声明就从来没被谁看过。
 * 「启用」这个动作就是同意发生的地方。
 *
 * ## 为什么安装是「复制整个目录」
 *
 * 插件可以带脚本、模板、技能目录。只复制入口文件会让它在运行时找不到自己的资源，
 * 而那种失败发生在运行时、离安装动作很远，很难排查。
 */

/** 启停状态单独存；manifest 归插件自己，我们不改它。 */
interface PluginStateFile {
  enabled: Record<string, boolean>
}

export class PluginStoreError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'PluginStoreError'
    this.code = code
  }
}

export function pluginsDir(): string {
  const dir = join(getAppPaths().userData, 'plugins')
  mkdirSync(dir, { recursive: true })
  return dir
}

function stateFile(): string {
  return join(getAppPaths().userData, 'plugins.json')
}

function readState(): PluginStateFile {
  const state = readJson<PluginStateFile>(stateFile(), { enabled: {} })
  return { enabled: isPlainRecord(state.enabled) ? state.enabled : {} }
}

function isPlainRecord(value: unknown): value is Record<string, boolean> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function writeEnabled(enabled: Record<string, boolean>): void {
  writeJsonAtomic(stateFile(), { enabled })
}

/**
 * 读一个插件目录的 manifest 并校验。
 *
 * 校验失败**不抛错**而是返回 `loadError`：列表里要能看到「这个插件有问题、原因是什么」，
 * 而不是整个插件面板因为一个坏插件打不开。
 */
function readManifestView(dir: string, enabled: boolean): PluginView | null {
  const manifestPath = join(dir, 'manifest.json')
  const fallbackId = dir.split(/[\\/]/).pop() ?? dir

  if (!existsSync(manifestPath)) {
    return {
      id: fallbackId,
      name: fallbackId,
      version: '—',
      dir,
      enabled: false,
      permissions: [],
      tools: [],
      skillDirs: [],
      loadError: '缺少 manifest.json'
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    return {
      id: fallbackId,
      name: fallbackId,
      version: '—',
      dir,
      enabled: false,
      permissions: [],
      tools: [],
      skillDirs: [],
      loadError: `manifest.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`
    }
  }

  const validation = validatePluginManifest(parsed)
  if (!validation.ok) {
    return {
      id: fallbackId,
      name: fallbackId,
      version: '—',
      dir,
      enabled: false,
      permissions: [],
      tools: [],
      skillDirs: [],
      loadError: validation.errors.map((item) => `${item.path || '(root)'}: ${item.message}`).join('；')
    }
  }

  const manifest = validation.manifest
  const view: PluginView = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    dir,
    // 校验不过的插件永远视为未启用 —— 免得 UI 显示「已启用」但它其实跑不起来。
    enabled,
    permissions: (manifest.permissions ?? []) as PluginPermission[],
    tools: (manifest.contributes?.agentTools ?? []).map((tool) => tool.name),
    skillDirs: manifest.contributes?.skills ?? []
  }
  if (manifest.description) view.description = manifest.description
  if (manifest.author) view.author = manifest.author
  return view
}

export function listPlugins(): PluginView[] {
  const dir = pluginsDir()
  const enabled = readState().enabled
  const views: PluginView[] = []

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const view = readManifestView(join(dir, entry.name), enabled[entry.name] === true)
    if (view) views.push(view)
  }

  return views.sort((a, b) => a.id.localeCompare(b.id))
}

/** 取「已启用且 manifest 合法」的插件，交给 sidecar 去加载。 */
export function enabledPlugins(): Array<{ id: string; dir: string }> {
  return listPlugins()
    .filter((plugin) => plugin.enabled && !plugin.loadError)
    .map((plugin) => ({ id: plugin.id, dir: plugin.dir }))
}

/**
 * 从任意目录安装一个插件（复制到应用数据目录）。
 *
 * 先校验源目录的 manifest 再复制：把一个坏插件拷进来再报错，会让用户以为
 * 「装了一半」，而且留下一个需要手动清理的残留目录。
 */
export function installPluginFrom(sourceDir: string): PluginView {
  const manifestPath = join(sourceDir, 'manifest.json')
  if (!existsSync(manifestPath)) {
    throw new PluginStoreError('INVALID_PLUGIN', `源目录里没有 manifest.json：${sourceDir}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new PluginStoreError(
      'INVALID_PLUGIN',
      `manifest.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`
    )
  }

  const validation = validatePluginManifest(parsed)
  if (!validation.ok) {
    throw new PluginStoreError(
      'INVALID_PLUGIN',
      `manifest 校验失败：${validation.errors.map((item) => `${item.path || '(root)'}: ${item.message}`).join('；')}`
    )
  }

  const id = validation.manifest.id
  const target = join(pluginsDir(), id)
  if (existsSync(target)) {
    throw new PluginStoreError('ALREADY_INSTALLED', `插件已安装：${id}（请先删除再安装）`)
  }

  const entry = join(sourceDir, validation.manifest.main)
  if (!existsSync(entry)) {
    throw new PluginStoreError('MISSING_ENTRY', `入口文件不存在：${validation.manifest.main}`)
  }

  try {
    cpSync(sourceDir, target, { recursive: true })
  } catch (error) {
    // 复制失败时清掉半成品目录，不给用户留一个「装了一半」的插件。
    rmSync(target, { recursive: true, force: true })
    throw new PluginStoreError('COPY_FAILED', `复制插件失败：${error instanceof Error ? error.message : String(error)}`)
  }

  // 默认不启用（见文件头）。列表里重新读一遍，保证返回的就是磁盘上的真实状态。
  const view = readManifestView(target, false)
  if (!view) throw new PluginStoreError('INTERNAL', '安装后读取插件失败')
  return view
}

export function removePlugin(id: string): { id: string } {
  assertSafeId(id)
  const target = join(pluginsDir(), id)
  if (!existsSync(target)) {
    throw new PluginStoreError('PLUGIN_NOT_FOUND', `插件不存在：${id}`)
  }
  rmSync(target, { recursive: true, force: true })

  const enabled = readState().enabled
  delete enabled[id]
  writeEnabled(enabled)
  return { id }
}

export function setPluginEnabled(id: string, enabled: boolean): PluginView {
  assertSafeId(id)
  const target = join(pluginsDir(), id)
  if (!existsSync(target)) {
    throw new PluginStoreError('PLUGIN_NOT_FOUND', `插件不存在：${id}`)
  }

  const view = readManifestView(target, enabled)
  if (!view) throw new PluginStoreError('INTERNAL', '读取插件失败')
  if (enabled && view.loadError) {
    // 不让用户启用一个明显跑不起来的插件 —— 否则他会以为启用了，实际什么都没发生。
    throw new PluginStoreError('INVALID_PLUGIN', `插件存在问题，无法启用：${view.loadError}`)
  }

  const state = readState().enabled
  state[id] = enabled
  writeEnabled(state)
  return view
}

/**
 * 目录名（= 安装时的 id）的合法性。
 *
 * 与 manifest 校验里的 id 规则一致。这里再查一次是因为**目录名来自我们自己的调用方**，
 * 而 `removePlugin('../x')` 会删掉插件目录之外的东西 —— 路径校验不能只依赖「上游已经查过」。
 */
function assertSafeId(id: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(id) || id.length > 64) {
    throw new PluginStoreError('INVALID_PLUGIN_ID', `非法的插件 id：${id}`)
  }
}
