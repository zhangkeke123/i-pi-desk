import type { Workspace } from '@i-pi-desk/shared'

/** Temp / *fixture* 是 E2E 与截图夹具，不该在日常启动时抢成当前工作区。 */
export function isFixtureWorkspace(workspace: Workspace): boolean {
  const path = workspace.path.replace(/\//g, '\\').toLowerCase()
  const name = (workspace.name ?? '').toLowerCase()
  if (path.includes('\\temp\\') || path.includes('/temp/')) return true
  if (name.includes('fixture') || name.startsWith('ipi-')) return true
  return false
}

/** Windows 路径大小写与分隔符不敏感。 */
export function sameWorkspacePath(a: string, b: string): boolean {
  const norm = (p: string): string =>
    p
      .replace(/\//g, '\\')
      .replace(/[\\/]+$/, '')
      .toLowerCase()
  return norm(a) === norm(b)
}

/**
 * 启动时选当前工作区：默认工作空间路径优先，其次非夹具最近项。
 * `workspaces` 已按 lastOpenedAt 倒序。
 */
export function pickBootWorkspace(
  workspaces: Workspace[],
  defaultWorkspacePath?: string
): Workspace | undefined {
  const preferred = defaultWorkspacePath?.trim()
  if (preferred) {
    const match = workspaces.find(
      (w) => !isFixtureWorkspace(w) && sameWorkspacePath(w.path, preferred)
    )
    if (match) return match
  }
  const real = workspaces.find((w) => !isFixtureWorkspace(w))
  return real ?? workspaces[0]
}
