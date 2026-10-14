/**
 * 审批前差异预览的自测。
 *
 * 重点不是「能生成 diff」，而是**边界情况是否诚实**：
 * 匹配不到、oldText 不唯一、多段改动、整文件覆盖 —— 这些才是审批时会误导用户的场景。
 *
 * 运行：`node --experimental-strip-types scripts/verify-approval-preview.ts`
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApprovalPreview } from '../src/approval-preview.ts'

let failures = 0

function check(label: string, condition: boolean, detail: string): void {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}\n        ${detail}`)
  }
}

function show(label: string, preview: string | undefined): void {
  console.log(`\n── ${label} ──`)
  console.log(preview === undefined ? '(undefined)' : preview.split('\n').map((l) => `   ${l}`).join('\n'))
}

const root = mkdtempSync(join(tmpdir(), 'ipi-preview-'))

try {
  // 一份「出现两次同名片段」的文件，用来验证歧义提示
  const target = join(root, 'sample.ts')
  writeFileSync(
    target,
    ['const a = 1', 'const b = 2', 'const a = 1', 'export default a', ''].join('\n'),
    'utf8'
  )

  console.log('=== 1. 精确匹配：应给出带上下文的真实 diff ===')
  const exact = buildApprovalPreview(
    'edit',
    { path: target, edits: [{ oldText: 'const b = 2', newText: 'const b = 20' }] },
    root
  )
  show('精确匹配', exact)
  check('包含文件头与改动数', Boolean(exact?.includes('1 处改动')), String(exact))
  check('显示了旧行', Boolean(exact?.includes('const b = 2')), String(exact))
  check('显示了新行', Boolean(exact?.includes('const b = 20')), String(exact))
  check('无歧义警告', !exact?.includes('出现多次'), String(exact))

  console.log('\n=== 2. oldText 不唯一：必须提示歧义（不是静默给一个可能错的 diff）===')
  const ambiguous = buildApprovalPreview(
    'edit',
    { path: target, edits: [{ oldText: 'const a = 1', newText: 'const a = 10' }] },
    root
  )
  show('歧义', ambiguous)
  check('给出歧义提示', Boolean(ambiguous?.includes('出现多次')), String(ambiguous))

  console.log('\n=== 3. oldText 匹配不到：退回意图视图并明确告知 ===')
  const noMatch = buildApprovalPreview(
    'edit',
    { path: target, edits: [{ oldText: '这行根本不存在', newText: 'x' }] },
    root
  )
  show('未匹配', noMatch)
  check('明确写出未匹配', Boolean(noMatch?.includes('未在文件中精确匹配到')), String(noMatch))
  check('仍然展示改动意图', Boolean(noMatch?.includes('改动 1')), String(noMatch))

  console.log('\n=== 4. 多段改动：倒序应用，偏移不能错乱 ===')
  const multi = buildApprovalPreview(
    'edit',
    {
      path: target,
      edits: [
        { oldText: 'const a = 1', newText: 'const a = 100' },
        { oldText: 'export default a', newText: 'export default a\n// 追加注释' }
      ]
    },
    root
  )
  show('多段', multi)
  check('包含两处改动', Boolean(multi?.includes('2 处改动')), String(multi))
  check('第一处生效', Boolean(multi?.includes('const a = 100')), String(multi))
  check('第二处生效', Boolean(multi?.includes('追加注释')), String(multi))

  console.log('\n=== 5. write 新文件：全部按新增呈现 ===')
  const created = buildApprovalPreview(
    'write',
    { path: join(root, 'brand-new.txt'), content: 'line1\nline2\n' },
    root
  )
  show('新建', created)
  check('标注将写入行数', Boolean(created?.includes('将写入')), String(created))
  // pi 的展示用 diff 带行号（形如 `+1 line1`），所以用正则而不是字面量匹配，
  // 免得格式微调就把测试变成假失败 —— 这一点本轮已经踩过一次。
  check('新增行以 + 呈现', Boolean(created && /\+\s*\d*\s*line1/.test(created)), String(created))

  console.log('\n=== 6. write 覆盖已有文件：应是与原内容的真实对比 ===')
  const overwrite = buildApprovalPreview(
    'write',
    { path: target, content: 'const only = 1\n' },
    root
  )
  show('覆盖', overwrite)
  check('标注整文件覆盖', Boolean(overwrite?.includes('整文件覆盖')), String(overwrite))
  check(
    '显示了被删掉的旧行',
    Boolean(overwrite && /-\s*\d*\s*const a = 1/.test(overwrite)),
    String(overwrite)
  )

  console.log('\n=== 7. 无关工具不产出预览 ===')
  const bash = buildApprovalPreview('bash', { command: 'rm -rf /' }, root)
  show('bash', bash)
  check('bash 返回 undefined', bash === undefined, String(bash))

  console.log('\n=== 8. 畸形入参不能抛异常 ===')
  for (const [label, args] of [
    ['null', null],
    ['无 edits', { path: target }],
    ['edits 不是数组', { path: target, edits: 'nope' }],
    ['edits 元素缺字段', { path: target, edits: [{ oldText: 'x' }] }],
    ['write 缺 content', { path: target }]
  ] as const) {
    let threw = false
    let result: string | undefined
    try {
      result = buildApprovalPreview('edit', args, root)
    } catch {
      threw = true
    }
    check(`${label} 不抛异常（返回 ${result === undefined ? 'undefined' : '字符串'}）`, !threw, '抛异常了')
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
