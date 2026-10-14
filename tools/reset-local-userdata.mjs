/**
 * 清掉本机被 E2E/截图夹具污染的设置与工作区，改成可用的 a3-lib。
 * 用法：node tools/reset-local-userdata.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from node:crypto'

const userData = process.env.APPDATA
  ? join(process.env.APPDATA, 'i-pi-desk')
  : join(process.env.HOME ?? '', '.config', 'i-pi-desk')

const a3lib = 'D:\\work\\code\\shudao\\a3-lib'
const now = new Date().toISOString()

mkdirSync(userData, { recursive: true })

const settingsPath = join(userData, 'settings.json')
const workspacesPath = join(userData, 'workspaces.json')

const settings = {
  app: {
    theme: 'midnight',
    locale: 'zh-CN',
    permissionMode: 'ask',
    maxSteps: 40,
    thinkingLevel: 'medium'
  },
  providers: []
}
writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8')

let list = []
if (existsSync(workspacesPath)) {
  try {
    list = JSON.parse(readFileSync(workspacesPath, 'utf8'))
  } catch {
    list = []
  }
}
if (!Array.isArray(list)) list = []

for (const item of list) {
  const path = String(item?.path ?? '')
  if (/[\\/]Temp[\\/]/i.test(path) || /fixture/i.test(path) || /ipi-/i.test(String(item?.name ?? ''))) {
    item.hidden = true
  }
}

const existing = list.find((w) => String(w.path).toLowerCase() === a3lib.toLowerCase())
if (existing) {
  existing.hidden = false
  existing.lastOpenedAt = now
  existing.name = existing.name || 'a3-lib'
} else {
  list.unshift({
    id: randomUUID(),
    name: 'a3-lib',
    path: a3lib,
    createdAt: now,
    lastOpenedAt: now,
    hidden: false
  })
}

writeFileSync(workspacesPath, JSON.stringify(list, null, 2), 'utf8')
console.log('reset ok')
console.log('  settings:', settingsPath)
console.log('  workspaces: a3-lib visible; fixtures hidden')
