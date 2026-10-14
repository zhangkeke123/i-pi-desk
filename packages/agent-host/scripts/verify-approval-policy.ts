/**
 * 审批闸门的**策略表**自测：三种模式 × 各类工具，逐条钉住。
 *
 * ## 为什么单独测这一层
 *
 * `verify:renderer` 等自测验的是**接线**（事件、卡片、放行之后工具真的跑了）；
 * 这一份验的是**策略本身**：哪个模式该问、哪个模式该拦、未知工具怎么算。
 * 两者不能互相代替 —— 接线全对而策略表漏了一行，表现同样是「它这次没问我」。
 *
 * 尤其是这三条，都属于「失效了也不报错」的类型：
 *
 *  1. **只读模式**下，除了 `read` 类工具**全部**要拦 —— 不是「已知的写工具」，而是白名单之外的一切；
 *  2. **未知工具名**按 `write` 处理（宁可多问一次），这条 fail-safe 方向必须钉住：
 *     一旦改成「认不出来就放行」，新接入的 MCP / 插件工具就成了后门；
 *  3. 注入的差异预览**抛异常时，审批本身必须照常进行** —— 代码注释写着这句契约，
 *     但在这一份自测之前它没有任何断言（预览是锦上添花，不该拿可用性换装饰）。
 *
 * 运行：`node --experimental-strip-types scripts/verify-approval-policy.ts`
 */

import { createApprovalExtension, riskOf, type ApprovalDecision, type ApprovalRequest } from '../src/approval.ts'

let failures = 0

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

interface GateResult {
  /** 闸门返回的东西：`undefined` = 放行，`{block:true}` = 拦下。 */
  outcome: unknown
  requests: ApprovalRequest[]
}

/**
 * 造一个假的 `ExtensionAPI`，把 `tool_call` 处理器抓出来，然后直接调用它。
 *
 * 这样测的是**闸门自己**，不经过内核 —— 而 §7.5 那些自测测的是它在真实链路里的行为。
 */
async function invoke(options: {
  mode: 'readonly' | 'ask' | 'auto'
  toolName: string
  input?: unknown
  decide?: ApprovalDecision
  preview?: (toolName: string, args: unknown) => string | undefined
}): Promise<GateResult> {
  const requests: ApprovalRequest[] = []
  const handlers = new Map<string, (event: unknown) => Promise<unknown>>()

  const factory = createApprovalExtension({
    getMode: () => options.mode,
    request: async (request) => {
      requests.push(request)
      return options.decide ?? 'allow-once'
    },
    ...(options.preview ? { preview: options.preview } : {})
  })

  // ExtensionFactory 的入参只需要 `on`；其余 API 面本闸门用不到。
  factory({ on: (event: string, handler: (event: unknown) => Promise<unknown>) => handlers.set(event, handler) } as never)

  const handler = handlers.get('tool_call')
  if (!handler) throw new Error('闸门没有注册 tool_call 处理器')
  const outcome = await handler({ toolName: options.toolName, input: options.input ?? {}, toolCallId: `call_${options.toolName}` })
  return { outcome, requests }
}

const blocked = (result: GateResult): boolean =>
  Boolean(result.outcome && typeof result.outcome === 'object' && (result.outcome as { block?: boolean }).block === true)

const reason = (result: GateResult): string =>
  String((result.outcome as { reason?: string } | undefined)?.reason ?? '')

const READ_TOOLS = ['read', 'ls', 'glob', 'find', 'grep']
/** 已知的写/执行类，外加两个**认不出来**的名字 —— 后者才是真正的 fail-safe 检查。 */
const WRITE_TOOLS = ['write', 'edit', 'bash', 'powershell', 'str_replace_editor', 'mcp__filesystem__write_file']

