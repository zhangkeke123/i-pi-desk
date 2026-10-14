import type { ExtensionAPI, ExtensionFactory } from '@earendil-works/pi-coding-agent'
import type { PermissionMode, ToolRisk } from '@i-pi-desk/shared'

/**
 * 权限闸门。
 *
 * 挂在 pi 的 `tool_call` 扩展事件上 —— 这是官方提供的「工具执行前可拦截」钩子
 * （`ToolCallEventResult.block`）。用它而不是包装每个工具的好处：
 *  - 拦截点只有一处，不会因为漏包了某个工具而留下后门；
 *  - 新增内置工具时自动被覆盖，不需要同步维护包装列表。
 *
 * 风险分级决定三档模式下的放行策略，见 docs/ARCHITECTURE.md 第 6 节。
 */

export interface ApprovalRequest {
  approvalId: string
  callId: string
  toolName: string
  args: unknown
  risk: ToolRisk
  /** 命中危险模式时给出的说明，UI 要显示给用户看。 */
  danger?: string
  /** 执行前的差异预览（仅 write / edit 有）。让用户看得到要改什么再决定。 */
  previewDiff?: string
}

export type ApprovalDecision = 'allow-once' | 'allow-always' | 'deny'

export interface ApprovalGateOptions {
  getMode: () => PermissionMode
  /** 把审批请求交给主进程，并异步等用户裁决。 */
  request: (request: ApprovalRequest) => Promise<ApprovalDecision>
  /**
   * 可选：在执行前算出差异预览。
   * 注入进来而不是直接 import，是为了让本文件不依赖 pi —— 闸门逻辑应当能被单独测试。
   */
  preview?: (toolName: string, args: unknown) => string | undefined
}

/** 工具 → 风险等级。认不出来的工具按 write 处理（宁可多问一次）。 */
const RISK_BY_TOOL: Record<string, ToolRisk> = {
  read: 'read',
  ls: 'read',
  glob: 'read',
  find: 'read',
  grep: 'read',
  write: 'write',
  edit: 'write',
  bash: 'execute',
  powershell: 'execute',
  webfetch: 'network',
  websearch: 'network'
}

/**
 * 明显破坏性的命令模式。
 *
 * 命中后**即使模式是 auto 也要问**。理由：`auto` 的语义是「信任常规操作」，
 * 不是「允许自我删除」。模型幻觉出一个 `rm -rf /` 的代价是不可逆的。
 */
const DANGEROUS_COMMAND_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  /**
   * 递归 + 强制删除：**与标志顺序、写法无关**。
   *
   * 第一版写成 `\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*f`，要求 `r` 必须出现在 `f` 之前，
   * 于是 `rm -fr ./x`、`rm -r -f ./x` 全都**漏掉** —— 而 `-fr` 是极常见的写法。
   * 也就是说那份「安全网」对两种最常见的等价写法是空的（`verify:danger-gate` 抓到的）。
   *
   * 两个前瞻各管一个标志，互不约束顺序：命令里只要同时出现「递归」和「强制」就算命中。
   * 限定在同一段（不含 `; & |`）内，避免跨命令误判。
   */
  {
    pattern: /\brm\b(?=[^;&|]*(?:^|\s)-[a-zA-Z-]*[rR])(?=[^;&|]*(?:^|\s)-[a-zA-Z-]*[fF])/,
    reason: '递归强制删除'
  },
  /** 删除根目录 / 家目录：同样不关心标志顺序（`rm -rf /` 与 `rm -fr /` 都要拦）。 */
  {
    pattern: /\brm\s+(?:-[a-zA-Z-]+\s+)+["']?(\/|~\/?|\$HOME|[A-Za-z]:\\)/,
    reason: '删除根目录或用户目录'
  },
  { pattern: /\bformat\s+[A-Za-z]:/i, reason: '格式化磁盘' },
  { pattern: /\bmkfs(\.\w+)?\b/, reason: '创建文件系统' },
  { pattern: /\bdd\s+.*of=\/dev\//, reason: '直接写裸设备' },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;/, reason: 'fork 炸弹' },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|)sh\b/, reason: '下载内容直接交给 shell 执行' },
  { pattern: /\bchmod\s+-R\s+777\s+\//, reason: '对根目录递归放开权限' },
  { pattern: />\s*\/dev\/sd[a-z]/, reason: '覆盖写入磁盘设备' },
  { pattern: /\bgit\s+push\b.*--force|\bgit\s+push\b.*\s-f\b/, reason: '强制推送覆盖远端历史' },
  { pattern: /\bnpm\s+(publish|unpublish)\b/, reason: '发布/撤回 npm 包' }
]

/** 从工具入参里抠出「值得审查的字符串」——目前只对 shell 类工具有意义。 */
function extractCommand(toolName: string, args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  const record = args as Record<string, unknown>
  if (toolName === 'bash' || toolName === 'powershell') {
    const command = record.command
    return typeof command === 'string' ? command : undefined
  }
  return undefined
}

function inspectDanger(toolName: string, args: unknown): string | undefined {
  const command = extractCommand(toolName, args)
  if (!command) return undefined
  for (const { pattern, reason } of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(command)) return reason
  }
  return undefined
}

/** 同一个工具 + 同一份参数只问一次（`allow-always` 之后）。 */
export function approvalFingerprint(toolName: string, args: unknown): string {
  let serialized: string
  try {
    serialized = JSON.stringify(args ?? null)
  } catch {
    serialized = String(args)
  }
  return `${toolName}:${serialized}`
}

export function riskOf(toolName: string): ToolRisk {
  return RISK_BY_TOOL[toolName] ?? 'write'
}

/**
 * 预览计算失败绝不能影响审批本身。
 *
 * 预览是「锦上添花」：它算不出来时用户照样能凭工具名和参数做判断；
 * 但如果让异常冒出去，审批就会变成一个被拒绝的操作 —— 那是拿可用性换装饰。
 */
function safePreview(
  options: ApprovalGateOptions,
  toolName: string,
  args: unknown
): string | undefined {
  if (!options.preview) return undefined
  try {
    return options.preview(toolName, args)
  } catch {
    return undefined
  }
}

export function createApprovalExtension(options: ApprovalGateOptions): ExtensionFactory {
  return (pi: ExtensionAPI): void => {
    pi.on('tool_call', async (event) => {
      const toolName = event.toolName
      const risk = riskOf(toolName)
      const mode = options.getMode()
      const danger = inspectDanger(toolName, event.input)

      // 只读模式：除读类工具外一律拒绝，不问。
      if (mode === 'readonly' && risk !== 'read') {
        return { block: true, reason: `当前是只读模式，已阻止 ${toolName} 执行` }
      }

      // 危险命令即使 auto 也要问 —— 见 DANGEROUS_COMMAND_PATTERNS 的注释。
      if (!danger) {
        if (risk === 'read') return
        if (mode === 'auto') return
      }

      const decision = await options.request({
        approvalId: `${event.toolCallId}:${Date.now()}`,
        callId: event.toolCallId,
        toolName,
        args: event.input,
        risk,
        danger,
        previewDiff: safePreview(options, toolName, event.input)
      })

      if (decision === 'deny') {
        return {
          block: true,
          // 这句会作为工具结果回给模型，所以要写成模型能理解、并会改变策略的话，
          // 而不是只给用户看的「已拒绝」。
          reason: `用户拒绝执行 ${toolName}${danger ? `（原因：${danger}）` : ''}。请换一种方式，或先征得用户同意。`
        }
      }

      return undefined
    })
  }
}
