import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { FileMutationResult, FilePreview, FileWriteResult, FsEntry } from '@i-pi-desk/shared'

/**
 * 工作区文件读取（只读）。
 *
 * 这是「Renderer 不碰 fs」这条不变式的落地处：渲染层只能请求「工作区内的某个相对路径」，
 * 由这里把它翻译成绝对路径。**渲染层永远拿不到绝对路径**，因此也无法用它去读工作区之外的东西。
 *
 * 三条必须守住的线：
 *  1. **越界防御**：`..` 逃逸、绝对路径、以及**符号链接击穿**都必须拦住。
 *     只做字符串前缀判断是不够的 —— 工作区里一个指向 `C:\Users\me\.ssh` 的软链就能绕过它。
 *  2. **读取上限**：预览是给人看的，不该因为点了一个 2GB 的日志文件把主进程读爆。
 *  3. **二进制识别**：与其把二进制显示成乱码，不如明确告诉 UI「不支持预览」。
 */

/** 单次列目录的最大条目数。超过就截断，UI 会提示。 */
const MAX_ENTRIES = 3000
/** 预览读取上限。超过就截断并标记 truncated。 */
const MAX_PREVIEW_BYTES = 512 * 1024
/** 单次写入上限。用户手写的文本远超这个数说明用途不对，挡住比事后救火好。 */
const MAX_WRITE_BYTES = 8 * 1024 * 1024
/** 用于判断二进制的前导字节数。 */
const SNIFF_BYTES = 8192

/** 版本标记：mtime + size。见 FilePreview.revision 的注释。 */
function revisionOf(stats: { mtimeMs: number; size: number }): string {
  return `${stats.mtimeMs}:${stats.size}`
}

export class FsAccessError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'FsAccessError'
    this.code = code
  }
}

/**
 * 把工作区内的相对路径解析成绝对路径，并确保它**真的**在工作区内。
 *
 * 实现要点：对已存在的路径直接 `realpathSync`；对不存在的路径，对**父目录**做
 * `realpathSync` 再拼上文件名。这样即使中间层级有软链，比较的也是解链后的真实位置。
 */
export function resolveInWorkspace(workspaceRoot: string, relativePath: string): string {
  const raw = (relativePath ?? '').replace(/\\/g, '/').trim()

  if (isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) {
    throw new FsAccessError('FORBIDDEN', '不接受绝对路径，请使用工作区内的相对路径')
  }
  if (raw.split('/').includes('..')) {
    throw new FsAccessError('FORBIDDEN', '路径不允许包含 ..')
  }

  let realRoot: string
  try {
    realRoot = realpathSync(workspaceRoot)
  } catch {
    throw new FsAccessError('WORKSPACE_NOT_FOUND', `工作区目录不可访问: ${workspaceRoot}`)
  }

  const absolute = resolve(realRoot, raw)

  // 解链后再比较，这是拦「软链逃逸」的关键一步。
  let resolved: string
  try {
    resolved = realpathSync(absolute)
  } catch {
    try {
      resolved = join(realpathSync(dirname(absolute)), basename(absolute))
    } catch {
      throw new FsAccessError('NOT_FOUND', `路径不存在: ${raw || '.'}`)
    }
  }

  const rel = relative(realRoot, resolved)
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new FsAccessError('FORBIDDEN', '路径越出工作区范围')
  }
  return resolved
}

/**
 * 把绝对路径转回工作区内的相对路径（统一用 `/`）。
 */
function toRelative(workspaceRoot: string, absolute: string): string {
  const rel = relative(realpathSync(workspaceRoot), absolute)
  return rel.split(sep).join('/')
}

// ───────────────────────────── 文件树操作 ─────────────────────────────

/**
 * 新建文件。
 *
 * **父目录必须已存在**（见 `FileCreateInput` 的说明）：`resolveInWorkspace` 会对不存在的
 * 路径去 realpath 它的父目录，父目录不存在就直接抛 NOT_FOUND —— 这个行为正是我们要的，
 * 它让「一边创建多层目录一边校验」那条容易写错的路径暂时不必存在。
 */
