/**
 * 应用内更新的开关规则。不启动 Electron。
 * 用法：node --experimental-strip-types scripts/verify-update-policy.ts
 */
import { isPortableExecutable, resolveUpdateMode, usableFeedUrl } from '../electron/main/update-policy.ts'

let failures = 0
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

console.log('\n── 谁可以应用内更新 ──')
check('开发模式关闭', resolveUpdateMode({ isPackaged: false, platform: 'win32', portable: false }) === 'disabled')
check('便携版只通知', resolveUpdateMode({ isPackaged: true, platform: 'win32', portable: true }) === 'notify')
check('NSIS 安装版应用内更新', resolveUpdateMode({ isPackaged: true, platform: 'win32', portable: false }) === 'in-app')
check('非 Windows 安装版关闭', resolveUpdateMode({ isPackaged: true, platform: 'darwin', portable: false }) === 'disabled')
check('便携环境变量识别文件', isPortableExecutable({ PORTABLE_EXECUTABLE_FILE: 'C:\\app.exe' }) === true)
check('没有便携变量就不是便携版', isPortableExecutable({}) === false)

console.log('\n── 更新地址 ──')
check('空地址不用', usableFeedUrl('') === null && usableFeedUrl('   ') === null)
check('http 不用', usableFeedUrl('http://example.com/updates') === null)
check('占位域名不用', usableFeedUrl('https://updates.i-pi-desk.invalid/win') === null)
check('https 可用并去掉末尾斜杠', usableFeedUrl('https://example.com/updates/') === 'https://example.com/updates')
check('垃圾字符串不用', usableFeedUrl('not a url') === null)

if (failures > 0) {
  console.log(`\n${failures} FAIL`)
  process.exit(1)
}
console.log('\nALL_PASS')
