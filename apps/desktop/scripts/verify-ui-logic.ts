/**
 * 界面纯逻辑的单测（不启动窗口）。
 *
 * 这三块之所以抽成纯函数，是因为它们的**边界**最容易错、又最不值得为它跑端到端：
 * 时间分组的日历日边界、工具调用翻译成人话的措辞、倒计时的显示格式。
 *
 * 跑法：node --experimental-strip-types scripts/verify-ui-logic.ts（挂在 `pnpm test` 链上）
 */
import {
  groupSessionsByTime,
  bucketOf,
  splitPinned,
  otherProjects,
  buildSessionSidebarSections,
  resolveSessionStatus,
  formatRelativeTime,
  sessionStatusLabel
} from '../src/lib/session-groups.ts'
import {
  currentStepText,
  describeRunSteps,
  describeToolCall,
  formatElapsed,
  limitWarning,
  maxStepsNotice
} from '../src/lib/run-status.ts'
import { APPROVAL_TIMEOUT_NOTE, approvalTimer, formatCountdown } from '../src/lib/approval-timer.ts'
import { composerBlocker } from '../src/lib/composer-blocker.ts'
import { summarizeSteps } from '../src/lib/step-summary.ts'
import { hiddenContextNote } from '../src/lib/message-window.ts'
import { summarizeRun } from '../src/lib/run-summary.ts'
import { GENERIC_STARTERS, buildStarters, emptyStateTitle } from '../src/lib/starters.ts'
import { SHORTCUTS, displayKeys, shortcutFor, shortcutsByGroup, tooltipWithShortcut } from '../src/lib/shortcuts.ts'
import { MESSAGE_WINDOW, hiddenLabel, windowMessages } from '../src/lib/message-window.ts'
import { MESSAGE_PREVIEW_MAX, messageExcerpt, messageRoleLabel } from '../src/lib/message-preview.ts'
import { sessionRailPreviewTop, tickCenterYInRail } from '../src/lib/session-rail-preview.ts'
import {
  COMPACT_SIDEBAR_BELOW,
  PREFER_INSPECTOR_COLLAPSE_BELOW,
  SIDEBAR_RAIL_WIDTH,
  SIDEBAR_WIDTH,
  layoutFor
} from '../src/lib/layout.ts'
import { SESSION_PAGE_SIZE, pageSessions } from '../src/lib/session-page.ts'
import {
  COMMON_THINKING_LEVELS,
  THINKING_LEVELS,
  normalizeThinkingLevel,
  thinkingHint,
  thinkingLabel
} from '../src/lib/thinking.ts'
import {
  BOOT_MIN_MS,
  BOOT_TARGETS,
  approachBootProgress,
  canFinishSplash,
  clampPercent,
  formatBootPercent
} from '../src/lib/boot-progress.ts'
import type { MessagePart, WorkspaceFacts } from '@i-pi-desk/shared'

let failures = 0
let checks = 0

