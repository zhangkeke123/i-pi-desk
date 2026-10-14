/**
 * 「最近目录」这份列表的规则自测（纯函数，不碰 electron）。
 *
 * 这里最要紧的一条是：**按路径复用同一个 id**。
 * 会话用 `workspaceId` 关联目录，而「移除」只把记录藏起来 ——
 * 于是「移除一个目录、之后再加回来」不会让那个目录下的对话变成孤儿。
 * 曾经的实现是「移除即 splice、重开即 randomUUID」，那条路径会**丢对话入口**，
 * 而它的表现是「会话莫名其妙不见了」，很难联想到是整理列表造成的。
 *
 * 用法：node --experimental-strip-types scripts/verify-workspace-list.ts
 */
import type { Workspace } from '@i-pi-desk/shared'
import { findByPath, hideWorkspace, upsertWorkspace, visibleWorkspaces } from '../electron/main/store/workspace-list.ts'

let failures = 0
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

function workspace(id: string, path: string, at: string, hidden = false): Workspace {
  return {
    id,
    name: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
    path,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastOpenedAt: at,
    ...(hidden ? { hidden: true } : {})
  }
}

const WINDOWS_PATH = 'C:\\work\\demo'
const list: Workspace[] = [
  workspace('id-a', WINDOWS_PATH, '2026-02-02T00:00:00.000Z'),
  workspace('id-b', 'C:\\work\\other', '2026-02-03T00:00:00.000Z'),
  workspace('id-c', 'C:\\work\\hidden-dir', '2026-02-04T00:00:00.000Z', true)
]

console.log('── 可见列表 ──')
const visible = visibleWorkspaces(list)
check('藏起来的不出现在可见列表里', !visible.some((w) => w.id === 'id-c'), JSON.stringify(visible.map((w) => w.id)))
check('按最近打开倒序', JSON.stringify(visible.map((w) => w.id)) === JSON.stringify(['id-b', 'id-a']), JSON.stringify(visible.map((w) => w.id)))
check('不修改传入的数组（纯函数）', list.length === 3 && list[0].id === 'id-a', JSON.stringify(list.map((w) => w.id)))

console.log('\n── 按路径查 ──')
check('路径命中', findByPath(list, WINDOWS_PATH)?.id === 'id-a')
check(
  '大小写不敏感（否则 Windows 上同一目录会变成两条记录、把会话劈成两半）',
  findByPath(list, 'c:\\WORK\\DEMO')?.id === 'id-a',
  String(findByPath(list, 'c:\\WORK\\DEMO')?.id)
)
check('不存在的路径返回 undefined', findByPath(list, 'C:\\work\\nope') === undefined)

console.log('\n── 打开：新路径 ──')
const created = upsertWorkspace(list, {
  path: 'C:\\work\\fresh',
  name: 'fresh',
  now: '2026-03-01T00:00:00.000Z',
  newId: 'id-new'
})
check('新路径会新建一条记录', created.created === true && created.workspace.id === 'id-new', JSON.stringify(created.workspace))
check('新记录出现在列表里', created.list.some((w) => w.id === 'id-new'))
check('原来那些记录一条不少', created.list.length === list.length + 1, String(created.list.length))
check('新记录不是「恢复」的', created.restored === false)

console.log('\n── 打开：已存在的路径（关键规则）──')
const reopened = upsertWorkspace(list, {
  path: WINDOWS_PATH,
  name: 'demo',
  now: '2026-03-02T00:00:00.000Z',
  newId: 'id-must-not-be-used'
})
check('**复用同一个 id**（会话才不会变成孤儿）', reopened.workspace.id === 'id-a', reopened.workspace.id)
check('没有新建记录', reopened.created === false && reopened.list.length === list.length, String(reopened.list.length))
check('刷新了 lastOpenedAt', reopened.workspace.lastOpenedAt === '2026-03-02T00:00:00.000Z', reopened.workspace.lastOpenedAt)
/**
 * 打开**不覆盖**已有的显示名。
 *
 * 这一条是补上来的：第一版顺手写了 `existing.name = input.name`，
 * 结果把自测里预置的工作区名改了（预置的是 `e2e-fixture`，一重开就变成目录 basename），
 * 4 条「当前还在原工作区」的断言一起变红。现实里对应的后果是
 * 「用户给目录起的名字会在某次重新打开时被悄悄改掉」。
 */
const renamed = upsertWorkspace(list, { path: WINDOWS_PATH, name: '我给它起的名字', now: 'x', newId: 'nope' })
check('打开时**不改写已有的显示名**（名字是记录的元数据）', renamed.workspace.name === 'demo', renamed.workspace.name)
check('大小写不同也复用同一条', upsertWorkspace(list, { path: 'c:\\WORK\\demo', name: 'demo', now: 'x', newId: 'nope' }).workspace.id === 'id-a')

console.log('\n── 隐藏 → 重新打开（这就是「移除再加回来」）──')
const hidden = hideWorkspace(list, 'id-a')
check('隐藏成功', hidden.changed === true)
check('隐藏后不可见', !visibleWorkspaces(hidden.list).some((w) => w.id === 'id-a'))
check('但记录还在（id→路径 的对应关系没丢）', hidden.list.some((w) => w.id === 'id-a'))
check('隐藏一条不存在的 id 时返回 changed=false（调用方据此报错）', hideWorkspace(list, 'nope').changed === false)

const restored = upsertWorkspace(hidden.list, {
  path: WINDOWS_PATH,
  name: 'demo',
  now: '2026-04-01T00:00:00.000Z',
  newId: 'id-should-not-be-used'
})
check('重新打开时取消隐藏', restored.workspace.hidden === false && Boolean(restored.workspace.hidden) === false)
check('重新打开后**又是同一个 id**', restored.workspace.id === 'id-a', restored.workspace.id)
check('并标记为「恢复」（restored）', restored.restored === true)
check('恢复后重新出现在可见列表里', visibleWorkspaces(restored.list).some((w) => w.id === 'id-a'))

console.log('\n── 边界：隐藏不会影响别的记录 ──')
check('隐藏 A 之后 B 仍然可见', visibleWorkspaces(hidden.list).some((w) => w.id === 'id-b'))
check('隐藏 A 之后 A 的路径仍能被查到（会话解析 cwd 要用）', findByPath(hidden.list, WINDOWS_PATH)?.id === 'id-a')
check('重复隐藏同一条不会报错也不会重复', hideWorkspace(hideWorkspace(list, 'id-a').list, 'id-a').changed === true)

console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
