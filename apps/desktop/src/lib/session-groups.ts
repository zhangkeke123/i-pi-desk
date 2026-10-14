/**
 * 会话列表分组。
 *
 * ## 侧栏哲学（对齐 ZCode，我们只做「按项目」）
 *
 * 1. **临时会话** —— 落在默认工作空间、且未置顶的会话（快捷会话的落点）。
 * 2. **置顶** —— 跨项目扁平列表，按 `updatedAt` 倒序（最近改动在前）。
 * 3. **按项目** —— 其余会话按**项目（工作区）**折叠；项目可设色点。
 *    不做自定义分组：项目色就是唯一的组织维度。
 *
 * 时间桶（今天 / 昨天…）仍保留给需要「当前目录内按日」的旧路径，但主侧栏改走上面三段。
 */

import type { Session, SessionRunStatus, Workspace } from '@i-pi-desk/shared'

export type SessionBucket = 'today' | 'yesterday' | 'last7' | 'older'

/** 侧栏可选色板（项目 / 会话共用）。 */
export const SIDEBAR_COLORS = [
  '#c4a574',
  '#6b9b7a',
  '#7a8fb5',
  '#b57a8f',
  '#8f7ab5',
  '#a3a37a',
  '#b58f7a',
  '#7ab5a8'
] as const

export interface SidebarProjectGroup<T> {
  workspaceId: string
  name: string
  path: string
  color?: string
  items: T[]
}

export interface SessionSidebarSections<T> {
  temporary: T[]
  pinned: T[]
  projects: SidebarProjectGroup<T>[]
}

/**
 * 解析侧栏展示用状态：审批待确认视为异常；进行中优先于落盘 runStatus。
 */
export function resolveSessionStatus(
  session: Pick<Session, 'runStatus' | 'messageCount'>,
  opts: { busy?: boolean; awaitsApproval?: boolean } = {}
): SessionRunStatus {
  if (opts.awaitsApproval) return 'error'
  if (opts.busy) return 'running'
  if (session.runStatus) return session.runStatus
  if (session.messageCount === 0) return 'new'
  return 'done'
}

/** 侧栏 / 摘要条用的短状态文案。 */
export function sessionStatusLabel(status: SessionRunStatus): string {
  switch (status) {
    case 'new':
      return '新建'
    case 'running':
      return '进行中'
    case 'done':
      return '完成'
    case 'error':
      return '异常'
  }
}