function check(label: string, condition: boolean, detail = ''): void {
  checks += 1
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

const NOW = new Date(2026, 9, 11, 0, 10, 0) // 2026-10-11 00:10 本地时间
const at = (y: number, m: number, d: number, h = 12, min = 0): string =>
  new Date(y, m - 1, d, h, min, 0).toISOString()

console.log('\n── 会话时间分组：边界在日历日，不在 24 小时 ──')
{
  check('此刻 00:10 的会话算「今天」', bucketOf(at(2026, 10, 11, 0, 5), NOW) === 'today')
  check('23:50 的会话算「昨天」（尽管只差 20 分钟）', bucketOf(at(2026, 10, 10, 23, 50), NOW) === 'yesterday')
  check('3 天前算「近 7 天」', bucketOf(at(2026, 10, 8), NOW) === 'last7')
  check('7 天前算「近 7 天」的边界内', bucketOf(at(2026, 10, 5), NOW) === 'last7')
  check('8 天前算「更早」', bucketOf(at(2026, 10, 3), NOW) === 'older')
  check('非法时间不抛异常，落到「更早」', bucketOf('不是时间', NOW) === 'older')

  const groups = groupSessionsByTime(
    [
      { id: 'a', updatedAt: at(2026, 10, 11, 0, 5) },
      { id: 'b', updatedAt: at(2026, 10, 10, 23, 50) },
      { id: 'c', updatedAt: at(2026, 10, 8) },
      { id: 'd', updatedAt: at(2026, 9, 1) }
    ],
    NOW
  )
  check('分成四组且顺序固定为 今天→昨天→近7天→更早', groups.map((g) => g.label).join('|') === '今天|昨天|近 7 天|更早', JSON.stringify(groups.map((g) => g.label)))
  check('组内保持传入顺序', groups[0]?.items[0]?.id === 'a' && groups[3]?.items[0]?.id === 'd')
  check('空输入得到空分组', groupSessionsByTime([], NOW).length === 0)
  const single = groupSessionsByTime([{ id: 'a', updatedAt: at(2026, 10, 11, 0, 5) }], NOW)
  check('只有一个组时不补空组', single.length === 1 && single[0]?.label === '今天')
}

console.log('\n── 工具调用翻译成人话（不能退化成「正在处理…」）──')
{
  check('read 带路径', describeToolCall('read', { path: 'src/main.ts' }) === '正在读取 src/main.ts')
  check('bash 带命令', describeToolCall('bash', { command: 'pnpm test' }) === '正在运行 pnpm test')
  check('edit 带路径', describeToolCall('edit', { path: 'src/sum.ts' }) === '正在修改 src/sum.ts')
  check('grep 带模式', describeToolCall('grep', { pattern: 'TODO' }) === '正在搜索 TODO')
  check('缺参数时给类别而不是空白', describeToolCall('read', {}) === '正在读取文件')
  check('不认识的工具带上工具名', describeToolCall('fixture_echo', {}) === '正在调用 fixture_echo')
  check(
    '长参数被截断（不把整段内容塞进一行）',
    (describeToolCall('bash', { command: 'x'.repeat(200) }) ?? '').length <= 70,
    describeToolCall('bash', { command: 'x'.repeat(200) })
  )

  const parts: MessagePart[] = [
    { kind: 'text', text: '先看一下' },
    { kind: 'tool-call', callId: '1', name: 'read', args: { path: 'a.ts' }, state: 'succeeded' },
    { kind: 'tool-call', callId: '2', name: 'bash', args: { command: 'pnpm test' }, state: 'running' }
  ]
  const steps = describeRunSteps(parts)
  check('只取工具调用，并按顺序翻译', steps.length === 2 && steps[0]?.text === '正在读取 a.ts', JSON.stringify(steps))
  check('状态映射正确（succeeded→done / running→running）', steps[0]?.state === 'done' && steps[1]?.state === 'running')
  check('当前步骤优先取「正在跑」的那条', currentStepText(steps) === '正在运行 pnpm test', String(currentStepText(steps)))
  check('没有工具调用时不给话术（由界面说「正在思考…」）', currentStepText([]) === undefined)
  check(
    '等待授权时提示的是那一步',
    currentStepText(describeRunSteps([{ kind: 'tool-call', callId: '3', name: 'write', args: { path: 'x.ts' }, state: 'awaiting-approval' }])) === '正在写入 x.ts'
  )
  check('全部完成后说「已完成 …」', currentStepText(describeRunSteps([{ kind: 'tool-call', callId: '4', name: 'read', args: { path: 'b.ts' }, state: 'succeeded' }])) === '已完成 读取 b.ts', String(currentStepText(describeRunSteps([{ kind: 'tool-call', callId: '4', name: 'read', args: { path: 'b.ts' }, state: 'succeeded' }]))))
  check('超过上限时保留最后几条', describeRunSteps(
    Array.from({ length: 9 }, (_, i) => ({ kind: 'tool-call' as const, callId: String(i), name: 'read', args: { path: `f${i}.ts` }, state: 'succeeded' as const })),
    4
  ).length === 4)

  check('耗时格式化：0 → 0:00', formatElapsed(0) === '0:00')
  check('耗时格式化：125s → 2:05', formatElapsed(125_000) === '2:05')
  check('耗时格式化：一小时以上 → 1:02:03', formatElapsed(3_723_000) === '1:02:03')
  check('非法耗时按 0 处理', formatElapsed(Number.NaN) === '0:00')
}

console.log('\n── 审批倒计时（必须说清「不点会怎样」）──')
{
  const fresh = approvalTimer(0, 0)
  check('刚出现时是完整的 5 分钟', fresh.remainingMs === 300_000 && !fresh.expired, JSON.stringify(fresh))
  check(
    '文案里带「超时按拒绝处理」，且**只带一次**（重复拼接会在这里露馅）',
    fresh.text.split(APPROVAL_TIMEOUT_NOTE).length - 1 === 1,
    fresh.text
  )
  check('文案里有剩余时间', fresh.text.startsWith('还有 5 分 0 秒'), fresh.text)

  const later = approvalTimer(0, 8_000)
  check('8 秒后剩 4 分 52 秒', later.remainingMs === 292_000 && later.text.includes('还有 4 分 52 秒'), later.text)

  const lastMinute = approvalTimer(0, 250_000)
  check('不足一分钟时只说秒', lastMinute.text.includes('还有 50 秒'), lastMinute.text)

  const expired = approvalTimer(0, 300_001)
  check('超时后标记为 expired', expired.expired && expired.remainingMs === 0)
  check('超时文案说明这一步没有执行', expired.text.includes('已超时') && expired.text.includes('这一步没有执行'), expired.text)
  check('超时文案不再重复「超时按拒绝处理」（避免啰嗦）', !expired.text.includes('超时按「拒绝」处理'), expired.text)

  check('格式函数单独可用（1 秒）', formatCountdown(1_000) === '还有 1 秒')
  check('格式函数对 0 返回超时文案', formatCountdown(0).startsWith('已超时'))
  check('常量文案没有漂（界面与文档引用同一句）', APPROVAL_TIMEOUT_NOTE.includes('其余步骤继续'))
}


console.log('\n── 不能发送时的说明（不能只说「缺什么」而不给入口）──')
{
  const noWorkspace = composerBlocker({ hasWorkspace: false, enabledProviders: 0 })
  check('没目录时先提目录（比「没模型」更前置）', noWorkspace?.action === 'pick-workspace', JSON.stringify(noWorkspace))
  check('没目录时文案说清了后果', (noWorkspace?.text ?? '').includes('不知道在哪干活'), String(noWorkspace?.text))
  check('没目录时的入口是「选目录」', (noWorkspace?.actionLabel ?? '').includes('目录'), String(noWorkspace?.actionLabel))

  const noModel = composerBlocker({ hasWorkspace: true, enabledProviders: 0 })
  check('有目录但没模型时指向设置', noModel?.action === 'open-settings', JSON.stringify(noModel))
  check('没模型时说明了「发出去只会报错」', (noModel?.text ?? '').includes('报错'), String(noModel?.text))

  check('都就绪时不给任何提示', composerBlocker({ hasWorkspace: true, enabledProviders: 2 }) === null)
  const stubOnly = composerBlocker({ hasWorkspace: true, enabledProviders: 1, onlyStubProviders: true })
  check('只有假模型时也要拦', stubOnly !== null && stubOnly.action === 'open-settings')
  check('每个分支都带可点的入口文案', [noWorkspace, noModel].every((b) => (b?.actionLabel ?? '').length > 0))
}

console.log('\n── 步骤摘要：成功默认收起，问题要浮出来 ──')
{
  const ok = summarizeSteps([
    { kind: 'tool-call', callId: '1', name: 'read', args: {}, state: 'succeeded' },
    { kind: 'tool-call', callId: '2', name: 'read', args: {}, state: 'succeeded' }
  ])
  check('全部成功时默认收起', ok.startOpen === false && ok.issues === 0 && ok.total === 2)

  const failed = summarizeSteps([
    { kind: 'tool-call', callId: '1', name: 'read', args: {}, state: 'succeeded' },
    { kind: 'tool-call', callId: '2', name: 'bash', args: {}, state: 'failed', error: 'exit 1' }
  ])
  check('有失败时展开并计问题', failed.startOpen === true && failed.issues === 1)

  const pending = summarizeSteps([
    { kind: 'approval', approvalId: 'a', callId: '1', toolName: 'write', args: {} }
  ])
  check('未裁决的审批默认展开', pending.startOpen === true && pending.issues === 0)

  const denied = summarizeSteps([
    { kind: 'approval', approvalId: 'a', callId: '1', toolName: 'write', args: {}, decision: 'deny' }
  ])
  check('已拒绝算问题且不必再展开', denied.issues === 1 && denied.startOpen === false)

  check('折叠说明点明模型看不到更早消息', hiddenContextNote(12).includes('不发给模型') && hiddenContextNote(0) === '')
}


console.log('\n── 部分完成汇总（先给数字，再给原因）──')
{
  const call = (
    callId: string,
    name: string,
    state: 'succeeded' | 'failed' | 'denied' | 'running',
    error?: string
  ): MessagePart => ({ kind: 'tool-call', callId, name, args: {}, state, error })

  check('全部成功时不给汇总（不给噪音）', summarizeRun([call('1', 'read', 'succeeded'), call('2', 'write', 'succeeded')]) === null)
  check('没有工具调用时不给汇总', summarizeRun([{ kind: 'text', text: '你好' }]) === null)
  check('还有没跑完的步骤时不下结论', summarizeRun([call('1', 'read', 'succeeded'), call('2', 'bash', 'running')]) === null)

  const partial = summarizeRun([
    call('1', 'read', 'succeeded'),
    call('2', 'write', 'succeeded'),
    call('3', 'edit', 'failed', 'EPERM: operation not permitted\n  at writeFileSync'),
    call('4', 'bash', 'denied')
  ])
  check('结论先说数字', partial?.headline === '4 步里完成了 2 步', String(partial?.headline))
  check('说明里带没做成的步数', partial?.detail === '2 步没做成，原因见下', String(partial?.detail))
  check('逐条列出没做成的', partial?.items.length === 2, JSON.stringify(partial?.items))
  check('失败项带的是**错误第一行**（不是整段堆栈）', partial?.items[0]?.reason.startsWith('EPERM: operation not permitted') === true, String(partial?.items[0]?.reason))
  check(
    '被拒绝的措辞是「你拒绝了」（与「失败」区分开）',
    partial?.items[1]?.reason === '你拒绝了这次操作' && partial?.items[1]?.kind === 'denied',
    JSON.stringify(partial?.items[1])
  )
  check('失败但没有错误信息时也有兜底原因', summarizeRun([call('1', 'bash', 'failed')])?.items[0]?.reason === '执行失败（没有返回原因）', String(summarizeRun([call('1', 'bash', 'failed')])?.items[0]?.reason))
  check('只有被拒绝、没有失败时也给汇总', summarizeRun([call('1', 'read', 'succeeded'), call('2', 'write', 'denied')])?.denied === 1)
  /**
   * 真实运行里，用户拒绝被主机记成 state: 'failed' + 一段写给模型的错误文案。
   * 只看 state 会把拒绝显示成「失败」—— 这条断言就是钉住那条真实路径。
   */
  const realDenial = summarizeRun([
    call('1', 'write', 'failed', '用户拒绝执行 write。请换一种方式，或先征得用户同意。')
  ])
  check('主机实际给的信号（failed + 「用户拒绝」文案）也认作拒绝', realDenial?.items[0]?.kind === 'denied', JSON.stringify(realDenial?.items))
  check('拒绝的措辞换成第一人称，而不是照搬给模型看的那段', realDenial?.items[0]?.reason === '你拒绝了这次操作', String(realDenial?.items[0]?.reason))
  check('真的失败（不是拒绝）仍然算失败', summarizeRun([call('1', 'bash', 'failed', 'spawn EPERM')])?.items[0]?.kind === 'failed')
  const anySuccess = summarizeRun([call('1', 'read', 'succeeded'), call('2', 'bash', 'failed')])
  check('有成功步骤时说清「已完成的那几步都还在」', anySuccess?.keptText.includes('都还在磁盘上') === true, String(anySuccess?.keptText))
  check('文案里带上成功的步数', anySuccess?.keptText.includes('已完成的 1 步') === true, String(anySuccess?.keptText))
  const zeroSuccess = summarizeRun([call('1', 'write', 'denied')])
  check(
    '零成功时不说「已完成的 0 步都还在」（那是废话）',
    zeroSuccess?.keptText.includes('没有产生任何改动') === true && !zeroSuccess?.keptText.includes('0 步'),
    String(zeroSuccess?.keptText)
  )
  check(
    '超长错误被截断（卡片里放不下整段）',
    (summarizeRun([call('1', 'bash', 'failed', 'x'.repeat(200))])?.items[0]?.reason ?? '').length <= 80
  )
}

console.log('\n── 限额：撞墙前提醒，撞墙后给数字与入口 ──')
{
  check('远离上限时不打扰', limitWarning(10, 40) === null)
  check('77.5% 还不提醒（阈值 80%）', limitWarning(31, 40) === null)
  const near = limitWarning(32, 40)
  check('80% 开始提醒', near !== null && near.used === 32 && near.max === 40, JSON.stringify(near))
  check('提醒里带具体数字', (near?.text ?? '').includes('32/40'), String(near?.text))
  check('到达上限时不走预警（那是「已经停了」那条通知的事）', limitWarning(40, 40) === null)
  check('上限设为 0 时不预警（避免除零与无意义提示）', limitWarning(5, 0) === null)

  const notice = maxStepsNotice(40, 40)
  check('停止通知带具体步数', notice.includes('40/40'), notice)
  check('停止通知指向设置里的具体位置', notice.includes('设置') && notice.includes('单次最大步数'), notice)
  check('停止通知说明什么被保住了', notice.includes('落盘') && notice.includes('不会丢'), notice)
}


console.log('\n── 起手任务：基于工作区的真实情况（不能是三条万能句）──')
{
  const facts = (over: Partial<WorkspaceFacts> = {}): WorkspaceFacts => ({
    root: 'C:/proj',
    sourceFiles: 0,
    testFiles: 0,
    todoCount: 0,
    scannedFiles: 0,
    scripts: [],
    topLevelDirs: [],
    hasReadme: false,
    hasGit: false,
    truncated: false,
    ...over
  })

  check('没有事实时退回通用三条（宁可通用，也不编造）', buildStarters(null) === GENERIC_STARTERS)
  check('扫不到任何东西时也退回通用三条', buildStarters(facts()) === GENERIC_STARTERS)
  check('通用三条不为空', GENERIC_STARTERS.length === 3)
  check('通用三条都带 why（界面要显示）', GENERIC_STARTERS.every((s) => s.why.length > 0))

  const full = buildStarters(
    facts({
      packageManager: 'pnpm',
      scripts: ['build', 'test', 'lint'],
      srcDir: 'src',
      sourceFiles: 42,
      testFiles: 6,
      todoCount: 7,
      hasReadme: true,
      hasGit: true,
      scannedFiles: 90
    })
  )
  check('最多给三条', full.length === 3, JSON.stringify(full.map((s) => s.id)))
  check('优先建议「现在就能跑起来的事」（测试排第一）', full[0]?.id === 'test-test', String(full[0]?.id))
  check('命令按包管理器写（pnpm test 而不是 npm run test）', full[0]?.text.includes('pnpm test') === true, String(full[0]?.text))
  check('第二条是看结构，且用的是真实目录名', full[1]?.text.includes('src/') === true, String(full[1]?.text))
  check('why 里带上真实数字（它看过你的项目）', full[1]?.why.includes('42 个源文件') === true, String(full[1]?.why))
  check('第三条轮到 TODO，并给出处数', full[2]?.id === 'todo' && full[2]?.why.includes('7 处') === true, JSON.stringify(full[2]))

  const npmProject = buildStarters(facts({ packageManager: 'npm', scripts: ['test'] }))
  check('npm 项目写成 npm run test', npmProject[0]?.text.includes('npm run test') === true, String(npmProject[0]?.text))
  const unknownManager = buildStarters(facts({ scripts: ['test'] }))
  check('没有锁文件时不假装知道命令', unknownManager[0]?.text.startsWith('跑一遍 运行 test') === true, String(unknownManager[0]?.text))

  const noTestScript = buildStarters(facts({ testFiles: 3, sourceFiles: 5, srcDir: 'src' }))
  check('没有 test 脚本但有测试文件时，仍然建议跑测试', noTestScript[0]?.id === 'test-files', String(noTestScript[0]?.id))
  check('并说明依据是测试文件数', noTestScript[0]?.why.includes('3 个测试文件') === true, String(noTestScript[0]?.why))

  const readmeOnly = buildStarters(facts({ hasReadme: true }))
  check('只有 README 时就只给一条（不硬凑三条）', readmeOnly.length === 1 && readmeOnly[0]?.id === 'readme', JSON.stringify(readmeOnly.map((s) => s.id)))

  const gitOnly = buildStarters(facts({ hasGit: true }))
  check('只有 git 信息时给的是「看历史」', gitOnly[0]?.id === 'git', String(gitOnly[0]?.id))

  const truncated = buildStarters(facts({ sourceFiles: 100, srcDir: 'src', truncated: true }))
  check('扫描被截断时 why 里说明「只扫了一部分」（不夸大）', truncated[0]?.why.includes('只扫了一部分') === true, String(truncated[0]?.why))
  /**
   * 两种截断要说清是哪一种。
   *
   * 源文件计数完整、只有 TODO 读取被限时，**不能**说「源文件只扫了一部分」——
   * 那是把完整的数字说成不完整的（安装版实跑时看出来的）。反过来，
   * TODO 只统计了一部分时也必须说，否则用户会以为 11 处就是全部。
   */
  const todoPartial = buildStarters(
    facts({ todoCount: 5, todoPartial: true, sourceFiles: 100, srcDir: 'src', truncated: false })
  )
  const todoStarter = todoPartial.find((starter) => starter.id === 'todo')
  check('TODO 只统计了部分文件时明说', todoStarter?.why.includes('只统计了部分文件') === true, String(todoStarter?.why))
  const structureWhenTodoPartial = todoPartial.find((starter) => starter.id === 'structure')
  check(
    '源文件计数完整时不说「只扫了一部分」',
    structureWhenTodoPartial?.why.includes('只扫了一部分') === false,
    String(structureWhenTodoPartial?.why)
  )
  const todoComplete = buildStarters(facts({ todoCount: 5, todoPartial: false, sourceFiles: 3, srcDir: 'src' }))
  check(
    'TODO 统计完整时不加限定语',
    todoComplete.find((s) => s.id === 'todo')?.why.includes('只统计了部分文件') === false,
    String(todoComplete.find((s) => s.id === 'todo')?.why)
  )

  check('用工作区名打招呼', emptyStateTitle('a3-lib') === '今天想在 a3-lib 里做点什么？', emptyStateTitle('a3-lib'))
  check('没有工作区时退化成通用问候', emptyStateTitle(undefined) === '今天想做点什么？', emptyStateTitle(undefined))
}


console.log('\n── 快捷键表：单一来源（绑定、tooltip、键盘地图都读它）──')
{
  check('表不为空', SHORTCUTS.length >= 10, String(SHORTCUTS.length))
  check('每个 id 唯一（重复会让绑定互相覆盖）', new Set(SHORTCUTS.map((s) => s.id)).size === SHORTCUTS.length)
  check('每个键位唯一（两个功能抢同一个键是 bug）', new Set(SHORTCUTS.map((s) => s.keys)).size === SHORTCUTS.length)
  check('每条都有说明文案（键盘地图要显示）', SHORTCUTS.every((s) => s.label.length > 0))
  check('每条都属于已知分组', SHORTCUTS.every((s) => ['全局', '面板', '对话', '文件与编辑器'].includes(s.group)))
  check('键位写法统一小写（react-hotkeys-hook 的写法）', SHORTCUTS.every((s) => s.keys === s.keys.toLowerCase()))
  check('快速启动面板有快捷键', shortcutFor('launcher').keys === 'ctrl+k', shortcutFor('launcher').keys)
  check('开合终端与文件面板都有快捷键', Boolean(shortcutFor('toggle-terminal') && shortcutFor('toggle-files')))
  check('键盘地图自己有快捷键', shortcutFor('keyboard-map').keys.length > 0)

  check('展示写法：ctrl+k → Ctrl + K', displayKeys('ctrl+k') === 'Ctrl + K', displayKeys('ctrl+k'))
  check('展示写法：反引号不写成 backquote', displayKeys('ctrl+backquote') === 'Ctrl + `', displayKeys('ctrl+backquote'))
  check('展示写法：shift+enter', displayKeys('shift+enter') === 'Shift + Enter', displayKeys('shift+enter'))
  check('展示写法：escape → Esc', displayKeys('escape') === 'Esc', displayKeys('escape'))

  check(
    'tooltip 带上快捷键（按钮提示与实际绑定同源）',
    tooltipWithShortcut('终端', 'toggle-terminal').startsWith('终端（Ctrl'),
    tooltipWithShortcut('终端', 'toggle-terminal')
  )
  check('未知 id 的 tooltip 退回原标题（不显示空括号）', tooltipWithShortcut('某按钮', '不存在') === '某按钮')

  const grouped = shortcutsByGroup()
  check('分组顺序固定为 全局 → 面板 → 对话 → 文件与编辑器', grouped.map((g) => g.group).join('|') === '全局|面板|对话|文件与编辑器', grouped.map((g) => g.group).join('|'))
  check('分组不丢项（每组之和等于总数）', grouped.reduce((sum, g) => sum + g.items.length, 0) === SHORTCUTS.length)
  let threw = false
  try {
    shortcutFor('并不存在')
  } catch {
    threw = true
  }
  check('拼错 id 会在开发期就抛错（而不是显示空括号）', threw)
}


console.log('\n── 思考强度：档位与文案只有一份 ──')
{
  /**
   * 这七个值必须与内核的 `ThinkingLevel` 逐字一致 —— shared 里那份手写联合类型
   * 由 verify:doc-claims 直接读内核 d.ts 比对（跨包的不变量），
   * 这里守的是渲染层这一份：数量、唯一性、文案与规整行为。
   */
  const KERNEL_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  check('档位数量与内核一致（7 个）', THINKING_LEVELS.length === KERNEL_LEVELS.length, String(THINKING_LEVELS.length))
  check(
    '档位取值与内核逐字一致',
    THINKING_LEVELS.map((level) => level.value).join(',') === KERNEL_LEVELS.join(','),
    THINKING_LEVELS.map((level) => level.value).join(',')
  )
  check('每个档位都有中文标签', THINKING_LEVELS.every((level) => level.label.length > 0))
  check('标签不重复（下拉里两行同名会让人分不清）', new Set(THINKING_LEVELS.map((level) => level.label)).size === THINKING_LEVELS.length)
  check('每个档位都有说明（tooltip 要显示）', THINKING_LEVELS.every((level) => level.hint.length > 0))

  check('输入区只给常用的四个', COMMON_THINKING_LEVELS.length === 4, COMMON_THINKING_LEVELS.join(','))
  check('常用档位都来自全量清单', COMMON_THINKING_LEVELS.every((value) => THINKING_LEVELS.some((level) => level.value === value)))
  check('默认档位（medium）在常用档位里', COMMON_THINKING_LEVELS.includes('medium'))

  check('标签查得到', thinkingLabel('high') === '高', thinkingLabel('high'))
  check('未设置时按默认档位的文案（中）', thinkingLabel(undefined) === '中', thinkingLabel(undefined))
  check('说明查得到', thinkingHint('off').length > 0)

  check('规整：认得七个值', KERNEL_LEVELS.every((value) => normalizeThinkingLevel(value) === value))
  check('规整：认不出来就返回 undefined（交给内核默认，而不是偷偷替换）', normalizeThinkingLevel('bogus') === undefined)
  check('规整：undefined 也是 undefined', normalizeThinkingLevel(undefined) === undefined)
  check('规整：非字符串不炸', normalizeThinkingLevel(42) === undefined && normalizeThinkingLevel({}) === undefined)
}


console.log('\n── 长会话窗口：只渲染最近 N 条 ──')
{
  const many = Array.from({ length: 60 }, (_, index) => `m${index + 1}`)

  const normal = windowMessages(many)
  check('默认只给最近 MESSAGE_WINDOW 条', normal.visible.length === MESSAGE_WINDOW, String(normal.visible.length))
  check('保留的是**最后**那些（用户关心刚发生的事）', normal.visible[0] === `m${60 - MESSAGE_WINDOW + 1}` && normal.visible.at(-1) === 'm60', `${normal.visible[0]} → ${normal.visible.at(-1)}`)
  check('折叠条数算得对', normal.hiddenCount === 60 - MESSAGE_WINDOW, String(normal.hiddenCount))

  const expanded = windowMessages(many, MESSAGE_WINDOW, true)
  check('展开后给全部', expanded.visible.length === 60 && expanded.hiddenCount === 0, String(expanded.visible.length))

  const exact = windowMessages(Array.from({ length: MESSAGE_WINDOW }, (_, index) => `x${index}`))
  check('正好等于上限时不折叠（边界）', exact.hiddenCount === 0 && exact.visible.length === MESSAGE_WINDOW, String(exact.hiddenCount))

  const short = windowMessages(['a', 'b'])
  check('消息很少时不折叠', short.hiddenCount === 0 && short.visible.length === 2)

  check('空会话不炸', windowMessages([]).visible.length === 0 && windowMessages([]).hiddenCount === 0)

  const custom = windowMessages(many, 5)
  check('上限可注入（自测用）', custom.visible.length === 5 && custom.hiddenCount === 55, JSON.stringify(custom.hiddenCount))

  // 上限非法时宁可全渲染，也不要让界面空掉
  check('上限为 0 时不折叠（宁可多渲染，也不要空界面）', windowMessages(many, 0).visible.length === 60)
  check('上限为负/NaN 时同样不折叠', windowMessages(many, -3).visible.length === 60 && windowMessages(many, Number.NaN).visible.length === 60)

  check('折叠提示带具体条数', hiddenLabel(23) === '显示更早的 23 条消息', hiddenLabel(23))
}


console.log('\n── 窄窗口版面：宽的时候绝不折叠 ──')
{
  const wide = layoutFor(1280)
  check('默认窗口宽度下不折叠', wide.compactSidebar === false && wide.sidebarWidth === SIDEBAR_WIDTH, JSON.stringify(wide))

  const atThreshold = layoutFor(COMPACT_SIDEBAR_BELOW)
  check('正好等于阈值时不折叠（边界属于「宽」那一侧）', atThreshold.compactSidebar === false, JSON.stringify(atThreshold))

  const justBelow = layoutFor(COMPACT_SIDEBAR_BELOW - 1)
  check('低于阈值 1px 就折叠', justBelow.compactSidebar === true, JSON.stringify(justBelow))
  check('折叠后宽度是图标条宽度（与界面同一个来源）', justBelow.sidebarWidth === SIDEBAR_RAIL_WIDTH, JSON.stringify(justBelow))

  const minimum = layoutFor(900)
  check('窗口下限（900）时也折叠', minimum.compactSidebar === true, JSON.stringify(minimum))
  check('折叠后确实腾出了空间（≥ 200px）', SIDEBAR_WIDTH - SIDEBAR_RAIL_WIDTH >= 200, String(SIDEBAR_WIDTH - SIDEBAR_RAIL_WIDTH))
  check(
    '默认宽窗不建议收右栏',
    layoutFor(1280).preferInspectorCollapsed === false
  )
  check(
    '低于右栏优先阈值时建议收右栏',
    layoutFor(PREFER_INSPECTOR_COLLAPSE_BELOW - 1).preferInspectorCollapsed === true
  )
  check(
    '1000 宽不折叠会话侧栏（保住设计稿 A）',
    layoutFor(1000).compactSidebar === false && layoutFor(1000).preferInspectorCollapsed === true
  )

  // 非法宽度按「不折叠」处理：宁可挤一点，也不要让界面莫名其妙变窄
  check('宽度为 0/NaN 时不折叠', layoutFor(0).compactSidebar === false && layoutFor(Number.NaN).compactSidebar === false)
  check('负数宽度也不折叠', layoutFor(-100).compactSidebar === false)
}


console.log('\n── 会话列表分页 ──')
{
  const many = Array.from({ length: 80 }, (_, index) => `s${index + 1}`)

  const normal = pageSessions(many)
  check('默认只显示前 SESSION_PAGE_SIZE 个', normal.shown.length === SESSION_PAGE_SIZE, String(normal.shown.length))
  check('从**最新**那头开始显示（会话列表是按时间倒序的）', normal.shown[0] === 's1', String(normal.shown[0]))
  check('剩余条数算得对', normal.hiddenCount === 80 - SESSION_PAGE_SIZE, String(normal.hiddenCount))

  const expanded = pageSessions(many, SESSION_PAGE_SIZE, true)
  check('展开后给全部', expanded.shown.length === 80 && expanded.hiddenCount === 0, String(expanded.shown.length))

  const few = pageSessions(['a', 'b'])
  check('会话很少时不显示「加载更多」', few.hiddenCount === 0 && few.shown.length === 2)

  const exact = pageSessions(Array.from({ length: SESSION_PAGE_SIZE }, (_, i) => `x${i}`))
  check('正好等于一页时不显示「加载更多」（边界）', exact.hiddenCount === 0)

  check('上限为 0 / 负数 / NaN 时全显示（分页是优化，不该把内容藏没）', pageSessions(many, 0).hiddenCount === 0 && pageSessions(many, -5).hiddenCount === 0 && pageSessions(many, Number.NaN).hiddenCount === 0)

  const custom = pageSessions(many, 5)
  check('上限可注入（自测用）', custom.shown.length === 5 && custom.hiddenCount === 75, JSON.stringify(custom.hiddenCount))
}


console.log('\n── 置顶：单独一组，且不改动时间序 ──')
{
  const list = [
    { id: 'a', pinned: false, updatedAt: '2026-01-03' },
    { id: 'b', pinned: true, updatedAt: '2026-01-01' },
    { id: 'c', pinned: false, updatedAt: '2026-01-02' },
    { id: 'd', pinned: true, updatedAt: '2026-01-04' }
  ]

  const split = splitPinned(list)
  check('置顶的被单独分出来', split.pinned.map((s) => s.id).join(',') === 'b,d', JSON.stringify(split.pinned.map((s) => s.id)))
  check('其余的保持原顺序', split.rest.map((s) => s.id).join(',') === 'a,c', JSON.stringify(split.rest.map((s) => s.id)))
  check('置顶**不按时间重排**（时间只影响组内位置）', split.pinned[0].id === 'b', JSON.stringify(split.pinned.map((s) => s.id)))
  check('一个都没置顶时置顶组为空', splitPinned([{ id: 'x' }, { id: 'y' }]).pinned.length === 0)
  check('全都置顶时 rest 为空', splitPinned([{ id: 'x', pinned: true }]).rest.length === 0)
  check('空列表不炸', splitPinned([]).rest.length === 0 && splitPinned([]).pinned.length === 0)
  check('pinned 显式为 false 不算置顶', splitPinned([{ id: 'z', pinned: false }]).pinned.length === 0)
}


console.log('\n── 「项目」分组：别的目录里有会话才列 ──')
{
  const workspaces = [
    { id: 'a', name: 'fixture', path: 'C:/w/fixture' },
    { id: 'b', name: 'second', path: 'C:/w/second' }
  ]
  const sessions = [{ workspaceId: 'a' }, { workspaceId: 'a' }, { workspaceId: 'b' }]

  const projects = otherProjects(workspaces, sessions, 'a')
  check('列出别的目录（不含当前目录）', projects.map((p) => p.id).join(',') === 'b', JSON.stringify(projects.map((p) => p.id)))
  check('带上那个目录的会话数', projects[0].count === 1, String(projects[0].count))
  check('名字与路径从目录列表查得', projects[0].name === 'second' && projects[0].path === 'C:/w/second', JSON.stringify(projects[0]))

  // 目录已经被「从最近目录移除」、但会话还在：仍然要列出来（否则这个入口凭空消失）
  const orphan = otherProjects([workspaces[0]], sessions, 'a')
  check('目录不在列表里时仍然列出（名字退回 id 前缀、路径为空）', orphan.length === 1 && orphan[0].name === 'b' && orphan[0].path === '', JSON.stringify(orphan))
  check('路径为空时不给它可点的错觉（上层据此不切目录）', orphan[0].path === '')

  check('别的目录没有会话时列表为空', otherProjects(workspaces, [{ workspaceId: 'a' }], 'a').length === 0)
  check('没有当前目录时（未选工作区）全都算「别的」', otherProjects(workspaces, sessions, undefined).length === 2)
  check('空会话列表不炸', otherProjects(workspaces, [], 'a').length === 0)
}

console.log('\n── 侧栏三段：临时 / 置顶 / 按项目 ──')
{
  const workspaces = [
    { id: 'def', name: 'scratch', path: 'C:/w/scratch', color: '#6b9b7a' },
    { id: 'repo', name: 'a3-lib', path: 'C:/w/a3-lib', color: '#c4a574' }
  ]
  const sessions = [
    { id: 't1', workspaceId: 'def', updatedAt: '2026-10-12', pinned: false },
    { id: 'p1', workspaceId: 'repo', updatedAt: '2026-10-11', pinned: true },
    { id: 'n1', workspaceId: 'repo', updatedAt: '2026-10-10', pinned: false },
    { id: 'n2', workspaceId: 'repo', updatedAt: '2026-10-13', pinned: false },
    { id: 'p2', workspaceId: 'def', updatedAt: '2026-10-09', pinned: true }
  ]
  const sections = buildSessionSidebarSections(sessions, workspaces, 'C:/w/scratch')
  check('默认工作区未置顶进临时', sections.temporary.map((s) => s.id).join(',') === 't1')
  check('置顶跨项目且按时间倒序', sections.pinned.map((s) => s.id).join(',') === 'p1,p2')
  check('普通会话按项目聚合', sections.projects.length === 1 && sections.projects[0].workspaceId === 'repo')
  check('项目组带色', sections.projects[0].color === '#c4a574')
  check('项目组内按时间倒序', sections.projects[0].items.map((s) => s.id).join(',') === 'n2,n1')
  check('无默认路径时临时为空', buildSessionSidebarSections(sessions, workspaces, undefined).temporary.length === 0)
  {
    // 工作区从列表移除（隐藏）后：会话仍在，但侧栏不应再冒出该项目行。
    const afterForget = buildSessionSidebarSections(sessions, [workspaces[0]], 'C:/w/scratch')
    check(
      '移除项目后其会话不再撑起项目组',
      afterForget.projects.length === 0 &&
        !afterForget.pinned.some((s) => s.workspaceId === 'repo') &&
        afterForget.temporary.map((s) => s.id).join(',') === 't1'
    )
  }
  check('审批优先于 runStatus 显示为异常', resolveSessionStatus({ runStatus: 'done', messageCount: 2 }, { awaitsApproval: true }) === 'error')
  check('busy 显示进行中', resolveSessionStatus({ runStatus: 'done', messageCount: 2 }, { busy: true }) === 'running')
  check('空消息为新建', resolveSessionStatus({ messageCount: 0 }) === 'new')
  check('相对时间天', formatRelativeTime('2026-09-25T00:00:00.000Z', new Date('2026-10-13T00:00:00.000Z')) === '18天')
  check('状态文案', sessionStatusLabel('running') === '进行中' && sessionStatusLabel('error') === '异常')
}

console.log('\n── 启动闪屏混合进度 ──')
{
  check('阶段目标：起步 15', BOOT_TARGETS.start === 15)
  check('阶段目标：关门 100', BOOT_TARGETS.done === 100)
  check('最短展示 800ms', BOOT_MIN_MS === 800)
  check('从 1 向 40 缓动会前进', approachBootProgress(1, 40) > 1)
  check('不回退', approachBootProgress(50, 20) === 50)
  check('贴齐目标', approachBootProgress(99.8, 100) === 100)
  check('百分比夹紧下限为 1', clampPercent(0) === 1)
  check('百分比夹紧上限为 100', clampPercent(120) === 100)
  check('格式化', formatBootPercent(42.2) === '42%')
  check('未 boot 不能收尾', canFinishSplash(false, 9999) === false)
  check('boot 但未满最短时长不能收尾', canFinishSplash(true, 100) === false)
  check('boot 且满最短时长可收尾', canFinishSplash(true, BOOT_MIN_MS) === true)
}

console.log('\n── 消息左侧悬浮预览：摘要与角色标题 ──')
{
  check('助手角色标题', messageRoleLabel('assistant') === '助手消息')
  check('用户角色标题', messageRoleLabel('user') === '用户消息')
  check('拼 text part 并压空白', messageExcerpt([{ kind: 'text', text: '  你好\n世界  ' }]) === '你好 世界')
  check(
    '超长截断并带省略号',
    messageExcerpt([{ kind: 'text', text: 'x'.repeat(MESSAGE_PREVIEW_MAX + 20) }]).endsWith('…') &&
      messageExcerpt([{ kind: 'text', text: 'x'.repeat(MESSAGE_PREVIEW_MAX + 20) }]).length === MESSAGE_PREVIEW_MAX
  )
  check(
    '没有正文时退到工具调用数',
    messageExcerpt([{ kind: 'tool-call', callId: '1', name: 'bash', args: {}, state: 'succeeded' }]) === '1 个工具调用'
  )
  check('完全空 parts 有兜底文案', messageExcerpt([]) === '（无文本内容）')
}

console.log('\n── SessionPreviewRail tip 锚定悬停刻度 ──')
{
  // 刻度相对 rail：top=80、高=8 → 中心 84；tip 高 40、轨高 200 → top 应 = 84（居中无夹紧）
  const tick = { top: 180, height: 8 } as DOMRect
  const rail = { top: 100, height: 200 } as DOMRect
  const centerY = tickCenterYInRail(tick, rail)
  check('刻度中心相对轨顶', centerY === 84)
  check(
    'tip top 对齐刻度中心（translateY(-50%)）',
    sessionRailPreviewTop({ tickCenterY: centerY, previewHeight: 40, railHeight: 200 }) === 84
  )
  check(
    '靠近轨顶时夹紧，不全贴死 0 以外的假顶部',
    sessionRailPreviewTop({ tickCenterY: 4, previewHeight: 40, railHeight: 200 }) === 20
  )
  check(
    '靠近轨底时夹紧',
    sessionRailPreviewTop({ tickCenterY: 195, previewHeight: 40, railHeight: 200 }) === 180
  )
  check(
    '不同刻度得到不同 top（防「全贴顶」回归）',
    sessionRailPreviewTop({ tickCenterY: 40, previewHeight: 40, railHeight: 200 }) !==
      sessionRailPreviewTop({ tickCenterY: 160, previewHeight: 40, railHeight: 200 })
  )
}

console.log(`\n（跑了 ${checks} 条断言）`)
console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