async function main(): Promise<void> {
  console.log('── 只读模式：白名单之外一切都要拦 ──')
  for (const toolName of WRITE_TOOLS) {
    const result = await invoke({ mode: 'readonly', toolName, input: { path: 'x.txt', content: 'hi' } })
    check(
      `只读模式拦下 ${toolName}`,
      blocked(result) && /只读/.test(reason(result)),
      JSON.stringify(result.outcome)
    )
  }
  for (const toolName of READ_TOOLS) {
    const result = await invoke({ mode: 'readonly', toolName })
    check(`只读模式放行读类工具 ${toolName}`, !blocked(result), JSON.stringify(result.outcome))
  }
  {
    const result = await invoke({ mode: 'readonly', toolName: 'write', input: {} })
    check('只读模式**不问用户**（直接拦，不弹卡片）', result.requests.length === 0, String(result.requests.length))
  }

  console.log('\n── ask 模式：写类要问，读类不问 ──')
  for (const toolName of READ_TOOLS) {
    const result = await invoke({ mode: 'ask', toolName })
    check(`ask 模式不问读类工具 ${toolName}`, result.requests.length === 0, String(result.requests.length))
  }
  for (const toolName of ['write', 'edit', 'bash', 'powershell']) {
    const result = await invoke({ mode: 'ask', toolName, input: { path: 'x.txt' } })
    check(`ask 模式询问 ${toolName}`, result.requests.length === 1, String(result.requests.length))
    check(
      `询问 ${toolName} 时带上了工具名与风险等级`,
      result.requests[0]?.toolName === toolName && typeof result.requests[0]?.risk === 'string',
      JSON.stringify(result.requests[0])
    )
  }

  console.log('\n── 未知工具名按 write 处理（fail-safe 方向）──')
  for (const toolName of ['str_replace_editor', 'mcp__filesystem__write_file', 'some_new_tool']) {
    check(`riskOf('${toolName}') 是 write`, riskOf(toolName) === 'write', riskOf(toolName))
    const ask = await invoke({ mode: 'ask', toolName, input: {} })
    check(`ask 模式下未知工具 ${toolName} 也要问`, ask.requests.length === 1, String(ask.requests.length))
    const readonly = await invoke({ mode: 'readonly', toolName, input: {} })
    check(`只读模式下未知工具 ${toolName} 被拦`, blocked(readonly), JSON.stringify(readonly.outcome))
  }
  check('riskOf 对 bash 是 execute', riskOf('bash') === 'execute', riskOf('bash'))
  check('riskOf 对 read 是 read', riskOf('read') === 'read', riskOf('read'))

  console.log('\n── auto 模式：常规放行，危险命令仍要问 ──')
  {
    const result = await invoke({ mode: 'auto', toolName: 'write', input: { path: 'x.txt', content: 'hi' } })
    check('auto 模式不询问普通写操作', result.requests.length === 0, String(result.requests.length))
    check('auto 模式也不拦普通写操作', !blocked(result), JSON.stringify(result.outcome))
  }
  {
    const result = await invoke({ mode: 'auto', toolName: 'bash', input: { command: 'rm -fr /tmp/x' } })
    check('auto 模式询问危险命令', result.requests.length === 1, String(result.requests.length))
    check(
      '危险命令带上 danger 说明（卡片要显示给用户看）',
      typeof result.requests[0]?.danger === 'string' && result.requests[0].danger.length > 0,
      JSON.stringify(result.requests[0]?.danger)
    )
  }
  {
    const result = await invoke({ mode: 'readonly', toolName: 'bash', input: { command: 'rm -fr /tmp/x' } })
    check('只读模式对危险命令也是直接拦（不问）', blocked(result) && result.requests.length === 0, JSON.stringify(result.outcome))
  }

  console.log('\n── 裁决映射：允许 / 拒绝 ──')
  for (const decision of ['allow-once', 'allow-always'] as const) {
    const result = await invoke({ mode: 'ask', toolName: 'write', input: { path: 'x.txt' }, decide: decision })
    check(`${decision} → 不拦`, !blocked(result), JSON.stringify(result.outcome))
  }
  {
    const result = await invoke({ mode: 'ask', toolName: 'write', input: { path: 'x.txt' }, decide: 'deny' })
    check('deny → 拦下', blocked(result), JSON.stringify(result.outcome))
    /**
     * 拒绝的理由是**给模型看**的，不是只给用户看的「已拒绝」——
     * 它得让模型知道该换个办法（§7.5 在真实链路里验过这一点，这里钉住措辞契约）。
     */
    check(
      '拒绝理由是一句给模型的行动建议（而不是干巴巴的「已拒绝」）',
      /换一种方式|征得/.test(reason(result)) && /write/.test(reason(result)),
      reason(result)
    )
  }
  {
    const result = await invoke({ mode: 'ask', toolName: 'bash', input: { command: 'rm -fr /tmp/x' }, decide: 'deny' })
    check('拒绝危险命令时，理由里带上危险原因', /递归强制删除/.test(reason(result)), reason(result))
  }

  console.log('\n── 契约：预览抛异常不能影响审批 ──')
  {
    const result = await invoke({
      mode: 'ask',
      toolName: 'write',
      input: { path: 'x.txt', content: 'hi' },
      preview: () => {
        throw new Error('预览故意炸了')
      }
    })
    check('预览抛异常时，审批**照常**发出', result.requests.length === 1, String(result.requests.length))
    check(
      '预览抛异常时不带 previewDiff（降级为参数视图，而不是整个审批失败）',
      result.requests[0] !== undefined && result.requests[0].previewDiff === undefined,
      JSON.stringify(result.requests[0]?.previewDiff)
    )
    check('预览抛异常时工具仍然被放行（异常没有变成一次拒绝）', !blocked(result), JSON.stringify(result.outcome))
  }
  {
    const result = await invoke({
      mode: 'ask',
      toolName: 'write',
      input: { path: 'x.txt', content: 'hi' },
      preview: () => '文件：x.txt（整文件覆盖）\n\n+1 hi'
    })
    check('预览正常时原样带上（对照组，证明上一条不是因为预览被整个忽略）', typeof result.requests[0]?.previewDiff === 'string', JSON.stringify(result.requests[0]?.previewDiff))
  }

  console.log('\n── 请求里的 callId 与 approvalId ──')
  {
    const result = await invoke({ mode: 'ask', toolName: 'write', input: { path: 'x.txt' } })
    check('审批请求带上了 callId（与工具调用对得上）', result.requests[0]?.callId === 'call_write', JSON.stringify(result.requests[0]?.callId))
    check('审批请求带上了 approvalId', typeof result.requests[0]?.approvalId === 'string' && result.requests[0].approvalId.length > 0, JSON.stringify(result.requests[0]?.approvalId))
    check('审批请求带着原始参数（用户要能看清要改什么）', JSON.stringify(result.requests[0]?.args) === JSON.stringify({ path: 'x.txt' }), JSON.stringify(result.requests[0]?.args))
  }
}

await main()

console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