export function createFileInWorkspace(
  workspaceRoot: string,
  relativePath: string,
  text = ''
): { path: string } {
  const trimmed = (relativePath ?? '').trim()
  if (trimmed.length === 0) {
    throw new FsAccessError('INVALID_PATH', '请给出文件名')
  }

  const absolute = resolveInWorkspace(workspaceRoot, trimmed)
  if (existsSync(absolute)) {
    throw new FsAccessError('ALREADY_EXISTS', `已存在同名文件或目录: ${trimmed}`)
  }

  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_WRITE_BYTES) {
    throw new FsAccessError('TOO_LARGE', `初始内容超过 ${Math.round(MAX_WRITE_BYTES / 1024 / 1024)} MB 上限`)
  }

  // `flag: 'wx'` = 只在文件不存在时创建。前面已经查过一次，但那是「检查后使用」，
  // 两次之间可能有别人创建了同名文件；用 wx 让内核来保证原子性。
  try {
    writeFileSync(absolute, text, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'EEXIST') {
      throw new FsAccessError('ALREADY_EXISTS', `已存在同名文件或目录: ${trimmed}`)
    }
    throw new FsAccessError('WRITE_FAILED', `新建文件失败: ${(error as Error).message}`)
  }

  return { path: toRelative(workspaceRoot, absolute) }
}

/**
 * 同目录改名。
 *
 * ## 三个必须显式处理的点
 *
 * **一、`newName` 必须是单个名字。** 含 `/`、`\`、或等于 `.` / `..` 一律拒绝。
 * 否则「改名」就变成了「移动到任意位置」，而目标目录完全没有经过工作区校验。
 * 跨目录移动要单独做，并带上目标目录的校验。
 *
 * **二、目标已存在时拒绝，而不是覆盖。** `renameSync` 在 POSIX 上会**静默覆盖**同名文件 ——
 * 用户改个名字却弄丢了另一个文件，这是不可接受的。Windows 上它虽然会报错，
 * 但两个平台行为不一致本身也是问题，所以显式查一次。
 *
 * **三、把工作区根目录本身挡住。** 根目录的父路径在工作区之外，改名它会毁掉整个工作区。
 */
export function renameInWorkspace(
  workspaceRoot: string,
  relativePath: string,
  newName: string
): { path: string; previousPath: string } {
  const name = (newName ?? '').trim()
  if (name.length === 0) {
    throw new FsAccessError('INVALID_NAME', '新名称不能为空')
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new FsAccessError('INVALID_NAME', '新名称不能包含路径分隔符（当前只支持同目录改名）')
  }
  if (name === '.' || name === '..') {
    throw new FsAccessError('INVALID_NAME', `非法的名称: ${name}`)
  }

  const source = resolveInWorkspace(workspaceRoot, relativePath)
  const realRoot = realpathSync(workspaceRoot)
  if (source === realRoot) {
    throw new FsAccessError('FORBIDDEN', '不能重命名工作区根目录')
  }
  if (!existsSync(source)) {
    throw new FsAccessError('NOT_FOUND', `路径不存在: ${relativePath}`)
  }

  const target = join(dirname(source), name)
  if (existsSync(target)) {
    throw new FsAccessError('ALREADY_EXISTS', `已存在同名文件或目录: ${name}`)
  }

  try {
    renameSync(source, target)
  } catch (error) {
    throw new FsAccessError('RENAME_FAILED', `重命名失败: ${(error as Error).message}`)
  }

  return { path: toRelative(workspaceRoot, target), previousPath: toRelative(workspaceRoot, source) }
}

