#!/usr/bin/env node
/**
 * 插件 manifest 校验器自测。
 *
 * 校验器是插件机制的**入口防线**：安装时决定收不收，激活时再查一次盘上的文件。
 * 它的每一条规则都对应一个真实后果，所以逐条覆盖：
 *
 *  - 未知权限必须报错（静默忽略会让同意界面少列一项 → 用户信息不全就点了同意）；
 *  - 工具名不得占用内置名（同名会**静默替换**掉真正执行命令的那个工具）；
 *  - main 与技能目录不得路径逃逸（否则可以把插件目录外的文件当插件加载）；
 *  - schemaVersion 不匹配直接拒绝（不做兼容猜测）。
 *
 * 运行前需要先构建 shared：`pnpm --filter @i-pi-desk/shared build`
 * 用法：node packages/shared/scripts/verify-plugin-manifest.mjs
 */

import { validatePluginManifest, RESERVED_TOOL_NAMES, PLUGIN_PERMISSIONS } from '../dist/index.js'

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

/** 一个合法的最小 manifest，各用例在它基础上改一处。 */
const base = () => ({
  schemaVersion: 1,
  id: 'acme.demo-plugin',
  name: 'Demo',
  version: '1.0.0',
  main: 'index.mjs'
})

const expectOk = (label, manifest) => {
  const result = validatePluginManifest(manifest)
  check(label, result.ok === true, result.ok ? '' : JSON.stringify(result.errors))
}

/** 断言被拒，并且错误信息落在预期的字段上（只判「被拒」会掩盖报错位置写错的问题）。 */
const expectError = (label, manifest, pathFragment) => {
  const result = validatePluginManifest(manifest)
  if (result.ok) {
    failures += 1
    console.log(`  FAIL  ${label} → 本该被拒，却通过了`)
    return
  }
  const hit = result.errors.some((error) => error.path.includes(pathFragment))
  check(label, hit, `错误里没有提到 ${pathFragment}：${JSON.stringify(result.errors)}`)
}

console.log('── 基础字段 ──')
expectOk('最小合法 manifest 通过', base())
expectOk('带可选字段也通过', {
  ...base(),
  description: '描述',
  author: '作者',
  permissions: ['agent.tool.register'],
  contributes: {
    agentTools: [{ name: 'do_thing', description: '做一件事' }],
    skills: ['skills']
  }
})

check('非对象被拒', validatePluginManifest('nope').ok === false)
check('null 被拒', validatePluginManifest(null).ok === false)
check('数组被拒', validatePluginManifest([]).ok === false)

expectError('schemaVersion 不匹配被拒', { ...base(), schemaVersion: 99 }, 'schemaVersion')
expectError('schemaVersion 缺失被拒', { ...base(), schemaVersion: undefined }, 'schemaVersion')

console.log('\n── id 规范 ──')
for (const id of ['a', 'acme.demo', 'acme.demo-plugin', 'x1.y2-z3']) {
  expectOk(`合法 id：${id}`, { ...base(), id })
}
for (const [label, id] of [
  ['大写', 'Acme.Demo'],
  ['下划线', 'acme_demo'],
  ['前导点', '.acme'],
  ['结尾点', 'acme.'],
  ['连续点', 'acme..demo'],
  ['前导连字符段', 'acme.-demo'],
  ['结尾连字符段', 'acme.demo-'],
  ['含空格', 'acme demo'],
  ['路径分隔符', '../evil'],
  ['空串', ''],
  ['超长', 'a'.repeat(65)]
]) {
  expectError(`非法 id（${label}）被拒`, { ...base(), id }, 'id')
}

console.log('\n── name / version / main ──')
expectError('缺 name 被拒', { ...base(), name: undefined }, 'name')
expectError('name 为空被拒', { ...base(), name: '   ' }, 'name')
expectError('缺 version 被拒', { ...base(), version: undefined }, 'version')
expectError('缺 main 被拒', { ...base(), main: undefined }, 'main')
expectError('main 非 JS 文件被拒', { ...base(), main: 'index.txt' }, 'main')
expectError('main 路径逃逸被拒', { ...base(), main: '../outside.mjs' }, 'main')
expectError('main 绝对路径被拒', { ...base(), main: '/etc/passwd.mjs' }, 'main')
expectError('main 盘符路径被拒', { ...base(), main: 'C:\\evil.mjs' }, 'main')
expectOk('main 允许 .mjs / .cjs / .js', { ...base(), main: 'dist/entry.cjs' })

console.log('\n── 权限 ──')
expectOk('空权限数组合法', { ...base(), permissions: [] })
expectOk('所有已声明权限都合法', { ...base(), permissions: [...PLUGIN_PERMISSIONS] })
expectError('未知权限被拒（不能静默忽略）', { ...base(), permissions: ['fs.read', 'telepathy'] }, 'permissions[1]')
expectError('权限不是数组被拒', { ...base(), permissions: 'fs.read' }, 'permissions')

console.log('\n── 工具贡献 ──')
expectOk('合法工具', {
  ...base(),
  contributes: { agentTools: [{ name: 'my_tool', description: '描述' }] }
})
expectError('工具缺 description 被拒', {
  ...base(),
  contributes: { agentTools: [{ name: 'my_tool' }] }
}, 'description')
expectError('工具名大写被拒', {
  ...base(),
  contributes: { agentTools: [{ name: 'MyTool', description: 'd' }] }
}, 'name')
expectError('工具名以数字开头被拒', {
  ...base(),
  contributes: { agentTools: [{ name: '1tool', description: 'd' }] }
}, 'name')
expectError('同一插件内工具重名被拒', {
  ...base(),
  contributes: {
    agentTools: [
      { name: 'dup_tool', description: 'a' },
      { name: 'dup_tool', description: 'b' }
    ]
  }
}, 'name')

// 这条是安全相关的：同名工具会静默覆盖内置工具，必须在安装时拦住。
for (const reserved of RESERVED_TOOL_NAMES) {
  expectError(`占用内置工具名 ${reserved} 被拒`, {
    ...base(),
    contributes: { agentTools: [{ name: reserved, description: 'd' }] }
  }, 'name')
}

expectError('agentTools 不是数组被拒', { ...base(), contributes: { agentTools: {} } }, 'agentTools')
expectError('工具参数不是对象被拒', {
  ...base(),
  contributes: { agentTools: [{ name: 't1', description: 'd', parameters: 'nope' }] }
}, 'parameters')

console.log('\n── 技能贡献 ──')
expectOk('合法技能目录', { ...base(), contributes: { skills: ['skills', 'more/skills'] } })
expectError('技能目录逃逸被拒', { ...base(), contributes: { skills: ['../outside'] } }, 'skills[0]')
expectError('技能目录为绝对路径被拒', { ...base(), contributes: { skills: ['/etc'] } }, 'skills[0]')
expectError('技能目录为空串被拒', { ...base(), contributes: { skills: [''] } }, 'skills[0]')
expectError('skills 不是数组被拒', { ...base(), contributes: { skills: 'skills' } }, 'skills')

console.log('\n── 错误聚合 ──')
const many = validatePluginManifest({ schemaVersion: 2, id: 'BAD', name: '', main: 'x.txt' })
check('一次返回全部错误（安装界面要能一次列清）', many.ok === false && many.errors.length >= 4, JSON.stringify(many.errors))

console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
