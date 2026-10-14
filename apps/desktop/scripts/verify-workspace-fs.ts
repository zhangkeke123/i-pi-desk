/**
 * 工作区文件读取的越界防御自测。
 *
 * 这是安全相关代码，必须被真正跑过 —— 「我写了路径校验」和「路径校验拦住了攻击」
 * 是两件事。运行：`node --experimental-strip-types scripts/verify-workspace-fs.ts`
 * （Node 24 默认支持类型擦除，所以可以直接跑 .ts。）
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listDirectory, readFilePreview, resolveInWorkspace, writeFileInWorkspace, createFileInWorkspace, renameInWorkspace, removeInWorkspace, moveInWorkspace } from '../electron/main/store/workspace-fs.ts'

let failures = 0

function expectOk(label: string, fn: () => unknown): void {
  try {
    const value = fn()
    console.log(`  PASS  ${label} → ${JSON.stringify(value).slice(0, 90)}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL  ${label} → 不该抛错，却抛了: ${String(error)}`)
  }
}

/** 断言一个布尔条件。 */
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

/** 断言「被拦住」，不关心具体错误码（用于只要证明防线生效的场合）。 */
function expectBlocked(label: string, fn: () => unknown): void {
  try {
    const value = fn()
    failures += 1
    console.log(`  FAIL  ${label} → 本该被拦住，却成功返回: ${JSON.stringify(value).slice(0, 90)}`)
  } catch (error) {
    const code = (error as { code?: string }).code ?? 'NO_CODE'
    console.log(`  PASS  ${label} → 已拦截 [${code}] ${(error as Error).message}`)
  }
}

/** 断言「以指定错误码失败」。错误码要精确，因为 UI 会按码决定下一步引导。 */
function expectThrows(label: string, fn: () => unknown, expectedCode: string): void {
  try {
    const value = fn()
    failures += 1
    console.log(`  FAIL  ${label} → 本该抛 ${expectedCode}，却成功返回: ${JSON.stringify(value).slice(0, 80)}`)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === expectedCode) {
      console.log(`  PASS  ${label} → [${code}]`)
    } else {
      failures += 1
      console.log(`  FAIL  ${label} → 期望 ${expectedCode}，实际 ${code}（${(error as Error).message}）`)
    }
  }
}

const root = mkdtempSync(join(tmpdir(), 'ipi-fs-'))
const outside = mkdtempSync(join(tmpdir(), 'ipi-outside-'))

