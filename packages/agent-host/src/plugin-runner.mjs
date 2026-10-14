/**
 * 插件进程的运行器（launcher）。
 *
 * 它由 agent-host 拉起，**不是**插件作者写的代码 —— 这一点很关键：
 * 插件作者只需要导出一个普通 ESM 模块，不用关心 stdio 协议、不用手写 JSON 帧。
 *
 * ## 协议（stdio 上的 NDJSON）
 *
 * 父 → 子：
 *   { id, method: 'activate',   params: { pluginId, pluginDir, permissions } }
 *   { id, method: 'tool.call',  params: { tool, args, callId, cwd } }
 *   { id, method: 'deactivate' }
 *
 * 子 → 父：
 *   { id, result } | { id, error: { code, message } }
 *   { method: 'log', params: { level, message } }      // 单向通知
 *
 * ## 插件模块契约
 *
 * ```js
 * export async function activate(ctx) {}
 * export async function deactivate() {}
 * export const tools = {
 *   async my_tool(args, ctx) { return '文本结果' | { content, isError } }
 * }
 * ```
 *
 * ## 为什么用 `console` 重定向而不是禁止它
 *
 * 插件作者一定会 `console.log`，而 **stdout 是协议流**。与其指望作者记住「别用 stdout」，
 * 不如在运行器里把 `console` 重定向成 `log` 通知 —— 这样作者写 console.log 是安全的，
 * 而协议流永远不会被污染。这是「让正确的做法成为默认」而不是「靠文档约束」。
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'
import { isAbsolute, resolve } from 'node:path'

const requireFromPlugin = createRequire(import.meta.url)

/** 写一帧到 stdout。必须整行一次性写出，分片会被对面当成两帧。 */
function writeFrame(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

function writeResult(id, result) {
  writeFrame({ id, result: result === undefined ? null : result })
}

function writeError(id, code, message) {
  writeFrame({ id, error: { code, message } })
}

function log(level, message) {
  // 注意：日志走**协议里的通知**而不是 stderr。父进程要能区分
  // 「插件的日志」与「插件进程崩溃时的 Node 报错」，走通知更清晰。
  writeFrame({ method: 'log', params: { level, message: String(message).slice(0, 4000) } })
}

/** 把 console 接到 log 通知上，避免插件误写 stdout 污染协议流。 */
function redirectConsole() {
  const forward = (level) => (...args) => {
    log(level, args.map((value) => (typeof value === 'string' ? value : safeStringify(value))).join(' '))
  }
  console.log = forward('info')
  console.info = forward('info')
  console.warn = forward('warn')
  console.error = forward('error')
  console.debug = forward('debug')
}

function safeStringify(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** 当前已加载的插件模块。 */
let pluginModule = null
let pluginContext = null

/**
 * 传给插件的上下文。
 *
 * 刻意**很小**：只给插件真正需要的东西。尤其**不**暴露应用的数据目录、
 * provider 密钥、以及任何「读取宿主配置」的入口 —— 插件是被信任的代码，
 * 但没必要把它不需要的能力也递过去。
 */
function createContext(info) {
  return {
    pluginId: info.pluginId,
    pluginDir: info.pluginDir,
    /**
     * 已声明的权限。
     *
     * 它是**声明**而不是**能力开关** —— 插件进程本身拥有完整 Node 能力，
     * 我们不假装能用它拦住什么。它的用途是让插件自己按声明做事，
     * 以及让宿主在日志/审计里知道这次调用涉及哪些能力。
     */
    permissions: info.permissions ?? [],
    log: (message) => log('info', message),
    warn: (message) => log('warn', message),
    /** 读环境变量：**只有白名单里的**才给，见 agent-host 侧的 env 构造。 */
    env: (name) => process.env[name],
    require: requireFromPlugin
  }
}

async function handleActivate(id, params) {
  const pluginDir = params?.pluginDir
  const main = params?.main
  if (typeof pluginDir !== 'string' || typeof main !== 'string') {
    writeError(id, 'INVALID_PARAMS', 'activate 需要 pluginDir 与 main')
    return
  }

  pluginContext = createContext(params)
  const entry = isAbsolute(main) ? main : resolve(pluginDir, main)

  try {
    pluginModule = await import(pathToFileURL(entry).href)
  } catch (error) {
    writeError(id, 'IMPORT_FAILED', error instanceof Error ? error.message : String(error))
    return
  }

  if (typeof pluginModule.activate === 'function') {
    try {
      await pluginModule.activate(pluginContext)
    } catch (error) {
      writeError(id, 'ACTIVATE_FAILED', error instanceof Error ? error.message : String(error))
      return
    }
  }

  const toolNames = pluginModule.tools && typeof pluginModule.tools === 'object' ? Object.keys(pluginModule.tools) : []
  writeResult(id, { activated: true, tools: toolNames, hasDeactivate: typeof pluginModule.deactivate === 'function' })
}

/** 工具返回值归一：字符串、对象、或 `{ content, isError }` 都接受。 */
function normalizeToolResult(value) {
  if (typeof value === 'string') return { content: value, isError: false }
  if (value === undefined || value === null) return { content: '', isError: false }
  if (typeof value === 'object' && typeof value.content === 'string') {
    return { content: value.content, isError: value.isError === true }
  }
  return { content: safeStringify(value), isError: false }
}

async function handleToolCall(id, params) {
  const toolName = params?.tool
  if (typeof toolName !== 'string') {
    writeError(id, 'INVALID_PARAMS', 'tool.call 需要 tool')
    return
  }
  if (!pluginModule) {
    writeError(id, 'NOT_ACTIVATED', '插件尚未激活')
    return
  }
  const impl = pluginModule.tools?.[toolName]
  if (typeof impl !== 'function') {
    writeError(id, 'TOOL_NOT_FOUND', `插件没有实现工具：${toolName}`)
    return
  }

  try {
    const result = await impl(params.args ?? {}, { ...pluginContext, cwd: params.cwd })
    writeResult(id, normalizeToolResult(result))
  } catch (error) {
    // 工具抛错不该杀掉插件进程 —— 一次失败的调用与「插件坏了」是两件事。
    writeResult(id, { content: error instanceof Error ? error.message : String(error), isError: true })
  }
}

async function handleDeactivate(id) {
  try {
    if (typeof pluginModule?.deactivate === 'function') await pluginModule.deactivate()
  } catch (error) {
    log('warn', `deactivate 抛错：${error instanceof Error ? error.message : String(error)}`)
  }
  pluginModule = null
  writeResult(id, { deactivated: true })
}

async function handle(frame) {
  switch (frame.method) {
    case 'activate':
      return handleActivate(frame.id, frame.params)
    case 'tool.call':
      return handleToolCall(frame.id, frame.params)
    case 'deactivate':
      return handleDeactivate(frame.id)
    default:
      writeError(frame.id, 'METHOD_NOT_FOUND', `不支持的方法：${String(frame.method)}`)
  }
}

redirectConsole()

const reader = createInterface({ input: process.stdin })
reader.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let frame
  try {
    frame = JSON.parse(trimmed)
  } catch {
    log('error', `无法解析父进程的帧：${trimmed.slice(0, 200)}`)
    return
  }
  // 不 await：工具调用可以并发，协议本身靠 id 关联。
  void handle(frame).catch((error) => {
    writeError(frame?.id ?? '?', 'INTERNAL', error instanceof Error ? error.message : String(error))
  })
})

reader.on('close', () => {
  // 父进程关掉 stdin = 让我们退出。不主动 exit 会留下孤儿子进程。
  void handleDeactivate('-1').finally(() => process.exit(0))
})

