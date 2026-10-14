import type { Workspace } from '@i-pi-desk/shared'

/**
 * 「最近目录」这份列表的**规则**（纯函数，不碰 fs、不碰 electron）。
 *
 * 把它单独抽出来是因为这里面有一条**很容易被改坏、而后果是丢对话**的规则：
 *
 * ## 目录的身份是**路径**，不是 id
 *
 * 会话用 `workspaceId` 关联目录。如果「打开同一个路径」每次都发一个新 id，
 * 那么「把目录从最近列表里移除、之后再加回来」就会让那个目录下的会话
 * **永远变成孤儿**：它们还在磁盘上，但界面再也找不到它们（界面上的一切都按当前
 * 工作区的 id 过滤）。曾经的实现就是这样的 —— 移除是 `splice`，重开是 `randomUUID()`。
 *
 * 所以规则是：**按路径复用同一条记录**（连同它的 id），「移除」只把它从可见列表里
 * **藏起来**，而不是删掉。于是：
 *
 *  - 最近列表保持干净（藏起来的不会再出现、也不会被误点）；
 *  - 重新打开同一路径时 id 不变，那个目录下的会话原样回来；
 *  - 磁盘上的对话记录一条都不会因为「整理列表」这种动作而失去入口。
 */

/** 按路径查（大小写不敏感：Windows 与 macOS 的常见文件系统都不区分大小写）。 */
export function findByPath(list: Workspace[], path: string): Workspace | undefined {
  const target = path.toLowerCase()
  return list.find((workspace) => workspace.path.toLowerCase() === target)
}

/** 用户可见的那部分：排掉藏起来的，并按最近打开倒序。 */
export function visibleWorkspaces(list: Workspace[]): Workspace[] {
  return list
    .filter((workspace) => !workspace.hidden)
    .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))
}

export interface UpsertInput {
  /** 已经 `resolve()` 过的绝对路径。 */
  path: string
  /** 显示名（通常是 basename）。 */
  name: string
  /** 当前时间（注入，便于测试）。 */
  now: string
  /** 新记录要用的 id（注入 `randomUUID`，便于测试）。 */
  newId: string
}

export interface UpsertResult {
  /** 更新后的**整份**列表（包含藏起来的那些）。 */
  list: Workspace[]
  /** 这一条记录（新旧都有可能）。 */
  workspace: Workspace
  created: boolean
  /** 这条记录之前是藏着的、这次被重新打开了。 */
  restored: boolean
}

/**
 * 打开一个路径：有记录就复用（连同 id），没有就新建。
 *
 * 复用的时候只做两件事：把它**取消隐藏**（重新打开就是「我又要用它了」）、
 * 刷新 `lastOpenedAt`（列表按它倒序）。
 *
 * ## 刻意**不**刷新 `name`
 *
 * 名字是这条记录的元数据，而「打开」这个动作不该改写它不拥有的东西。
 * 这条不是我推出来的 —— 第一版顺手写了 `existing.name = input.name`，
 * 立刻把自测里预置的工作区名改了（夹具预置的是 `e2e-fixture`，一重开就变成目录的
 * basename），4 条「当前还在原工作区」的断言一起变红。
 * 现实里对应的后果是：用户给目录起的名字会在某次重新打开时被悄悄改掉。
 *
 * 大小写按不敏感处理 —— 否则在 Windows 上「同一个目录两种写法」会变成两条记录，
 * 也就是同一个目录下的会话被劈成两半。
 */
export function upsertWorkspace(list: Workspace[], input: UpsertInput): UpsertResult {
  const existing = findByPath(list, input.path)

  if (existing) {
    const restored = Boolean(existing.hidden)
    existing.hidden = false
    existing.lastOpenedAt = input.now
    return { list: [...list], workspace: existing, created: false, restored }
  }

  const workspace: Workspace = {
    id: input.newId,
    name: input.name,
    path: input.path,
    createdAt: input.now,
    lastOpenedAt: input.now
  }
  return { list: [...list, workspace], workspace, created: true, restored: false }
}

/**
 * 把一条记录从可见列表里藏起来。
 *
 * **不删记录**：删掉就丢了 id→路径的对应关系，那个目录下的会话会变成孤儿
 * （见文件头的说明）。「从列表移除」是整理列表的动作，不该有丢数据的后果。
 *
 * 返回是否真的改动了什么（id 不存在时返回 false，调用方据此报错）。
 */
export function hideWorkspace(list: Workspace[], id: string): { list: Workspace[]; changed: boolean } {
  const index = list.findIndex((workspace) => workspace.id === id)
  if (index === -1) return { list, changed: false }
  const next = [...list]
  next[index] = { ...next[index], hidden: true }
  return { list: next, changed: true }
}
