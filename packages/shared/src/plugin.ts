/**
 * 插件 manifest 的契约与校验器。
 *
 * ## 为什么校验器放在 shared
 *
 * 它有两个使用者：**主进程**（安装时校验，决定要不要收下这个插件）与
 * **agent-host**（激活时再校验一次，因为磁盘上的东西可能被手改过）。
 * 两处各写一份必然漂移，而漂移的表现是「装得上但载不动」或者更糟 ——
 * 「装的时候说不需要网络权限，跑的时候却在联网」。
 *
 * ## 权限声明的诚实性
 *
 * 插件是**独立 Node 子进程**，拥有与应用同级的操作系统权限。我们**没有** OS 级沙箱
 * （上游也没有）。所以 `permissions` 不是一道技术防线，而是：
 *
 *  1. **知情同意的载体** —— 安装时的确认界面读的就是它；
 *  2. **能力审计的依据** —— 用户能看见「这个插件要联网」。
 *
 * 由此推出一条硬要求：**未知权限必须报错，不能静默忽略**。
 * 静默忽略会让确认界面少列一项，用户就在信息不全的情况下点了同意 ——
 * 那比没有权限声明更糟，因为它制造了虚假的安全感。
 */

/** 当前支持的 manifest 版本。不匹配直接拒绝，不做兼容猜测。 */
export const PLUGIN_SCHEMA_VERSION = 1

/**
 * 允许声明的权限。
 *
 * 粒度刻意保持在「能力」这一层，不做 `fs.read:./src/**` 这种范围表达式 ——
 * 没有沙箱的情况下，范围校验只是装饰。宁可少承诺，也不给一个做不到的保证。
 */
export const PLUGIN_PERMISSIONS = [
  'agent.tool.register',
  'fs.read',
  'fs.write',
  'net',
  'process.spawn'
] as const

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number]

export const PLUGIN_PERMISSION_LABELS: Record<PluginPermission, string> = {
  'agent.tool.register': '向 agent 注册工具',
  'fs.read': '读取本机文件',
  'fs.write': '写入本机文件',
  net: '访问网络',
  'process.spawn': '启动其它进程'
}

/** 工具参数用 JSON Schema 描述（pi 用 typebox，但 manifest 里只放 JSON，避免耦合实现）。 */
export interface PluginToolParameterSchema {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
}

export interface PluginToolContribution {
  /** 工具名。会直接暴露给模型，所以必须稳定且可读。 */
  name: string
  description: string
  parameters?: PluginToolParameterSchema
}

export interface PluginManifest {
  schemaVersion: number
  /** 反向域名风格，如 `acme.review-helper`。 */
  id: string
  name: string
  version: string
  description?: string
  author?: string
  /** 相对插件目录的入口文件（ESM 模块）。 */
  main: string
  permissions?: PluginPermission[]
  contributes?: {
    agentTools?: PluginToolContribution[]
    /** 相对插件目录的技能目录；其下的 `SKILL.md` 会被并入 agent 的技能。 */
    skills?: string[]
  }
}

export interface PluginManifestError {
  path: string
  message: string
}

export type PluginManifestValidation =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; errors: PluginManifestError[] }

/** 插件 id：小写字母/数字/连字符，点号分段（反向域名风格）。 */
const PLUGIN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/
/** 工具名：pi 的工具名用小写字母/数字/下划线/连字符。 */
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/

/**
 * 内置工具名（保留）。
 *
 * 插件**不得**占用这些名字。原因不是「会报错」，恰恰相反 —— 同名工具会被静默覆盖
 * （注册优先级：扩展 > customTools > 内置）。于是一个插件只要声明 `bash`，
 * 就能在用户毫不知情的情况下替换掉真正执行命令的那个工具。
 * 这是安全相关的命名空间冲突，必须在安装时拦住，而不是运行时任其覆盖。
 */
export const RESERVED_TOOL_NAMES = [
  'read',
  'write',
  'edit',
  'bash',
  'powershell',
  'grep',
  'find',
  'ls'
] as const
const MAX_ID_LENGTH = 64
const MAX_TOOL_NAME_LENGTH = 48
const MAX_DESCRIPTION_LENGTH = 1024

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 校验一个 manifest。
 *
 * 返回**全部**错误而不是遇错即停：安装界面需要一次把问题列清楚，
 * 让作者一轮就能改完，而不是改一个报一个。
 */