/**
 * 跨目录移动（保持名字不变，只换父目录）。
 *
 * 这是 `renameInWorkspace` 注释里说的「要单独做」的那件事：
 * 改名只换名字、父目录不变，所以目标目录天然是合法的；
 * 而移动**换的正是父目录**，于是目标目录也必须完整过一遍工作区校验。
 *
 * ## 四个新增的坑（都是移动独有的）
 *
 * **一、目标目录也要过越界校验。** 否则「移动到 `../../`」就成了绕过读取防护的写入原语。
 *
 * **二、不能把目录移进它自己的子孙里。** 例如把 `src` 移到 `src/lib` 下 ——
 * 文件系统层面会失败，但更糟的情况是某些实现会先建链接再递归，结果
 * **整棵子树从工作区里「消失」**（实际还在，但按路径已不可达）。所以显式挡住。
 * 比较用 `realpath`，避免软链绕过。
 *
 * **三、不能覆盖目标。** 与改名同理：`renameSync` 在 POSIX 上会静默覆盖同名文件。
 *
 * **四、源与目标相同要报错，而不是当成成功。** 用户点击「移到这里」停在原目录时，
 * 报「已在这里」比假装成功更能说明发生了什么。
 */
export function moveInWorkspace(
  workspaceRoot: string,
  relativePath: string,
  targetDir: string
): { path: string; previousPath: string } {
  const source = resolveInWorkspace(workspaceRoot, relativePath)
  const realRoot = realpathSync(workspaceRoot)
  if (source === realRoot) {
    throw new FsAccessError('FORBIDDEN', '不能移动工作区根目录')
  }
  if (!existsSync(source)) {
    throw new FsAccessError('NOT_FOUND', `路径不存在: ${relativePath}`)
  }

  // 空字符串表示工作区根目录，这是合法的目标。
  const directory = resolveInWorkspace(workspaceRoot, (targetDir ?? '').trim())
  if (!existsSync(directory)) {
    throw new FsAccessError('NOT_FOUND', `目标目录不存在: ${targetDir}`)
  }
  if (!statSync(directory).isDirectory()) {
    throw new FsAccessError('NOT_A_DIRECTORY', `目标不是目录: ${targetDir}`)
  }

  const target = join(directory, basename(source))
  if (target === source) {
    throw new FsAccessError('INVALID_PATH', '源与目标相同（已经在这个目录里了）')
  }
  if (existsSync(target)) {
    throw new FsAccessError('ALREADY_EXISTS', `目标目录里已有同名文件或目录: ${basename(source)}`)
  }

  // 子孙检查放在「覆盖检查」之后：先给用户最直接的那个原因。
  const realSource = realpathSync(source)
  const realDirectory = realpathSync(directory)
  if (realDirectory === realSource || realDirectory.startsWith(realSource + sep)) {
    throw new FsAccessError('FORBIDDEN', '不能把目录移动到它自己的子目录里')
  }

  try {
    renameSync(source, target)
  } catch (error) {
    throw new FsAccessError('MOVE_FAILED', `移动失败: ${(error as Error).message}`)
  }

  return { path: toRelative(workspaceRoot, target), previousPath: toRelative(workspaceRoot, source) }
}

/**
 * 删除（交给调用方决定「怎么删」）。
 *
 * ## 为什么把删除动作作为参数传进来
 *
 * 真正想要的语义是「移到系统回收站」，而它需要 Electron 的 `shell`。
 * 一旦在本文件 import electron，这个模块就**没法用 node 直接跑测试了**
 * （`verify-workspace-fs.ts` 正是这么跑的）—— 而这里恰好是最需要测试的地方。
 *
 * 所以把动作作为参数注入：生产代码传 `shell.trashItem`，测试传一个记录调用的假实现。
 * 校验逻辑（越界、根目录、存在性）留在本文件里，因为那才是要测的东西。
 */
