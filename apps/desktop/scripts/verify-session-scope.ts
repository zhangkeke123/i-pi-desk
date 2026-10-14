/**
 * 「会话按工作目录过滤」的规则自测（纯函数，不启动 Electron）。
 *
 * 这些规则守的是一个**会把活干错目录**的缺陷：跑一轮用的是会话自带的 cwd，
 * 所以选错会话 = agent 在另一个目录里干活，而界面显示的是当前目录。
 *
 * 用法：node --experimental-strip-types scripts/verify-session-scope.ts
 */
import type { Session } from '@i-pi-desk/shared'
import { pickActiveSession, sessionsInWorkspace } from '../src/lib/session-scope.ts'

let failures = 0
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

/** 造一个会话。`at` 同时当 updatedAt，用来表达「最近更新在前」的排序。 */
function session(id: string, workspaceId: string, at: string): Session {
  return {
    id,
    workspaceId,
    title: `会话 ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: at,
    messageCount: 0
  }
}

const list: Session[] = [
  session('b-newest', 'B', '2026-02-03T00:00:00.000Z'),
  session('a-mid', 'A', '2026-02-02T00:00:00.000Z'),
  session('b-older', 'B', '2026-02-01T00:00:00.000Z'),
  session('c-only', 'C', '2026-01-31T00:00:00.000Z'),
  session('a-oldest', 'A', '2026-01-30T00:00:00.000Z')
]

console.log('── 按工作区过滤 ──')
const forB = sessionsInWorkspace(list, 'B')
check('只留下 B 的会话', forB.length === 2 && forB.every((s) => s.workspaceId === 'B'), JSON.stringify(forB.map((s) => s.id)))
check(
  '保持原有顺序（最近更新在前）',
  JSON.stringify(forB.map((s) => s.id)) === JSON.stringify(['b-newest', 'b-older']),
  JSON.stringify(forB.map((s) => s.id))
)
const forA = sessionsInWorkspace(list, 'A')
check('A 的两条都在，且没混进别的工作区', forA.length === 2 && forA.every((s) => s.workspaceId === 'A'), JSON.stringify(forA.map((s) => s.id)))
const forC = sessionsInWorkspace(list, 'C')
check('C 只有一条', forC.length === 1 && forC[0].id === 'c-only', JSON.stringify(forC.map((s) => s.id)))

console.log('\n── 对照组：过滤不能太狠（否则「会话不见了」会变成另一个 bug）──')
check('全部会话都属于该工作区时，一条不少', sessionsInWorkspace(list, 'B').length + sessionsInWorkspace(list, 'A').length + sessionsInWorkspace(list, 'C').length === list.length, String(list.length))
check('不修改传入的数组（纯函数）', list.length === 5 && list[0].id === 'b-newest', JSON.stringify(list.map((s) => s.id)))

console.log('\n── 边界：没有当前工作区时谁也不该被选中 ──')
check('workspaceId 为 undefined 时返回空', sessionsInWorkspace(list, undefined).length === 0)
check('workspaceId 为空串时返回空', sessionsInWorkspace(list, '').length === 0)
check('未知工作区返回空（而不是退回全量）', sessionsInWorkspace(list, 'D').length === 0)
check(
  '会话自身的 workspaceId 为空时不会被 undefined 选中（避免 NaN 式的意外匹配）',
  sessionsInWorkspace([session('x', '', '2026-02-04T00:00:00.000Z')], undefined).length === 0
)

console.log('\n── 挑「当前会话」──')
check('选的是本工作区里最近更新的那个', pickActiveSession(list, 'B')?.id === 'b-newest', String(pickActiveSession(list, 'B')?.id))
check('A 里选的是 a-mid（虽然它比 B 的旧）', pickActiveSession(list, 'A')?.id === 'a-mid', String(pickActiveSession(list, 'A')?.id))
check('该工作区没有会话时返回 undefined（调用方据此清空选中）', pickActiveSession(list, 'D') === undefined)
check('没有工作区时返回 undefined', pickActiveSession(list, undefined) === undefined)
check('空列表返回 undefined', pickActiveSession([], 'A') === undefined)

console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