/** 相对时间（ZCode 风格：`18天` / `8小时`，不加「前」）。 */
export function formatRelativeTime(updatedAt: string, now: Date = new Date()): string {
  const time = new Date(updatedAt).getTime()
  if (!Number.isFinite(time)) return ''
  const sec = Math.max(0, Math.floor((now.getTime() - time) / 1000))
  if (sec < 60) return '刚刚'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}分钟`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}小时`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}天`
  const month = Math.floor(day / 30)
  if (month < 12) return `${month}月`
  return `${Math.floor(month / 12)}年`
}

function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
}

/**
 * 构建侧栏三段分区。
 *
 * - `defaultWorkspacePath` 为空时不产生「临时」段（全部进项目组）。
 * - 置顶优先：默认工作区里的置顶只出现在「置顶」，不进「临时」。
 * - 项目组内按 updatedAt 倒序；组本身按组内最新会话倒序。
 */
export function buildSessionSidebarSections<
  T extends { workspaceId: string; pinned?: boolean; updatedAt: string }
>(
  sessions: readonly T[],
  workspaces: ReadonlyArray<Pick<Workspace, 'id' | 'name' | 'path' | 'color'>>,
  defaultWorkspacePath: string | undefined
): SessionSidebarSections<T> {
  const byId = new Map(workspaces.map((w) => [w.id, w]))
  const defaultWs = defaultWorkspacePath?.trim()
    ? workspaces.find((w) => samePath(w.path, defaultWorkspacePath.trim()))
    : undefined
  const defaultId = defaultWs?.id

  const temporary: T[] = []
  const pinned: T[] = []
  const rest: T[] = []

  for (const session of sessions) {
    /*
      工作区「从列表移除」只是隐藏记录、会话仍留在磁盘。
      若这里仍按 session.workspaceId 建项目组，移除后项目行会立刻被会话「顶」回来，
      看起来像移除没生效。所以：不在可见工作区列表里的会话，侧栏一律不展示。
      用户重新打开同一目录时会复用 id，会话会再出现。
    */
    if (!byId.has(session.workspaceId)) continue

    if (session.pinned === true) {
      pinned.push(session)
      continue
    }
    if (defaultId && session.workspaceId === defaultId) {
      temporary.push(session)
      continue
    }
    rest.push(session)
  }

  const byUpdatedDesc = (a: T, b: T) => b.updatedAt.localeCompare(a.updatedAt)
  temporary.sort(byUpdatedDesc)
  pinned.sort(byUpdatedDesc)

  const projectMap = new Map<string, T[]>()
  for (const session of rest) {
    const list = projectMap.get(session.workspaceId)
    if (list) list.push(session)
    else projectMap.set(session.workspaceId, [session])
  }

  const projects: SidebarProjectGroup<T>[] = [...projectMap.entries()].map(([workspaceId, items]) => {
    items.sort(byUpdatedDesc)
    const workspace = byId.get(workspaceId)
    return {
      workspaceId,
      name: workspace?.name ?? workspaceId.slice(0, 8),
      path: workspace?.path ?? '',
      color: workspace?.color,
      items
    }
  })
  projects.sort((a, b) => {
    const aTime = a.items[0]?.updatedAt ?? ''
    const bTime = b.items[0]?.updatedAt ?? ''
    return bTime.localeCompare(aTime)
  })

  return { temporary, pinned, projects }
}

export interface SessionGroup<T> {
  bucket: SessionBucket
  /** 分组标题（中文，与界面一致）。 */
  label: string
  items: T[]
}

const LABELS: Record<SessionBucket, string> = {
  today: '今天',
  yesterday: '昨天',
  last7: '近 7 天',
  older: '更早'
}

/** 取「当天 00:00」的时间戳，用来做日历日比较。 */
function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

export function bucketOf(updatedAt: string | number | Date, now: Date = new Date()): SessionBucket {
  const time = updatedAt instanceof Date ? updatedAt.getTime() : new Date(updatedAt).getTime()
  if (!Number.isFinite(time)) return 'older'

  const today = startOfDay(now)
  const day = startOfDay(new Date(time))
  const diffDays = Math.round((today - day) / 86_400_000)

  if (diffDays <= 0) return 'today'
  if (diffDays === 1) return 'yesterday'
  if (diffDays <= 6) return 'last7'
  return 'older'
}

/**
 * 按时间分组。
 *
 * 组内**保持传入顺序**（调用方已经按更新时间排过序），组本身也固定顺序 ——
 * 顺序固定比「智能排序」重要：每天打开时列表的形状应当一样。
 */
export function groupSessionsByTime<T extends { updatedAt: string }>(
  sessions: T[],
  now: Date = new Date()
): SessionGroup<T>[] {
  const buckets: SessionBucket[] = ['today', 'yesterday', 'last7', 'older']
  const map = new Map<SessionBucket, T[]>()
  for (const session of sessions) {
    const bucket = bucketOf(session.updatedAt, now)
    const list = map.get(bucket)
    if (list) list.push(session)
    else map.set(bucket, [session])
  }
  return buckets
    .filter((bucket) => (map.get(bucket)?.length ?? 0) > 0)
    .map((bucket) => ({ bucket, label: LABELS[bucket], items: map.get(bucket) ?? [] }))
}

/**
 * 把置顶的会话单独分出来。
 *
 * ## 两条约定（都有单测）
 *
 * 1. **置顶不改变组内顺序** —— 分组仍然按 updatedAt 倒序，置顶只是「单独放一组」。
 *    如果为了置顶去改 updatedAt，用户会看到「刚置顶，它就跑到今天那组最上面」，
 *    而时间显示还是旧的 —— 那种自相矛盾比不置顶更糟。
 * 2. **相对顺序稳定** —— 传入的顺序原样保留，不做二次排序。
 */
export function splitPinned<T extends { pinned?: boolean }>(sessions: readonly T[]): {
  pinned: T[]
  rest: T[]
} {
  const pinned: T[] = []
  const rest: T[] = []
  for (const session of sessions) {
    if (session.pinned === true) pinned.push(session)
    else rest.push(session)
  }
  return { pinned, rest }
}

/**
 * 「项目」分组：别的目录里、**确实有会话**的目录。
 *
 * ## 为什么从会话聚合，而不是从目录列表过滤
 *
 * 第一版是「遍历应用已知的工作目录，数每个目录有几个会话」。端到端里一行都没渲染出来，
 * 而同一时刻「其它目录还有 1 个会话」这句提示是有的 —— 说明**会话数据是全的、目录列表不全**：
 * 一个目录可能已经被「从最近目录移除」，但它下面的会话还在。
 * 从会话出发，这种目录也能被列出来（名字查不到就退回 id 前缀，宁可难看也不要凭空消失）。
 *
 * ## 为什么打开时宁可不动
 *
 * 行能点，靠的是拿到目录 path 再切过去。查不到 path 就**不切** ——
 * 「界面切了、agent 还在老目录」比少一个入口糟得多。
 */
export interface ProjectGroup {
  id: string
  name: string
  path: string
  count: number
}

export function otherProjects(
  workspaces: ReadonlyArray<{ id: string; name: string; path: string }>,
  sessions: ReadonlyArray<{ workspaceId: string }>,
  currentWorkspaceId: string | undefined
): ProjectGroup[] {
  const counts = new Map<string, number>()
  for (const session of sessions) {
    if (session.workspaceId === currentWorkspaceId) continue
    counts.set(session.workspaceId, (counts.get(session.workspaceId) ?? 0) + 1)
  }
  return [...counts.entries()].map(([id, count]) => {
    const workspace = workspaces.find((w) => w.id === id)
    return { id, count, name: workspace?.name ?? id.slice(0, 8), path: workspace?.path ?? '' }
  })
}