export async function removeInWorkspace(
  workspaceRoot: string,
  relativePath: string,
  trash: (absolutePath: string) => Promise<void>
): Promise<{ path: string }> {
  const trimmed = (relativePath ?? '').trim()
  if (trimmed.length === 0) {
    throw new FsAccessError('INVALID_PATH', '不能删除工作区根目录')
  }

  const absolute = resolveInWorkspace(workspaceRoot, trimmed)
  const realRoot = realpathSync(workspaceRoot)
  // 双保险：形状校验之外再比一次解链后的绝对路径。
  if (absolute === realRoot) {
    throw new FsAccessError('FORBIDDEN', '不能删除工作区根目录')
  }
  if (!existsSync(absolute)) {
    throw new FsAccessError('NOT_FOUND', `路径不存在: ${trimmed}`)
  }

  try {
    await trash(absolute)
  } catch (error) {
    throw new FsAccessError('REMOVE_FAILED', `删除失败: ${(error as Error).message}`)
  }

  return { path: toRelative(workspaceRoot, absolute) }
}

export interface ListResult {
  entries: FsEntry[]
  truncated: boolean
}

export function listDirectory(workspaceRoot: string, relativePath = ''): ListResult {
  const absolute = resolveInWorkspace(workspaceRoot, relativePath)

  let stats
  try {
    stats = statSync(absolute)
  } catch {
    throw new FsAccessError('NOT_FOUND', `路径不存在: ${relativePath || '.'}`)
  }
  if (!stats.isDirectory()) {
    throw new FsAccessError('NOT_A_DIRECTORY', `不是目录: ${relativePath}`)
  }

  const dirents = readdirSync(absolute, { withFileTypes: true })

  const entries: FsEntry[] = []
  for (const dirent of dirents) {
    // 只列文件和目录，跳过 socket / fifo / 设备节点这类没有浏览意义的东西。
    const kind: FsEntry['kind'] | null = dirent.isDirectory()
      ? 'directory'
      : dirent.isFile()
        ? 'file'
        : null
    if (!kind) continue

    const childAbsolute = join(absolute, dirent.name)
    entries.push({
      name: dirent.name,
      path: toRelative(workspaceRoot, childAbsolute),
      kind
    })
  }

  // 目录在前、同类按名字排序 —— 文件树的可预期顺序比「文件系统返回顺序」重要得多。
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-CN')
  })

  const truncated = entries.length > MAX_ENTRIES
  return { entries: truncated ? entries.slice(0, MAX_ENTRIES) : entries, truncated }
}

export function readFilePreview(workspaceRoot: string, relativePath: string): FilePreview {
  const absolute = resolveInWorkspace(workspaceRoot, relativePath)

  const stats = statSync(absolute)
  if (stats.isDirectory()) {
    throw new FsAccessError('IS_A_DIRECTORY', `这是一个目录: ${relativePath}`)
  }

  const bytes = stats.size
  const toRead = Math.min(bytes, MAX_PREVIEW_BYTES)

  const fd = openSync(absolute, 'r')
  try {
    const buffer = Buffer.alloc(toRead)
    const readBytes = readSync(fd, buffer, 0, toRead, 0)

    const head = buffer.subarray(0, Math.min(readBytes, SNIFF_BYTES))
    // NUL 字节是二进制最可靠的信号；文本文件里几乎不会出现。
    const binary = head.includes(0)
    const truncated = bytes > readBytes

    const preview: FilePreview = {
      path: toRelative(workspaceRoot, absolute),
      text: binary ? '' : buffer.subarray(0, readBytes).toString('utf8'),
      bytes,
      truncated,
      binary,
      revision: revisionOf(stats)
    }

    /**
     * 只读的两条理由，都是**防数据丢失**而不是保守：
     *  - 截断：把读到的前 512KB 存回去，原文件剩下的部分就永久没了。
     *  - 二进制：以 utf8 解码再编码必然损坏字节序列。
     */
    if (binary) preview.readOnlyReason = '这是二进制文件，不支持编辑'
    else if (truncated) {
      preview.readOnlyReason = `文件超过 ${Math.round(MAX_PREVIEW_BYTES / 1024)} KB 预览上限，为避免保存时截断原文件，只读打开`
    }

    return preview
  } finally {
    closeSync(fd)
  }
}