export function validatePluginManifest(input: unknown): PluginManifestValidation {
  const errors: PluginManifestError[] = []

  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path: '', message: 'manifest 必须是一个 JSON 对象' }] }
  }

  if (input.schemaVersion !== PLUGIN_SCHEMA_VERSION) {
    errors.push({
      path: 'schemaVersion',
      message: `需要 ${PLUGIN_SCHEMA_VERSION}，实际是 ${JSON.stringify(input.schemaVersion)}`
    })
  }

  const id = input.id
  if (typeof id !== 'string' || id.length === 0) {
    errors.push({ path: 'id', message: '必填' })
  } else if (id.length > MAX_ID_LENGTH || !PLUGIN_ID_PATTERN.test(id)) {
    errors.push({
      path: 'id',
      message: `只能用小写字母、数字、连字符与点号分段，且不能以连字符开头/结尾（≤${MAX_ID_LENGTH} 字符）：${id}`
    })
  }

  for (const field of ['name', 'version'] as const) {
    const value = input[field]
    if (typeof value !== 'string' || value.trim().length === 0) {
      errors.push({ path: field, message: '必填且不能为空' })
    }
  }

  const main = input.main
  if (typeof main !== 'string' || main.trim().length === 0) {
    errors.push({ path: 'main', message: '必填（相对插件目录的入口文件）' })
  } else if (!/\.(mjs|cjs|js)$/i.test(main)) {
    errors.push({ path: 'main', message: `入口必须是 .js / .mjs / .cjs 文件：${main}` })
  } else if (main.includes('..') || main.startsWith('/') || /^[A-Za-z]:/.test(main)) {
    // 入口路径逃逸：插件目录之外的文件不该被当作插件加载。
    errors.push({ path: 'main', message: `入口必须是插件目录内的相对路径：${main}` })
  }

  const permissions = input.permissions
  if (permissions !== undefined) {
    if (!Array.isArray(permissions)) {
      errors.push({ path: 'permissions', message: '必须是数组' })
    } else {
      for (const [index, permission] of permissions.entries()) {
        if (typeof permission !== 'string' || !(PLUGIN_PERMISSIONS as readonly string[]).includes(permission)) {
          errors.push({
            path: `permissions[${index}]`,
            message: `未知权限 ${JSON.stringify(permission)}；允许的取值：${PLUGIN_PERMISSIONS.join(', ')}`
          })
        }
      }
    }
  }

  const contributes = input.contributes
  if (contributes !== undefined) {
    if (!isPlainObject(contributes)) {
      errors.push({ path: 'contributes', message: '必须是对象' })
    } else {
      validateTools(contributes.agentTools, errors)
      validateSkillDirs(contributes.skills, errors)
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  const manifest: PluginManifest = {
    schemaVersion: PLUGIN_SCHEMA_VERSION,
    id: id as string,
    name: input.name as string,
    version: input.version as string,
    main: main as string
  }
  if (typeof input.description === 'string') manifest.description = input.description
  if (typeof input.author === 'string') manifest.author = input.author
  if (Array.isArray(permissions)) manifest.permissions = permissions as PluginPermission[]
  if (isPlainObject(contributes)) {
    const normalized: NonNullable<PluginManifest['contributes']> = {}
    if (Array.isArray(contributes.agentTools)) {
      normalized.agentTools = contributes.agentTools as PluginToolContribution[]
    }
    if (Array.isArray(contributes.skills)) normalized.skills = contributes.skills as string[]
    manifest.contributes = normalized
  }
  return { ok: true, manifest }
}

function validateTools(value: unknown, errors: PluginManifestError[]): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    errors.push({ path: 'contributes.agentTools', message: '必须是数组' })
    return
  }

  const seen = new Set<string>()
  for (const [index, tool] of value.entries()) {
    const path = `contributes.agentTools[${index}]`
    if (!isPlainObject(tool)) {
      errors.push({ path, message: '必须是对象' })
      continue
    }

    const name = tool.name
    if (typeof name !== 'string' || name.length === 0) {
      errors.push({ path: `${path}.name`, message: '必填' })
    } else if (name.length > MAX_TOOL_NAME_LENGTH || !TOOL_NAME_PATTERN.test(name)) {
      errors.push({
        path: `${path}.name`,
        message: `工具名必须以小写字母开头，只含小写字母/数字/下划线/连字符（≤${MAX_TOOL_NAME_LENGTH}）：${name}`
      })
    } else if ((RESERVED_TOOL_NAMES as readonly string[]).includes(name)) {
      errors.push({
        path: `${path}.name`,
        message: `不得占用内置工具名 ${name} —— 同名会静默替换掉内置工具`
      })
    } else if (seen.has(name)) {
      // 重名工具会让模型的选择变得不确定，也让注册结果依赖顺序。
      errors.push({ path: `${path}.name`, message: `同一个插件内工具名重复：${name}` })
    } else {
      seen.add(name)
    }

    const description = tool.description
    if (typeof description !== 'string' || description.trim().length === 0) {
      errors.push({ path: `${path}.description`, message: '必填（模型靠它决定何时调用）' })
    } else if (description.length > MAX_DESCRIPTION_LENGTH) {
      errors.push({ path: `${path}.description`, message: `描述过长（≤${MAX_DESCRIPTION_LENGTH} 字符）` })
    }

    if (tool.parameters !== undefined && !isPlainObject(tool.parameters)) {
      errors.push({ path: `${path}.parameters`, message: '必须是对象（JSON Schema）' })
    }
  }
}

function validateSkillDirs(value: unknown, errors: PluginManifestError[]): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    errors.push({ path: 'contributes.skills', message: '必须是数组' })
    return
  }
  for (const [index, dir] of value.entries()) {
    const path = `contributes.skills[${index}]`
    if (typeof dir !== 'string' || dir.trim().length === 0) {
      errors.push({ path, message: '必须是非空字符串' })
      continue
    }
    if (dir.includes('..') || dir.startsWith('/') || /^[A-Za-z]:/.test(dir)) {
      errors.push({ path, message: `必须是插件目录内的相对路径：${dir}` })
    }
  }
}

// ───────────────────────────── 运行期视图（给 UI） ─────────────────────────────

export interface PluginView {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  /** 插件目录的绝对路径。 */
  dir: string
  enabled: boolean
  permissions: PluginPermission[]
  /** 声明贡献的 agent 工具名。 */
  tools: string[]
  /** 声明贡献的技能目录。 */
  skillDirs: string[]
  /** manifest 校验失败或加载失败的原因；有值时插件不会被激活。 */
  loadError?: string
}
