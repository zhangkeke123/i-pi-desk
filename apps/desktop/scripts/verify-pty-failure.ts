/**
 * `describePtyLoadFailure` 的单测。
 *
 * 这里用的错误串**不是编的**，是各场景下真实会出现的形状：
 * 原生绑定没编出来、整个包不在、node-gyp/MSBuild 的编译失败。
 * 这个函数的全部价值就在于「认得出是哪一种」——认错的代价是把用户引到错误的修复方向上，
 * 所以它值得用真实文案逐条打。
 *
 * ⚠️ 特别地：**这里刻意没有「ABI 不匹配是最常见原因」的用例**。
 * 最初我以为那是主因，后来查证发现 node-pty 是 Node-API 模块
 * （二进制里有 `napi_register_module_v1`、没有 `NODE_MODULE_VERSION`），
 * 跨 Node/Electron 版本 ABI 稳定，**不会**出现这种失败。
 * 保留 ABI 分支只是为了「万一换成非 Node-API 模块」时仍给得出话。
 */
import { describePtyLoadFailure } from '../electron/main/terminal/pty-failure.ts'

let failures = 0
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

console.log('=== 1. 最常见：包在、原生绑定没编出来 ===')

/**
 * 这是本机真实会遇到的形状：`pnpm install` 时 node-gyp 因 MSB8040 失败，
 * 用户忽略之后运行时去找 `build/Release/pty.node`，找不到。
 */
const bindingMissing = describePtyLoadFailure(
  "Cannot find module 'D:\\app\\node_modules\\node-pty\\build\\Release\\pty.node'\n" +
    'Require stack:\n- D:\\app\\node_modules\\node-pty\\lib\\windowsPtyAgent.js'
)
check('绑定文件缺失 → 判为 binding-missing', bindingMissing.kind === 'binding-missing', bindingMissing.kind)
check('给的是 rebuild:pty（而不是再 install 一次）', bindingMissing.message.includes('pnpm rebuild:pty'), bindingMissing.message)
check('不误导成「先 pnpm install」', !/先在仓库根目录执行 pnpm install/.test(bindingMissing.message), bindingMissing.message)

const conptyMissing = describePtyLoadFailure("Cannot find module '...\\build\\Release\\conpty.node'")
check('conpty.node 缺失也算 binding-missing', conptyMissing.kind === 'binding-missing', conptyMissing.kind)

console.log('\n=== 2. 整个包不在 ===')

const packageMissing = describePtyLoadFailure("Error: Cannot find module 'node-pty'")
check('整包缺失 → 判为 package-missing', packageMissing.kind === 'package-missing', packageMissing.kind)
check('提示先 pnpm install', packageMissing.message.includes('pnpm install'), packageMissing.message)
check('同时提醒 MSB8040 时要 rebuild:pty', packageMissing.message.includes('pnpm rebuild:pty') && packageMissing.message.includes('MSB8040'), packageMissing.message)

const esmMissing = describePtyLoadFailure('ERR_MODULE_NOT_FOUND')
check('ESM 的找不到模块也被认出来', esmMissing.kind === 'package-missing', esmMissing.kind)

console.log('\n=== 3. 编译期失败（本机工具链）===')

const spectre = describePtyLoadFailure(
  'gyp ERR! stack Error: MSB8040: Spectre-mitigated libraries are required for this project.'
)
check('MSB8040 → 判为 toolchain', spectre.kind === 'toolchain', spectre.kind)
check('说明是 Spectre 缓解库的要求', spectre.message.includes('Spectre'), spectre.message)
check('给出 rebuild:pty 这条更省事的路', spectre.message.includes('pnpm rebuild:pty'), spectre.message)

console.log('\n=== 4. ABI 分支保留但不当成常见原因 ===')

const abi = describePtyLoadFailure('was compiled against a different Node.js version using NODE_MODULE_VERSION 137')
check('ABI 报错 → 判为 abi-mismatch', abi.kind === 'abi-mismatch', abi.kind)
check('仍然给出可执行的下一步', abi.message.includes('pnpm rebuild:pty'), abi.message)
check('没有把它说成「最常见」', !abi.message.includes('最常见'), abi.message)

console.log('\n=== 5. 认不出来时也不能给空话 ===')
const unknown = describePtyLoadFailure('something went terribly wrong')
check('未知错误 → unknown', unknown.kind === 'unknown', unknown.kind)
check('未知错误也给出可执行的下一步', unknown.message.includes('pnpm rebuild:pty'), unknown.message)

console.log('\n=== 6. 原始错误要保留（方便搜索）===')
const preserved = describePtyLoadFailure("Cannot find module 'node-pty'\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1144:15)")
check('保留了原始错误的首行', preserved.message.includes("Cannot find module 'node-pty'"), preserved.message)
check('没有把整段堆栈塞进提示', !preserved.message.includes('at Module._resolveFilename'), preserved.message.slice(0, 160))

console.log('\n=== 7. 脏输入不能抛异常 ===')
for (const [label, raw] of [['空串', ''], ['只有空白', '   '], ['换行开头', '\n\nMSB8040']] as Array<[string, string]>) {
  try {
    const result = describePtyLoadFailure(raw)
    check(`${label} → 返回结果而不是抛错`, typeof result.message === 'string' && result.message.length > 0, result.kind)
  } catch (error) {
    failures += 1
    console.log(`  FAIL  ${label} → 抛了异常: ${String(error)}`)
  }
}

console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