/**
 * 在工作区内写入文本文件。
 *
 * ## 为什么需要 expectedRevision
 *
 * 用户手改文件的同时，**agent 可能正在改同一个文件**（这是这个产品的常态，不是边缘情况）。
 * 没有这层校验，用户点保存就会静默覆盖掉 agent 刚写的改动 —— 而且两边都不会有任何提示。
 *
 * ## 为什么保留原换行风格
 *
 * HTML `<textarea>` 会把内容里的 `\r\n` 归一成 `\n`。直接存回去，
 * 一个 CRLF 文件会变成整文件 diff（几万行全变），在 git 里看就是灾难。
 * 所以按原文件的风格把换行补回去。
 *
 * 写入是**原子的**（临时文件 + rename）：写到一半崩掉不会留下半个文件，
 * 那对源码来说比不保存更糟。
 */
export function writeFileInWorkspace(
  workspaceRoot: string,
  relativePath: string,
  text: string,
  expectedRevision: string | null
): FileWriteResult {
  if (typeof text !== 'string') {
    throw new FsAccessError('INVALID_CONTENT', '写入内容必须是字符串')
  }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_WRITE_BYTES) {
    throw new FsAccessError('TOO_LARGE', `写入内容超过 ${Math.round(MAX_WRITE_BYTES / 1024 / 1024)} MB 上限（${bytes} 字节）`)
  }

  const absolute = resolveInWorkspace(workspaceRoot, relativePath)

  let stats: ReturnType<typeof statSync> | null = null
  try {
    stats = statSync(absolute)
  } catch {
    stats = null
  }

  if (stats?.isDirectory()) {
    throw new FsAccessError('IS_A_DIRECTORY', `这是一个目录: ${relativePath}`)
  }

  if (expectedRevision === null) {
    // 新建：路径必须还不存在，否则说明 UI 的意图与磁盘状态对不上，宁可拒绝。
    if (stats) {
      throw new FsAccessError('ALREADY_EXISTS', `文件已存在: ${relativePath}`)
    }
  } else {
    if (!stats) {
      throw new FsAccessError('NOT_FOUND', `文件已不存在（可能被删除或重命名）: ${relativePath}`)
    }
    const current = revisionOf(stats)
    if (current !== expectedRevision) {
      throw new FsAccessError(
        'STALE_WRITE',
        '文件已被外部修改（很可能是 agent 刚改过），为避免覆盖对方的改动，本次保存已取消。请重新打开该文件。'
      )
    }
  }

  const finalText = stats ? applyOriginalLineEndings(absolute, stats.size, text) : text

  // 原子写：同目录临时文件 + rename。同目录是必须的 —— 跨盘 rename 不是原子操作。
  const temp = `${absolute}.${process.pid}.ipi-tmp`
  writeFileSync(temp, finalText, 'utf8')
  try {
    renameSync(temp, absolute)
  } catch (error) {
    // rename 失败（例如目标被占用）时删掉临时文件，不给用户在工作区里留垃圾。
    rmSync(temp, { force: true })
    throw error
  }

  const updated = statSync(absolute)
  return {
    path: toRelative(workspaceRoot, absolute),
    bytes: updated.size,
    revision: revisionOf(updated)
  }
}

/**
 * 把文本的换行风格对齐到原文件。
 *
 * 只在原文件确实是 CRLF 文件时才转换；LF 文件原样保留。
 * 文件过大时跳过（那种文件本来也不会进入可编辑状态）。
 */
function applyOriginalLineEndings(absolute: string, size: number, text: string): string {
  if (size > MAX_PREVIEW_BYTES) return text
  let original: string
  try {
    original = readFileSync(absolute, 'utf8')
  } catch {
    return text
  }
  const crlf = (original.match(/\r\n/g) ?? []).length
  if (crlf === 0) return text
  const loneLf = (original.match(/(?<!\r)\n/g) ?? []).length
  // 以 CRLF 为主（含全部为 CRLF 的情况）才转换，混合风格的怪异文件不猜。
  if (crlf < loneLf) return text
  return text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
}
