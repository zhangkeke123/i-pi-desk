/**
 * 把 node-pty 的加载失败翻译成**可行动**的提示。
 *
 * ## 先说清楚事实（这一节差点写错，是靠证据纠正的）
 *
 * 我最初以为最常见的失败是「为 Node 编译的二进制跑在 Electron 里（ABI 不匹配）」——
 * **这是错的**。查证过程：用普通 Node（v24）加载 `node-pty` 并成功 `spawn`，
 * 而 Electron 43 带的是 Node 22；同一个 `.node` 跨两代都能用，只可能是 Node-API。
 * 二进制里也确实找得到 `napi_register_module_v1` 而**没有** `NODE_MODULE_VERSION`，
 * `binding.gyp` 依赖 `node-addon-api`。
 *
 * 结论：**Node-API 模块跨 Node/Electron 版本 ABI 稳定，这里不会出现 ABI 不匹配。**
 * 所以 `pnpm rebuild:pty` 存在的理由**不是** ABI，而是本机编译：
 *
 * | 真实原因 | 该做什么 |
 * |---|---|
 * | 依赖没装（整个包都不在） | `pnpm install` |
 * | **包装上了，但原生绑定没编译出来**（本机缺 Spectre 缓解库 → `MSB8040`，安装脚本失败） | `pnpm rebuild:pty` |
 * | 编译期报错文本直接冒到运行时 | 同上 |
 *
 * 中间那条是**最常见的**：`pnpm install` 会先在安装阶段报 MSB8040，
 * 用户如果跳过了那一步（或用了 `--ignore-scripts`），运行时就会看到「找不到模块」。
 * 这时说「先 pnpm install」是没用的 —— 它会以同样的方式再失败一次。
 *
 * 所以这个模块把「归因」做成纯函数：不 import electron、不 require node-pty，
 * 只吃一段错误文本。这样可以拿真实世界的错误串逐条单测 ——
 * 各平台、各工具链的报错文案并不一致，靠记是记不住的。
 */

export type PtyFailureKind =
  /** 整个包都不在。 */
  | 'package-missing'
  /** 包在，但原生绑定没编译出来（最需要区分的一种）。 */
  | 'binding-missing'
  /** 编译期失败（MSB8040 / Spectre / node-gyp）。 */
  | 'toolchain'
  /**
   * ABI 不匹配。
   *
   * 对 node-pty 来说**不会发生**（它是 Node-API 模块），保留这个分支是因为
   * 错误文本一旦真的长这样，说明有人换成了非 Node-API 的原生模块 ——
   * 那时「重编」确实是正解。但不要把它说成常见原因。
   */
  | 'abi-mismatch'
  | 'unknown'

export interface PtyFailure {
  kind: PtyFailureKind
  /** 给用户看的一段话，含可执行的修复命令。 */
  message: string
}

const ABI_PATTERN = /NODE_MODULE_VERSION|different Node\.js version|compiled against a different|was compiled against/i
const TOOLCHAIN_PATTERN = /MSB8040|Spectre|gyp ERR|node-gyp|MSBuild|v143/i
const MODULE_MISSING_PATTERN = /Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/i
/** 「模块没找到」+ 具体到原生绑定文件 = 包在、绑定没编出来。 */
const NATIVE_BINDING_PATTERN = /(pty|conpty|conpty_console_list)\.node/i

const REBUILD_COMMAND = 'pnpm rebuild:pty'

export function describePtyLoadFailure(raw: string): PtyFailure {
  const text = raw ?? ''
  // 只留第一行、限长：堆栈对用户没用，但原始信息要留着方便搜索/检索 issue。
  const detail = text.trim().split('\n')[0].slice(0, 200)
  const suffix = detail ? `（原始错误：${detail}）` : ''

  if (ABI_PATTERN.test(text)) {
    return {
      kind: 'abi-mismatch',
      message:
        '终端不可用：原生模块的 ABI 与应用不匹配。' +
        `在仓库根目录执行 ${REBUILD_COMMAND} 重编一次。` +
        suffix
    }
  }

  if (TOOLCHAIN_PATTERN.test(text)) {
    return {
      kind: 'toolchain',
      message:
        '终端不可用：node-pty 编译失败。Windows 上它默认要求 MSVC 装有「Spectre 缓解库」组件，否则报 MSB8040。' +
        `在仓库根目录执行 ${REBUILD_COMMAND} 可以绕开这个要求（它会关掉这一处 Spectre 缓解）` +
        '；环境允许的话更推荐装上该组件。' +
        suffix
    }
  }

  if (MODULE_MISSING_PATTERN.test(text) && NATIVE_BINDING_PATTERN.test(text)) {
    return {
      kind: 'binding-missing',
      message:
        `终端不可用：node-pty 装上了，但它的原生绑定没编译出来（通常是安装时 MSB8040 失败被忽略了）。` +
        `在仓库根目录执行 ${REBUILD_COMMAND} 即可。` +
        suffix
    }
  }

  if (MODULE_MISSING_PATTERN.test(text)) {
    return {
      kind: 'package-missing',
      message:
        `终端不可用：找不到 node-pty 模块。先在仓库根目录执行 pnpm install；` +
        `如果安装日志里出现 MSB8040，再执行 ${REBUILD_COMMAND}。` +
        suffix
    }
  }

  return {
    kind: 'unknown',
    message:
      `终端不可用：node-pty 原生模块加载失败。先试 ${REBUILD_COMMAND}（它按本机 Electron 重编）；` +
      '仍失败再检查 MSVC 生成工具与「Spectre 缓解库」组件。' +
      suffix
  }
}
