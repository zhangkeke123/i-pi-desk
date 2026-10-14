import { build } from 'esbuild'
import { copyFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * 把 sidecar 打成一个**自包含单文件**，供打包后的应用使用。
 *
 * 为什么必须 bundle，而不能直接分发 dist/ + node_modules：
 *  - `pi-agent-core` / `pi-coding-agent` 的传递依赖非常多（模型 SDK、typebox、jiti…），
 *    把整个 node_modules 塞进安装包会显著增大体积；
 *  - 更麻烦的是原生模块与动态 import 的解析路径在 asar 里很容易错位，
 *    出现「开发能跑、装完就报找不到模块」这类只在发布后暴露的故障。
 *
 * 打成单文件后，运行时只剩 `.js` 与 Node 内置模块，解析路径不再有歧义。
 *
 * 注意：`format: 'esm'` 必须与 packages/agent-host/package.json 的 `"type": "module"` 一致，
 * 且要保留 `--experimental` 之外的所有动态 import —— 因此 `packages: 'bundle'`，
 * 但把真正无法静态打包的东西（原生模块）留成 external。
 */

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')
const outDir = join(packageRoot, 'dist-bundle')
const outfile = join(outDir, 'sidecar.js')

const EXTERNAL = [
  // 原生/可选依赖：装不上或不该被打进主文件。sidecar 的 M1 路径用不到它们。
  'fsevents'
]

rmSync(outDir, { recursive: true, force: true })

const result = await build({
  entryPoints: [join(packageRoot, 'src', 'sidecar.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  minify: false,
  external: EXTERNAL,
  // 顶层 await 之类的语法由 target 决定；这里显式保留 ESM 语义。
  banner: {
    js: [
      '// 由 scripts/bundle.mjs 生成 —— 不要直接编辑。',
      '// stdout 是协议流：本文件内任何向 stdout 的输出都必须走 protocol.ts 的 writeFrame。',
      // ── 必须有的 shim，否则 bundle 一启动就崩 ──
      // pi 的依赖树里有 CJS 包（如 cross-spawn）会 `require('child_process')`。
      // 把它们打进 **ESM** 产物后，esbuild 生成的 `__require` 在 ESM 作用域里找不到 require，
      // 就会抛 `Dynamic require of "child_process" is not supported`。
      // 用 createRequire 在本模块作用域里补出一个真的 require，esbuild 的 shim 就会改用它。
      // （这也说明「能在 Node 里跑」和「能 bundle 成单文件跑」是两件事，必须分别验证。）
      "import { createRequire as __ipiCreateRequire } from 'node:module';",
      'const require = __ipiCreateRequire(import.meta.url);'
    ].join('\n')
  },
  logLevel: 'info'
})

if (result.errors.length > 0) {
  console.error('bundle 失败')
  process.exit(1)
}

// 插件运行器是独立脚本，不会被 esbuild 打进主文件 —— 必须单独拷到同一目录，
// 因为 plugin-host 用 `new URL('./plugin-runner.mjs', import.meta.url)` 找它。
copyFileSync(join(packageRoot, 'src', 'plugin-runner.mjs'), join(outDir, 'plugin-runner.mjs'))
console.log(`plugin-runner.mjs → ${join(outDir, 'plugin-runner.mjs')}`)

console.log(`bundle 完成 → ${outfile}`)