try {
  // ── 准备一个工作区 ──
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'index.ts'), 'export const answer = 42\n', 'utf8')
  writeFileSync(join(root, 'README.md'), '# hello\n', 'utf8')
  writeFileSync(join(root, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]))

  // 工作区外的机密文件 + 两条指向它的「后门」：
  //  - 文件软链（Windows 上需要管理员或开发者模式）
  //  - 目录联接 / junction（**Windows 上普通用户就能建**，是最现实的绕过手法）
  const secret = join(outside, 'secret.pem')
  writeFileSync(secret, 'PRIVATE KEY\n', 'utf8')

  let symlinkCreated = false
  try {
    symlinkSync(secret, join(root, 'innocent-link.txt'))
    symlinkCreated = true
  } catch {
    console.log('  NOTE  当前环境不允许建文件符号链接，跳过该用例（需要管理员或开发者模式）')
  }

  let junctionCreated = false
  try {
    symlinkSync(outside, join(root, 'shortcut-dir'), 'junction')
    junctionCreated = true
  } catch {
    console.log('  NOTE  当前环境不允许建目录联接，跳过该用例')
  }

  console.log('\n[1] 正常读取应当成功')
  expectOk('列出工作区根目录', () => listDirectory(root, '').entries.map((e) => e.name))
  expectOk('读取 src/index.ts', () => readFilePreview(root, 'src/index.ts').text.trim())
  expectOk('列出子目录 src', () => listDirectory(root, 'src').entries.length)

  console.log('\n[2] 越界与非法路径必须被拦住')
  expectBlocked('相对路径向上逃逸 ../../', () => readFilePreview(root, '../../etc/passwd'))
  expectBlocked('路径中夹带 ..', () => readFilePreview(root, 'src/../../outside.txt'))
  expectBlocked('绝对路径（Windows）', () => readFilePreview(root, 'C:\\Windows\\win.ini'))
  expectBlocked('绝对路径（POSIX）', () => readFilePreview(root, '/etc/passwd'))
  if (symlinkCreated) {
    expectBlocked('软链指向工作区外的机密文件', () => readFilePreview(root, 'innocent-link.txt'))
  }
  if (junctionCreated) {
    expectBlocked('目录联接绕过（列出联接内目录）', () => listDirectory(root, 'shortcut-dir'))
    expectBlocked('目录联接绕过（读取联接内文件）', () => readFilePreview(root, 'shortcut-dir/secret.pem'))
  }

  console.log('\n[3] 二进制识别与目录误用')
  const bin = readFilePreview(root, 'binary.bin')
  console.log(`  ${bin.binary ? 'PASS' : 'FAIL'}  二进制被识别（binary=${bin.binary}, text 长度=${bin.text.length}）`)
  if (!bin.binary) failures += 1
  expectBlocked('把目录当文件读', () => readFilePreview(root, 'src'))
  expectBlocked('把文件当目录列', () => listDirectory(root, 'README.md'))

  console.log('\n[4] 排序稳定性（目录在前、按名排序）')
  const names = listDirectory(root, '').entries.map((e) => `${e.kind === 'directory' ? 'D' : 'F'}:${e.name}`)
  console.log(`  entries = ${names.join(', ')}`)
  const firstFile = names.findIndex((n) => n.startsWith('F:'))
  const lastDir = names.map((n) => n.startsWith('D:')).lastIndexOf(true)
  if (firstFile !== -1 && lastDir > firstFile) {
    failures += 1
    console.log('  FAIL  目录没有排在文件前面')
  } else {
    console.log('  PASS  目录排在文件之前')
  }

  console.log('\n[5] resolveInWorkspace 归一化')
  expectOk('反斜杠分隔也能解析', () => resolveInWorkspace(root, 'src\\index.ts').endsWith('index.ts'))

  // ───────────────────────────── 写入 ─────────────────────────────

  console.log('\n[6] 写入：正常路径与 revision 校验')
  const target = join(root, 'src', 'index.ts')
  const before = readFilePreview(root, 'src/index.ts')
  check('读取返回 revision', typeof before.revision === 'string' && before.revision.includes(':'), before.revision)
  check('普通文本文件可编辑（无 readOnlyReason）', before.readOnlyReason === undefined, String(before.readOnlyReason))

  const written = writeFileInWorkspace(root, 'src/index.ts', 'export const answer = 43\n', before.revision)
  check('写入返回新 revision', typeof written.revision === 'string' && written.revision !== before.revision, JSON.stringify(written))
  check('磁盘内容确实变了', readFileSync(target, 'utf8') === 'export const answer = 43\n', JSON.stringify(readFileSync(target, 'utf8')))

  // 用**旧** revision 再写一次 —— 这就是「agent 刚改过同一个文件」的场景。
  expectThrows(
    '用过期 revision 写入被拒（STALE_WRITE）',
    () => writeFileInWorkspace(root, 'src/index.ts', '被覆盖的内容\n', before.revision),
    'STALE_WRITE'
  )
  check('被拒时磁盘内容未被改动', readFileSync(target, 'utf8') === 'export const answer = 43\n')

  expectThrows(
    '写入不存在的文件（带 revision）被拒',
    () => writeFileInWorkspace(root, 'src/nope.ts', 'x', '1:1'),
    'NOT_FOUND'
  )

  console.log('\n[7] 写入：越界与非法输入')
  expectThrows('写越界路径', () => writeFileInWorkspace(root, '../escaped.ts', 'x', null), 'FORBIDDEN')
  expectThrows('写绝对路径', () => writeFileInWorkspace(root, 'C:\\Windows\\evil.txt', 'x', null), 'FORBIDDEN')
  expectThrows('把目录当文件写', () => writeFileInWorkspace(root, 'src', 'x', null), 'IS_A_DIRECTORY')
  expectThrows(
    '超大内容被拒',
    () => writeFileInWorkspace(root, 'big.txt', 'x'.repeat(9 * 1024 * 1024), null),
    'TOO_LARGE'
  )
  check('越界写入没有产生文件', !existsSync(join(root, '..', 'escaped.ts')))

  console.log('\n[8] 新建文件')
  const created = writeFileInWorkspace(root, 'src/new-file.ts', 'export const created = true\n', null)
  check('新建成功并返回 revision', typeof created.revision === 'string', JSON.stringify(created))
  check('新建的文件确实存在', existsSync(join(root, 'src', 'new-file.ts')))
  expectThrows(
    '对已存在的路径用「新建」写入被拒',
    () => writeFileInWorkspace(root, 'src/new-file.ts', 'x', null),
    'ALREADY_EXISTS'
  )

  console.log('\n[9] 换行风格保留（CRLF 文件不能被存成 LF）')
  const crlfPath = join(root, 'crlf.txt')
  writeFileSync(crlfPath, 'line1\r\nline2\r\nline3\r\n', 'utf8')
  const crlfPreview = readFilePreview(root, 'crlf.txt')
  // 模拟 textarea 的行为：浏览器会把内容里的 \r\n 归一成 \n。
  const fromTextarea = crlfPreview.text.replace(/\r\n/g, '\n') + 'line4\n'
  writeFileInWorkspace(root, 'crlf.txt', fromTextarea, crlfPreview.revision)
  const crlfAfter = readFileSync(crlfPath, 'utf8')
  check(
    '写回后仍是 CRLF（没有产生整文件 diff）',
    crlfAfter === 'line1\r\nline2\r\nline3\r\nline4\r\n',
    JSON.stringify(crlfAfter)
  )
  const lfPath = join(root, 'lf.txt')
  writeFileSync(lfPath, 'a\nb\n', 'utf8')
  const lfPreview = readFilePreview(root, 'lf.txt')
  writeFileInWorkspace(root, 'lf.txt', 'a\nb\nc\n', lfPreview.revision)
  check('LF 文件保持 LF', readFileSync(lfPath, 'utf8') === 'a\nb\nc\n', JSON.stringify(readFileSync(lfPath, 'utf8')))

  console.log('\n[10] 只读保护：截断与二进制')
  const hugePath = join(root, 'huge.txt')
  writeFileSync(hugePath, 'x'.repeat(600 * 1024), 'utf8')
  const huge = readFilePreview(root, 'huge.txt')
  check('超大文件被标记截断', huge.truncated === true)
  check('超大文件给出只读原因（防保存时截断原文件）', typeof huge.readOnlyReason === 'string' && huge.readOnlyReason.includes('只读'), String(huge.readOnlyReason))
  check('二进制文件给出只读原因', typeof bin.readOnlyReason === 'string' && bin.readOnlyReason.includes('二进制'), String(bin.readOnlyReason))
  console.log('\n[11] 新建文件')
  const createdOk = createFileInWorkspace(root, 'newly-created.txt', 'hello')
  check('新建成功并返回相对路径', createdOk.path === 'newly-created.txt', JSON.stringify(createdOk))
  check('文件确实被创建且内容正确', readFileSync(join(root, 'newly-created.txt'), 'utf8') === 'hello')
  const createdEmpty = createFileInWorkspace(root, 'empty.txt')
  check('不传内容时创建空文件', readFileSync(join(root, 'empty.txt'), 'utf8') === '')
  expectThrows(
    '已存在同名文件时拒绝（不覆盖）',
    () => createFileInWorkspace(root, 'newly-created.txt', '覆盖'),
    'ALREADY_EXISTS'
  )
  check('被拒后原文件内容未变', readFileSync(join(root, 'newly-created.txt'), 'utf8') === 'hello')
  expectThrows('空文件名被拒', () => createFileInWorkspace(root, '   '), 'INVALID_PATH')
  expectThrows('父目录不存在时被拒（第一版不做多层创建）', () => createFileInWorkspace(root, 'no/such/dir/x.txt'), 'NOT_FOUND')
  expectThrows('创建越界路径被拒', () => createFileInWorkspace(root, '../escaped-new.txt'), 'FORBIDDEN')
  expectThrows('创建绝对路径被拒', () => createFileInWorkspace(root, 'C:\\evil.txt'), 'FORBIDDEN')
  check('越界创建没有产生文件', !existsSync(join(root, '..', 'escaped-new.txt')))

  console.log('\n[12] 重命名')
  const renamed = renameInWorkspace(root, 'newly-created.txt', 'renamed.txt')
  check('重命名返回新旧路径', renamed.path === 'renamed.txt' && renamed.previousPath === 'newly-created.txt', JSON.stringify(renamed))
  check('新名字下能找到文件', existsSync(join(root, 'renamed.txt')))
  check('旧名字下已不存在', !existsSync(join(root, 'newly-created.txt')))
  expectThrows(
    '目标已存在时拒绝（否则 POSIX 上会静默覆盖）',
    () => renameInWorkspace(root, 'renamed.txt', 'empty.txt'),
    'ALREADY_EXISTS'
  )
  check('被拒后两个文件都还在', existsSync(join(root, 'renamed.txt')) && existsSync(join(root, 'empty.txt')))
  expectThrows('新名称含分隔符被拒（否则等于搬到未校验的目录）', () => renameInWorkspace(root, 'renamed.txt', 'a/b.txt'), 'INVALID_NAME')
  expectThrows('新名称为 .. 被拒', () => renameInWorkspace(root, 'renamed.txt', '..'), 'INVALID_NAME')
  expectThrows('新名称为空被拒', () => renameInWorkspace(root, 'renamed.txt', '  '), 'INVALID_NAME')
  expectThrows('重命名不存在的路径被拒', () => renameInWorkspace(root, 'nope.txt', 'x.txt'), 'NOT_FOUND')
  expectThrows('重命名工作区根目录被拒', () => renameInWorkspace(root, '', 'evil'), 'FORBIDDEN')
  expectThrows('重命名越界路径被拒', () => renameInWorkspace(root, '../outside.txt', 'x.txt'), 'FORBIDDEN')

  console.log('\n[13] 删除（走注入的回收站动作）')
  const trashed: string[] = []
  const fakeTrash = async (absolute: string): Promise<void> => {
    trashed.push(absolute)
  }

  const removed = await removeInWorkspace(root, 'renamed.txt', fakeTrash)
  check('删除返回被删的相对路径', removed.path === 'renamed.txt', JSON.stringify(removed))
  check(
    '删除动作拿到了**绝对路径**（校验后的那个）',
    trashed.length === 1 && trashed[0] === join(root, 'renamed.txt'),
    JSON.stringify(trashed)
  )

  let rootBlocked = ''
  await removeInWorkspace(root, '', fakeTrash).catch((error: { code?: string }) => {
    rootBlocked = error.code ?? ''
  })
  check('删除工作区根目录被拒', rootBlocked === 'INVALID_PATH', rootBlocked)
  check('被拒时删除动作没有被调用', trashed.length === 1, String(trashed.length))

  let rootBlocked2 = ''
  await removeInWorkspace(root, '.', fakeTrash).catch((error: { code?: string }) => {
    rootBlocked2 = error.code ?? ''
  })
  check('删除 "." 也被拒', rootBlocked2 === 'FORBIDDEN', rootBlocked2)
  check('被拒时删除动作仍未被调用', trashed.length === 1, String(trashed.length))

  let missing = ''
  await removeInWorkspace(root, 'not-here.txt', fakeTrash).catch((error: { code?: string }) => {
    missing = error.code ?? ''
  })
  check('删除不存在的路径被拒', missing === 'NOT_FOUND', missing)

  let escaped = ''
  await removeInWorkspace(root, '../outside.txt', fakeTrash).catch((error: { code?: string }) => {
    escaped = error.code ?? ''
  })
  check('删除越界路径被拒', escaped === 'FORBIDDEN', escaped)

  let trashFailed = ''
  await removeInWorkspace(root, 'empty.txt', async () => {
    throw new Error('回收站不可用')
  }).catch((error: { code?: string }) => {
    trashFailed = error.code ?? ''
  })
  check('回收站报错时转成可读错误码', trashFailed === 'REMOVE_FAILED', trashFailed)

  /**
   * ── 移动（跨目录，名字不变） ──
   *
   * 移动比改名多了四个只属于它的坑，这一节逐条打：
   * 目标目录也可能越界、目录不能移进自己的子孙、不能覆盖、源与目标相同要报错而不是假装成功。
   */
  console.log('\n[14] 移动（跨目录）')
  writeFileSync(join(root, 'src', 'move-me.txt'), 'move me')

  const moved = moveInWorkspace(root, 'src/move-me.txt', '')
  check('文件能被移到工作区根目录', moved.path === 'move-me.txt' && moved.previousPath === 'src/move-me.txt', JSON.stringify(moved))
  check('新位置确实存在', existsSync(join(root, 'move-me.txt')))
  check('旧位置已不存在', !existsSync(join(root, 'src', 'move-me.txt')))

  const movedBack = moveInWorkspace(root, 'move-me.txt', 'src')
  check('也能再移回子目录', movedBack.path === 'src/move-me.txt', JSON.stringify(movedBack))

  mkdirSync(join(root, 'nested', 'deep'), { recursive: true })
  const movedDir = moveInWorkspace(root, 'nested/deep', 'src')
  check('目录本身也能移动', movedDir.path === 'src/deep', JSON.stringify(movedDir))
  check('目录内容跟着走', existsSync(join(root, 'src', 'deep')))

  expectThrows('源不存在时被拒', () => moveInWorkspace(root, 'nope.txt', 'src'), 'NOT_FOUND')
  expectThrows('目标目录不存在时被拒', () => moveInWorkspace(root, 'src/move-me.txt', 'nope-dir'), 'NOT_FOUND')
  expectThrows('目标是文件而不是目录时被拒', () => moveInWorkspace(root, 'src/move-me.txt', 'README.md'), 'NOT_A_DIRECTORY')
  expectThrows('源是工作区根目录时被拒', () => moveInWorkspace(root, '', 'src'), 'FORBIDDEN')
  expectThrows('源越界时被拒', () => moveInWorkspace(root, '../outside.txt', 'src'), 'FORBIDDEN')
  expectThrows('目标越界时被拒（否则就是绕过读取防护的写入原语）', () => moveInWorkspace(root, 'src/move-me.txt', '../outside'), 'FORBIDDEN')
  expectThrows(
    '源与目标相同要报错，而不是假装成功',
    () => moveInWorkspace(root, 'src/move-me.txt', 'src'),
    'INVALID_PATH'
  )

  // 目标目录里已有同名条目：不能覆盖（POSIX 上 renameSync 会静默覆盖）。
  writeFileSync(join(root, 'nested', 'move-me.txt'), '别动我')
  expectThrows(
    '目标已有同名文件时拒绝（不能覆盖）',
    () => moveInWorkspace(root, 'src/move-me.txt', 'nested'),
    'ALREADY_EXISTS'
  )
  check('被拒后两个文件都还在且内容未变', readFileSync(join(root, 'src', 'move-me.txt'), 'utf8') === 'move me' && readFileSync(join(root, 'nested', 'move-me.txt'), 'utf8') === '别动我')

  // 目录移进自己的子孙：必须挡住，否则整棵子树会从工作区里「消失」。
  mkdirSync(join(root, 'outer', 'inner'), { recursive: true })
  expectThrows(
    '不能把目录移进它自己的子目录（否则子树不可达）',
    () => moveInWorkspace(root, 'outer', 'outer/inner'),
    'FORBIDDEN'
  )
  check('被拒后目录结构完好', existsSync(join(root, 'outer', 'inner')))
} finally {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
