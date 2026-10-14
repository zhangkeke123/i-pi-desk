#!/usr/bin/env node
/**
 * **文档承诺的修复，是否还在代码里**。
 *
 * ## 为什么要这么一份守卫
 *
 * 这一轮的起点是第 44 轮那次发现：未验证清单第 7 条把结论写反了
 * （「工作区自带的扩展不会被加载」——实际会执行），而**没有人会去重读那份清单**。
 * 文档与代码之间的漂移不会自己暴露：它只会在某天表现为一个没人能解释的现象。
 *
 * 反过来也成立：**这一路上修掉的缺陷，也可能被后来的重构悄悄改回去**。
 * 每一次修复都写进了文档（带原理与后果），但文档是散文 ——
 * 这份自测把其中**载荷最重的那部分**变成可执行的断言：
 *
 *  - 每一条都锚在一段**具体代码**上（正则命中即为在）；
 *  - 每一条都写清**失效的后果**，失败信息直接告诉下一个人「你刚刚破坏了什么」；
 *  - 负向断言（「这种写法不该再出现」）会**先剥掉注释**再匹配 ——
 *    否则它会被解释性注释误伤，逼着人删注释（那比去掉断言更糟）。
 *
 * 它不是万能对账：只能盯住能用一两行正则表达的性质。
 * 真正的对账是 `pnpm verify` 那一整套 —— 这份守的是**「修过的别再坏回去」**。
 *
 * 用法：node packages/agent-host/scripts/verify-doc-claims.mjs
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')

let failures = 0
function check(label, condition, detail = '') {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

/**
 * 正向锚点：`{ file, pattern, why, doc }`。
 * `why` 是**失效后果**，`doc` 指向讲这件事的小节。
 */
const CLAIMS = [
  {
    file: 'packages/agent-host/src/runtime.ts',
    pattern: /settingsManager\.setProjectTrusted\(false\)/,
    doc: '§7.9',
    why: '没有这一行，工作区里的 .pi/extensions、SYSTEM.md、skills 会被照单全收 —— 陌生仓库能执行代码、能给系统提示下指令'
  },
  {
    file: 'packages/agent-host/src/runtime.ts',
    /**
     * 审批超时不但要**存在**，还要**来自共享常量**。
     *
     * 原来的写法是就地写 `= 5 * 60 * 1000`；后来渲染层也要显示倒计时，
     * 就地那一份就变成了两份 5 分钟 —— 于是这里同时断言两件事：
     * ① 超时值确实来自 `APPROVAL_TIMEOUT_MS`（单一来源）；
     * ② 那个常量从 `@i-pi-desk/shared` 进来。
     * 这样「有人图省事又把数字写回本地」会立刻变红。
     */
    pattern: /DEFAULT_APPROVAL_TIMEOUT_MS = APPROVAL_TIMEOUT_MS[\s\S]{0,400}?import \{[^}]*APPROVAL_TIMEOUT_MS[^}]*\} from '@i-pi-desk\/shared'|import \{[^}]*APPROVAL_TIMEOUT_MS[^}]*\} from '@i-pi-desk\/shared'[\s\S]{0,4000}?DEFAULT_APPROVAL_TIMEOUT_MS = APPROVAL_TIMEOUT_MS/,
    doc: '§7.2 / §15.8 / §15.16',
    why: '审批等待必须有上限，而且那个上限必须是共享常量（渲染层的倒计时用的是同一个值）'
  },
  {
    file: 'packages/agent-host/src/runtime.ts',
    pattern: /SessionManager\.inMemory\(cwd\)/,
    doc: '§7.7',
    why: '改成落盘的 SessionManager 就会出现两份历史，互相覆盖'
  },
  {
    file: 'packages/agent-host/src/runtime.ts',
    pattern: /tools: \[\.\.\.FULL_TOOLS/,
    doc: '§10',
    why: '插件工具必须并进 tools（它同时是白名单），否则「插件已激活、技能进了提示、工具却不可用」'
  },
  {
    file: 'packages/agent-host/src/runtime.ts',
    pattern: /await this\.#plugins\.deactivateAll\(\)/,
    doc: '§7.13',
    why: '退出时收掉插件子进程，否则应用关掉后还剩几个 Node 进程'
  },
  {
    file: 'packages/agent-host/src/approval.ts',
    pattern: /\(\?=\[\^;&\|\]\*\(\?:\^\|\\s\)-\[a-zA-Z-\]\*\[rR\]\)/,
    doc: '§7.10',
    why: '递归强制删除必须与标志顺序无关，否则 rm -fr / rm -r -f 在 auto 模式下会被静默执行'
  },
  {
    file: 'packages/agent-host/src/approval.ts',
    pattern: /请换一种方式/,
    doc: '§7.5 / §7.11',
    why: '拒绝的理由是回给模型的行动建议，不是只给用户看的「已拒绝」'
  },
  {
    file: 'packages/agent-host/src/approval.ts',
    pattern: /function safePreview[\s\S]{0,500}?try \{/,
    doc: '§7.11',
    why: '预览算不出来时必须降级，不能让异常把一次审批变成一次拒绝'
  },
  {
    file: 'packages/agent-host/src/plugin-host.ts',
    pattern: /record\.lastError = error[\s\S]{0,500}?#stopChild\(record\)/,
    doc: '§7.12',
    why: '激活失败（含超时）必须收掉子进程，否则卡住的插件会永远活着、并占着插件目录'
  },
  {
    file: 'packages/agent-host/src/plugin-host.ts',
    pattern: /running: record\.child !== null/,
    doc: '§7.12',
    why: 'state 是记录、running 是事实；两者分开才看得出来「状态 failed 而进程还在」'
  },
  {
    file: 'packages/agent-host/src/plugin-host.ts',
    pattern: /if \(record\.state !== 'failed' \|\| !record\.lastError\)/,
    doc: '§7.12',
    why: '收尸时的「进程退出」不能覆盖掉更有信息量的失败原因（病因不该被换成收尸记录）'
  },
  {
    file: 'packages/agent-host/src/plugin-host.ts',
    pattern: /env: minimalPluginEnv\(\)/,
    doc: '§10 / §7.12',
    why: '插件必须用白名单环境启动；整份继承 process.env 会把 API key 与代理凭据送进插件'
  },
  {
    file: 'packages/agent-host/src/plugin-runner.mjs',
    pattern: /reader\.on\('close'[\s\S]{0,300}?process\.exit\(0\)/,
    doc: '§7.13',
    why: '父进程不见了要自己退出（stdin 关闭即退出），否则强退应用会留下孤儿进程'
  },
  {
    file: 'packages/agent-host/src/sidecar.ts',
    pattern: /from '\.\/isolation\.js'[\s\S]*?from '\.\/runtime\.js'/,
    doc: '§5.1',
    why: 'isolation 必须早于 pi 求值（TOOLS_DIR 在 import 期固化），顺序反了就会把 rg/fd 下载进用户主目录'
  },
  {
    file: 'apps/desktop/src/stores/app-store.ts',
    pattern: /pendingApprovals/,
    doc: '§7.2',
    why: '审批请求要按会话记下来；丢了它，切走再回来就再也批不了'
  },
  {
    file: 'apps/desktop/src/features/chat/MessageParts.tsx',
    pattern: /本会话内始终允许（相同参数）/,
    doc: '§7.3',
    why: '文案必须说清「只记相同参数、只在本会话」，否则它承诺的范围比实现大'
  },
  {
    file: 'apps/desktop/src/features/workspace/WorkspacePanel.tsx',
    pattern: /key=\{openToken\}/,
    doc: '§8',
    why: '编辑器用 token 而不是路径做 key；否则切换文件会保留旧内容，Ctrl+S 会把旧内容写进新文件'
  },
  {
    file: 'apps/desktop/src/lib/session-scope.ts',
    pattern: /export function sessionsInWorkspace[\s\S]*?export function pickActiveSession/,
    doc: '§5.5',
    why: '会话必须按工作区隔离；否则 agent 在 A 目录干活而界面显示 B'
  },
  {
    file: 'apps/desktop/electron/main/close-guard.ts',
    pattern: /ASK_TIMEOUT_MS = 10_000/,
    doc: '§5.6',
    why: '关窗前问「还有未保存的改动」必须有兜底时限，否则渲染层卡住就永远关不掉'
  },
  {
    file: 'apps/desktop/electron/main/store/workspace-list.ts',
    pattern: /upsertWorkspace/,
    doc: '§5.5',
    why: '打开工作区要复用同一条记录（保留 id 与用户起的名字）'
  }
]

/**
 * 负向锚点：这些写法**不该再出现**。
 *
 * `pattern` 一律**行首锚定**，并且匹配前会剥掉注释 —— 否则「说明当年踩过这个坑」
 * 的注释会把断言弄红，而那正是最该保留的文字。
 */
const ABSENCES = [
  {
    file: 'packages/agent-host/src/plugin-host.ts',
    pattern: /^\s*\.\.\.process\.env/m,
    doc: '§10',
    why: '插件环境不能整份继承宿主 process.env'
  },
  {
    file: 'apps/desktop/electron/main/store/workspace-list.ts',
    pattern: /^\s*existing\.name\s*=/m,
    doc: '§5.5',
    why: '打开工作区不该改名（第一版这么写过，把用户起的名字改成了目录名）'
  },
  {
    file: 'packages/agent-host/src/approval.ts',
    pattern: /^\s*\{ pattern: \/\\brm\\s\+\(-/m,
    doc: '§7.10',
    why: '旧的 rm 正则要求递归标志在强制标志之前，会漏掉 rm -fr'
  }
]

/**
 * 剥掉注释：`//` 行内、`/* … *\/` 块、以及以 `*` 开头的续行。
 *
 * **正负两个方向都要用。** 这一点是被 A/B 抓出来的：第一版只在负向断言上剥注释，
 * 于是把修复写成 `// settingsManager.setProjectTrusted(false)` 之后，
 * 正向锚点**照样命中** —— 一个被注释掉的修复不是修复，但断言看不出来。
 * 「正向断言对『代码被注释掉』是瞎的」与「负向断言对解释性注释过敏」是同一枚硬币的两面。
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n')
}

let checkedFiles = 0

console.log('── 文档里承诺的修复，必须还在代码里（已剥掉注释：注释掉的修复不算修复）──')
for (const claim of CLAIMS) {
  let text
  try {
    text = stripComments(readFileSync(join(repoRoot, claim.file), 'utf8'))
    checkedFiles += 1
  } catch {
    check(`${claim.doc} 的锚点在 ${claim.file}`, false, `文件不存在：${claim.file}`)
    continue
  }
  check(`${claim.doc} ${claim.file}`, claim.pattern.test(text), claim.why)
}

console.log('\n── 旧缺陷的写法不该再回来（同样剥掉注释再匹配）──')
for (const claim of ABSENCES) {
  let text
  try {
    text = stripComments(readFileSync(join(repoRoot, claim.file), 'utf8'))
    checkedFiles += 1
  } catch {
    check(`${claim.doc} 的负向锚点在 ${claim.file}`, false, `文件不存在：${claim.file}`)
    continue
  }
  const found = claim.pattern.test(text)
  check(`${claim.doc} ${claim.file} 不含旧写法`, !found, `又出现了：${claim.why}`)
}

/**
 * 让「剥注释」这件事本身可被检验：如果剥注释把什么都剥没了，
 * 上面那些负向断言会全部恒真。这里用一段**人造文本**证明它还能匹配。
 */
console.log('\n── 对照：剥注释之后，匹配能力还在（两个方向都要）──')
{
  const sample = [
    '// existing.name = 1',
    '/* ...process.env */',
    '* existing.name = 2',
    'existing.name = 3',
    '// settingsManager.setProjectTrusted(false)',
    'settingsManager.setProjectTrusted(false)'
  ].join('\n')
  const stripped = stripComments(sample)
  check('剥注释会去掉注释里的旧写法', !/^\s*existing\.name/m.test(stripped.split('existing.name = 3')[0]), JSON.stringify(stripped))
  check('剥注释会保留真实代码里的旧写法', /^\s*existing\.name\s*=/m.test(stripped), JSON.stringify(stripped))
  check('剥注释也挡住了块注释里的 ...process.env', !/^\s*\.\.\.process\.env/m.test(stripped), JSON.stringify(stripped))
  /**
   * 反向的那一半：**注释掉的修复不能被当成修复**。
   * 这条对照是 A/B 抓出来的 —— 第一版正向锚点在注释里照样命中。
   */
  const beforeReal = stripped.split('settingsManager.setProjectTrusted(false)')[0]
  check(
    '注释掉的修复**不算**修复（正向锚点不会因为它就通过）',
    !/settingsManager\.setProjectTrusted\(false\)/.test(beforeReal),
    JSON.stringify(beforeReal)
  )
  check(
    '而真实代码里的修复仍然能被命中',
    /settingsManager\.setProjectTrusted\(false\)/.test(stripped),
    JSON.stringify(stripped.slice(-120))
  )
}

/**
 * 文档级的断言：**这份文档自己说过的事实，也要能被检查**。
 *
 * 加这一段的直接原因是第 50 轮找到的两处过时说法 —— 都在这份「诚实记账」里：
 *
 *  - §11.1 第 10 条写着「插件机制未做」，而插件机制早已落地（§10、M5，三个自测脚本）；
 *  - M3 行写着「未做重启后 UI 恢复实测」，而 `verify:renderer` 的重启段落有 5 条断言。
 *
 * 写反了比不写更糟：读的人会以为一个已完成的交付物没做。
 *
 * ## 负向锚点必须是**行首锚定**的，不能是「全文任何地方出现这个短语」
 *
 * 第一版就是后者，结果它**抓住了我自己**：为了在 §7.15 里讲清这次修正，
 * 我逐字引用了那两句过时说法（放在表格里），于是负向锚点报红 ——
 * 它把「引用一处错误」和「主张一处错误」当成了同一件事。
 *
 * 现在的规则：只有当那句话**出现在它原本的断言位置**（编号条目 / 表格行）时才算复现。
 * 「禁掉一个短语」永远比「禁掉一种主张」容易误伤，所以能锚多具体就锚多具体。
 */
const DOC_CLAIMS = [
  {
    name: '插件机制的现状（§11.1 第 10 条）',
    mustNotMatch: [/^10\. \*\*插件机制未做\*\*/m],
    mustContain: ['插件：机制已完成，剩下的是沙箱与热重载'],
    why: '插件机制已经实现（§10 / M5 / verify:plugins / verify:plugin-failure / verify:plugin-orphan）'
  },
  {
    name: '重启后 UI 恢复的现状（M3 行）',
    mustNotMatch: [/^\| \*\*M3 持久化加固\*\*.*未做「重启后 UI 恢复」实测/m],
    mustContain: ['「重启后恢复」已实测'],
    why: 'verify:renderer 的重启段落有 5 条断言：读回历史消息 / 追问正常收尾 / 工具仍可用 / 上下文含 assistant 回复'
  }
]

console.log('\n── 这份文档自己说过的事实（过时说法做行首锚点）──')
{
  const docPath = join(repoRoot, 'docs', 'ARCHITECTURE.md')
  const doc = readFileSync(docPath, 'utf8')
  for (const claim of DOC_CLAIMS) {
    const stale = claim.mustNotMatch.filter((pattern) => pattern.test(doc)).map(String)
    check(`${claim.name}：断言位置上不再有过时说法`, stale.length === 0, `仍在文档里：${JSON.stringify(stale)} —— ${claim.why}`)
    const missing = claim.mustContain.filter((needle) => !doc.includes(needle))
    check(`${claim.name}：修正后的说法在位`, missing.length === 0, `缺失：${JSON.stringify(missing)}`)
  }
}

/**
 * 引用必须能解析：**路径、小节号、脚本名**。
 *
 * 文档漂移里最常见的一种：文件改名了、脚本删了、小节重编号了，而引用还指着旧地方。
 * 读的人顺着链接找不到东西，就会怀疑整份文档。
 *
 * 三类各自聚合成一条断言（明细放在失败信息里）—— 逐条断言会把总数灌水成
 * 「几百条路径存在性检查」，反而看不清真正的覆盖。
 */
console.log('\n── 引用必须能解析（路径 / 小节 / 脚本）──')
{
  const docFiles = [
    'README.md',
    'docs/ARCHITECTURE.md',
    'docs/CONTROL-PLANE.md',
    'docs/PI-SDK-NOTES.md',
    'docs/PI-DESKTOP-ANALYSIS.md',
    'docs/HANDOVER.md',
    'THIRD-PARTY.md'
  ]
  /**
   * 小节号从**任意层级**的编号标题里收（2–5 级；这份文档用了 4 级小标题）。
   *
   * 第一版写成 `/^#{2,3} (\d+(?:\.\d+)?)\./` —— 有两处错：
   * 要求数字后**紧跟一个点**（而实际标题是 `### 5.5 一条消息…`，后面是空格），
   * 以及只收 2–3 级。于是 63 条引用里有十几条被误报成「不存在」。
   * **红了先问它观察到了什么**：这次观察到的是我自己的正则。
   */
  const sectionsOf = (text) =>
    new Set(
      text
        .split('\n')
        .map((line) => /^#{1,5} (\d+(?:\.\d+)*)\.?(?:\s|$)/.exec(line)?.[1])
        .filter(Boolean)
    )
  const architectureSections = sectionsOf(readFileSync(join(repoRoot, 'docs', 'ARCHITECTURE.md'), 'utf8'))
  /** 脚本名要在**所有** workspace 包里找：`verify:packaging` 就在 apps/desktop 下。 */
  const scripts = new Set()
  for (const relative of ['package.json', 'apps/desktop/package.json', 'packages/agent-host/package.json', 'packages/shared/package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(join(repoRoot, relative), 'utf8'))
      for (const name of Object.keys(pkg.scripts ?? {})) scripts.add(name)
    } catch {
      // 包不存在就跳过
    }
  }
  /** pnpm 自带的子命令（不是我们的脚本），以及少量散文里的误报。 */
  const PNPM_BUILTINS = new Set([
    'install',
    'add',
    'remove',
    'rm',
    'update',
    'up',
    'upgrade',
    'why',
    'list',
    'ls',
    'outdated',
    'link',
    'unlink',
    'prune',
    'patch',
    'publish',
    'pack',
    'deploy',
    'import',
    'setup',
    'store',
    'licenses',
    'audit',
    'config',
    'root',
    'exec',
    'dlx',
    'run',
    'test',
    'start',
    'monorepo'
  ])

  const badLinks = []
  const badSections = []
  const badScripts = []
  const badFiles = []
  let linkCount = 0
  let sectionCount = 0
  let scriptCount = 0
  let fileCount = 0

  /**
   * 这些名字**不该在仓库里**，每条都写明为什么 —— 一律用白名单，不放宽规则。
   * 加一条之前先问：这是运行期产物 / 外部工具 / 行文举例，还是我们把名字写错了？
   */
  const NOT_REPO_FILES = new Map([
    ['settings.json', '运行期：pi 的用户设置'],
    ['window-state.json', '运行期：窗口尺寸/位置'],
    ['auth.json', '运行期：密钥环之外的凭据文件'],
    ['agentDir/auth.json', '运行期：上面那个的带路径写法'],
    ['workspaces.json', '运行期：工作区列表'],
    ['sessions.json', '运行期：会话索引'],
    ['messages.json', '运行期：会话消息'],
    ['plugin.json', '插件夹具里的 manifest 旧名'],
    ['mcp.json', '运行期：MCP 配置（项目级那份还要信任才读）'],
    ['.pi/mcp.json', '同上，带项目路径的写法'],
    ['models.json', '运行期：模型清单'],
    ['secrets.json', '运行期：明文密钥的旧方案（已被密钥环取代）'],
    ['pnpm.mjs', '外部工具：pnpm 的 JS 入口，不在本仓库'],
    ['config.ts', '行文举例：审批那段在说「agent 想改某个文件」'],
    ['sidecar-minimal.ts', '举例：PI-SDK-NOTES 里写的一个最小脚本示例'],
    ['models-store.json', '运行期：上游 pi 的模型缓存文件']
  ])
  /**
   * 外部/上游的路径一律跳过：
   *  - `P/` `AI/` `AC/` 是 `PI-SDK-NOTES.md` 开头那张缩写表定义的**上游包路径**
   *    （指向 `node_modules/@earendil-works/…`，不是本仓库的源码）；
   *  - 含 `...` 的是省略号缩写（`.../pi-coding-agent/dist/core/sdk.d.ts`）。
   */
  const UPSTREAM_ABBREVIATIONS = ['P/', 'AI/', 'AC/']
  const isExternalExample = (name) =>
    name.includes('...') || UPSTREAM_ABBREVIATIONS.some((prefix) => name.startsWith(prefix))
  /**
   * 反引号里的**代码文件名**也要存在。
   *
   * 文档里既写全路径（`packages/agent-host/src/runtime.ts`）也写裸文件名
   * （「`translate.ts` 把事件归一化」——目录由上下文决定）。所以先给仓库建一份文件名索引：
   * 带斜杠的按**路径后缀**匹配，裸文件名按 **basename** 匹配。
   *
   * 第一版是「拿一组固定根目录去拼」，于是 `translate.ts` / `runtime.ts` / `paths.ts`
   * 这类裸名字全报「找不到」—— **检查的写法不对，不等于文档错了**。
   */
  const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-bundle', 'out', 'release', '.git', '.tmp-warm-flow'])
  const fileIndex = []
  const walkRepo = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue
      const full = join(dir, entry.name)
      let isDir = entry.isDirectory()
      if (!isDir && entry.isSymbolicLink()) {
        try {
          isDir = statSync(full).isDirectory()
        } catch {
          isDir = false
        }
      }
      if (isDir) walkRepo(full)
      else fileIndex.push(full.slice(repoRoot.length + 1).split('\\').join('/'))
    }
  }
  walkRepo(repoRoot)
  const basenames = new Set(fileIndex.map((path) => path.split('/').pop()))
  const hasFile = (name) =>
    name.includes('/') ? fileIndex.some((path) => path.endsWith(`/${name}`) || path === name) : basenames.has(name)

  for (const relative of docFiles) {
    const full = join(repoRoot, relative)
    let text
    try {
      text = readFileSync(full, 'utf8')
    } catch {
      continue
    }
    const dir = dirname(full)

    // 1) markdown 链接指向的本地文件
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = match[1]
      if (/^[a-z]+:/i.test(target) || target.startsWith('#')) continue
      const pathOnly = target.split('#')[0]
      if (!pathOnly) continue
      linkCount += 1
      if (!existsSync(join(dir, decodeURIComponent(pathOnly)))) {
        badLinks.push(`${relative} → ${target}`)
      }
    }

    // 2) `§N.M` 小节引用：**本文件自己的小节 ∪ ARCHITECTURE 的小节**都算数。
    //    （PI-SDK-NOTES 里 `§2.2` 指的是它自己那一节，不是主文档的 —— 第一版把这条误报了。）
    //
    //    **反引号里的小节号不算引用**：那是「举例说明」，不是「让你去看某一节」
    //    （§7.15 里就写了 `§99.9` 当反面例子 —— 第一版把它当成真引用，报了一条假红）。
    //    脚本名不这样处理：`pnpm verify` 这类**通常就写在反引号里**，跳过它等于不检查。
    const ownSections = sectionsOf(text)
    const refScanText = text.replace(/`[^`\n]*`/g, '``')
    for (const match of refScanText.matchAll(/§(\d+(?:\.\d+)*)/g)) {
      sectionCount += 1
      if (!ownSections.has(match[1]) && !architectureSections.has(match[1])) {
        badSections.push(`${relative} → §${match[1]}`)
      }
    }

    // 3) `pnpm <script>` 里的脚本名
    for (const match of text.matchAll(/pnpm (?:run )?([a-z][a-z0-9:-]*)/g)) {
      scriptCount += 1
      if (PNPM_BUILTINS.has(match[1])) continue
      if (!scripts.has(match[1])) badScripts.push(`${relative} → pnpm ${match[1]}`)
    }

    // 4) 反引号里的代码文件名（排除运行期产物、外部工具、举例）
    for (const match of text.matchAll(/`([A-Za-z0-9._/-]+\.(?:ts|tsx|mjs|json))`/g)) {
      const name = match[1]
      if (NOT_REPO_FILES.has(name) || isExternalExample(name)) continue
      fileCount += 1
      if (!hasFile(name)) badFiles.push(`${relative} → ${name}`)
    }
  }

  check(
    `文档里的本地链接都能找到目标（查了 ${linkCount} 条）`,
    badLinks.length === 0,
    JSON.stringify([...new Set(badLinks)].slice(0, 8))
  )
  check(
    `文档里的 §小节引用都存在（查了 ${sectionCount} 条）`,
    badSections.length === 0,
    JSON.stringify([...new Set(badSections)].slice(0, 8))
  )
  check(
    `文档里提到的 pnpm 脚本都存在（查了 ${scriptCount} 条）`,
    badScripts.length === 0,
    JSON.stringify([...new Set(badScripts)].slice(0, 8))
  )
  check(
    `文档里提到的代码文件都存在（查了 ${fileCount} 条）`,
    badFiles.length === 0,
    JSON.stringify([...new Set(badFiles)].slice(0, 8))
  )
}

/**
 * 文档里的**数字**也要盯：§8.5 写着「主 chunk ≤ 1350 KB（当前 N）」「JS 总量（当前 M）」。
 *
 * 阈值由 `verify:bundle` 守，但**「当前值」是散文里的快照** —— 它不会自己更新，
 * 而 UI 每加一点东西都会让它漂（第 56 轮发现它从 1172 涨到了 1187，而没有任何检查会红）。
 * 所以这里直接量一次产物、与文档里的数字比对。
 *
 * 产物不在时（没构建过渲染层）**跳过并说明**，不假装验过。
 */
console.log('\n── 文档里的体积快照 ──')
{
  const doc = readFileSync(join(repoRoot, 'docs', 'ARCHITECTURE.md'), 'utf8')
  const assetsDir = join(repoRoot, 'apps', 'desktop', 'out', 'renderer', 'assets')
  const htmlPath = join(repoRoot, 'apps', 'desktop', 'out', 'renderer', 'index.html')

  if (!existsSync(assetsDir) || !existsSync(htmlPath)) {
    console.log('  NOTE  渲染层产物不在（先跑一次 pnpm build），跳过体积快照比对')
  } else {
    const html = readFileSync(htmlPath, 'utf8')
    const entry = /<script[^>]+src="[^"]*assets\/(index-[^"]+\.js)"/.exec(html)?.[1]
    const sizes = readdirSync(assetsDir)
      .filter((name) => name.endsWith('.js'))
      .map((name) => ({ name, kb: Math.round(statSync(join(assetsDir, name)).size / 1024) }))
    const mainKb = sizes.find((f) => f.name === entry)?.kb
    const totalKb = sizes.reduce((sum, f) => sum + f.kb, 0)

    const claimedMain = /主 chunk ≤ \*\*\d+ KB\*\*（当前 (\d+)/.exec(doc)?.[1]
    const claimedTotal = /JS 总量不膨胀（当前 (\d+) KB/.exec(doc)?.[1]

    check(
      `文档里「主 chunk 当前 ${claimedMain} KB」与实测一致`,
      claimedMain !== undefined && Number(claimedMain) === mainKb,
      `文档写 ${claimedMain}，实测 ${mainKb}（入口 ${entry}）`
    )
    check(
      `文档里「JS 总量当前 ${claimedTotal} KB」与实测一致`,
      claimedTotal !== undefined && Number(claimedTotal) === totalKb,
      `文档写 ${claimedTotal}，实测 ${totalKb}`
    )
  }
}

/**
 * 文档之间的**自洽**：三处都在说「多少个脚本、多少条断言」，它们必须一致，
 * 而且必须与 `package.json` / README 表格的真实数量一致。
 *
 * 这一类漂移同样不会自己暴露：加了一个脚本、忘了改其中一句，
 * 读者就会看到两个互相矛盾的数字（第 57 轮就发现 §15.10 还写着 23 个脚本 / 1105 条，
 * 而实际已经是 24 个 / 1137 条）。
 *
 * 这几条不需要日志，只读仓库本身 —— 所以它们在任何时候跑都有效。
 */
console.log('\n── 文档之间的数字自洽 ──')
{
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const chainScripts = pkg.scripts.verify
    .split('&&')
    .map((part) => part.trim())
    .filter((part) => part.includes('verify:')).length

  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8')
  const tableRows = readme
    .split('\n')
    .filter((line) => /^\|\s*`pnpm verify:[a-z-]+`\s*\|/.test(line)).length
  const readmeTotal = /\*\*(\d+) 条断言\*\*/.exec(readme)?.[1]

  const arch = readFileSync(join(repoRoot, 'docs', 'ARCHITECTURE.md'), 'utf8')
  const recon = /(\d+) 个脚本逐条一致，总计 (\d+) 条一致/.exec(arch)
  const handover = readFileSync(join(repoRoot, 'docs', 'HANDOVER.md'), 'utf8')
  const handoverChain = /链里 (\d+) 个脚本/.exec(handover)?.[1]

  check(
    `HANDOVER 说的「链里 ${handoverChain} 个脚本」= package.json 里的实际链长 ${chainScripts}`,
    Number(handoverChain) === chainScripts,
    `HANDOVER 写 ${handoverChain}，实际 ${chainScripts}`
  )
  check(
    `§15.10 说的「${recon?.[1]} 个脚本逐条一致」= README 表格里 ${tableRows} 行 verify:*`,
    Number(recon?.[1]) === tableRows,
    `§15.10 写 ${recon?.[1]}，README 表格 ${tableRows} 行`
  )
  check(
    `§15.10 说的「总计 ${recon?.[2]} 条」= README 里的总计 ${readmeTotal}`,
    recon?.[2] === readmeTotal,
    `§15.10 写 ${recon?.[2]}，README 写 ${readmeTotal}`
  )
}

/**
 * 「产物未签名」也是一条**会变的事实**：哪天有人配了证书，文档就该同步。
 *
 * 只在 Windows 上、且产物存在时才查（其余情况跳过并说明），
 * 因为这条依赖 `Get-AuthenticodeSignature` 与已打包的 exe。
 */
console.log('\n── 签名状态（文档说产物未签名）──')
if (process.platform !== 'win32') {
  console.log('  NOTE  非 Windows，跳过签名状态检查')
} else {
  const exePath = join(repoRoot, 'apps', 'desktop', 'release', 'win-unpacked', 'i-pi-desk.exe')
  if (!existsSync(exePath)) {
    console.log('  NOTE  打包产物不在（先跑一次 pack），跳过签名状态检查')
  } else {
    let status = 'unknown'
    try {
      const { execFileSync } = await import('node:child_process')
      status = execFileSync(
        'powershell',
        ['-NoProfile', '-Command', `(Get-AuthenticodeSignature -FilePath '${exePath}').Status`],
        { encoding: 'utf8', timeout: 20_000 }
      ).trim()
    } catch (error) {
      status = `查询失败：${String(error).slice(0, 60)}`
    }
    const docText = readFileSync(join(repoRoot, 'docs', 'ARCHITECTURE.md'), 'utf8')
    const docSaysUnsigned = /没有代码签名\*\*：产物未签名/.test(docText)
    check(
      `产物实测 ${status}，文档也写着「未签名」（两边要一致）`,
      (status === 'NotSigned' && docSaysUnsigned) || (status !== 'NotSigned' && !docSaysUnsigned),
      `实测 ${status}，文档${docSaysUnsigned ? '写着' : '没写'}「未签名」—— 若刚配了证书，请同步 §11.1 第 18 条`
    )
  }
}


/**
 * 主题的**三层一致性**：CSS（色值）↔ 注册表（元信息）↔ 共享契约（类型）↔ 主进程（亮暗）。
 *
 * 为什么值得一条守卫：这几处各改一处不会有任何东西报错，症状都是「不报错但不对」——
 * 加了新主题但 CSS 忘了写，人眼只会看到「这个主题和默认那个长得一样」；
 * 删了主题但注册表还留着，菜单里会出现一个点了没反应的项；
 * 主进程漏认一个主题，启动那一瞬间的窗口底色就会错。
 */
console.log('\n── 主题三层一致性 ──')
{
  const themeTs = readFileSync(join(repoRoot, 'apps', 'desktop', 'src', 'lib', 'theme.ts'), 'utf8')
  const css = readFileSync(join(repoRoot, 'apps', 'desktop', 'src', 'styles.css'), 'utf8')
  const shared = readFileSync(join(repoRoot, 'packages', 'shared', 'src', 'types.ts'), 'utf8')
  const mainWindow = readFileSync(join(repoRoot, 'apps', 'desktop', 'electron', 'main', 'window.ts'), 'utf8')

  // 注册表里的主题：id → kind（默认主题也在里面，CSS 里对应 :root 那段）
  const registryThemes = new Map()
  const entryPattern = /id:\s*'([a-z]+)',[\s\S]{0,120}?kind:\s*'(light|dark)'/g
  for (const match of themeTs.matchAll(entryPattern)) registryThemes.set(match[1], match[2])

  // CSS 里的主题段：id → 该段正文
  const cssThemes = new Map()
  const blockPattern = /:root\[data-theme='([a-z]+)'\]\s*\{([\s\S]*?)\n\}/g
  for (const match of css.matchAll(blockPattern)) cssThemes.set(match[1], match[2])

  // 默认主题：CSS 里写在 :root 上（不带 data-theme），取注册表第一个 id
  const defaultThemeId = [...registryThemes.keys()][0]
  const rootBlock = /(?:^|\n):root\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
  if (defaultThemeId !== undefined && rootBlock.length > 0) cssThemes.set(defaultThemeId, rootBlock)

  check(
    `registry 里 ${registryThemes.size} 个主题在 CSS 里都有段`,
    registryThemes.size >= 5 && [...registryThemes.keys()].every((id) => cssThemes.has(id)),
    `registry: ${[...registryThemes.keys()].join(', ')}｜CSS: ${[...cssThemes.keys()].join(', ')}`
  )
  check(
    `CSS 里的 ${cssThemes.size} 个主题在 registry 里都有条目`,
    [...cssThemes.keys()].every((id) => registryThemes.has(id)),
    `CSS 多出来的：${[...cssThemes.keys()].filter((id) => !registryThemes.has(id)).join(', ') || '无'}`
  )

  // 亮暗一致：CSS 段里的 color-scheme 必须等于 registry 的 kind
  const kindMismatch = []
  for (const [id, kind] of registryThemes) {
    const block = cssThemes.get(id)
    if (block === undefined) continue
    const declared = /color-scheme:\s*(light|dark)/.exec(block)?.[1]
    if (declared !== kind) kindMismatch.push(`${id}: registry=${kind} / css=${declared ?? '缺失'}`)
  }
  check(
    '每个主题的 color-scheme 与 registry 的 kind 一致',
    kindMismatch.length === 0,
    kindMismatch.join('；')
  )

  /**
   * 核心 token 齐不齐。
   * 缺一个不会报错 —— 它会**静默继承** fallback 或上一个主题的值，
   * 表现为「这个主题某个地方颜色不对」，很难定位。
   */
  const REQUIRED = [
    '--color-canvas',
    '--color-surface',
    '--color-border',
    '--color-ink',
    '--color-muted',
    '--color-accent',
    '--color-ring'
  ]
  const missingTokens = []
  for (const [id, block] of cssThemes) {
    for (const token of REQUIRED) {
      if (!block.includes(`${token}:`)) missingTokens.push(`${id} 缺 ${token}`)
    }
  }
  check(
    `每个主题都定义了 ${REQUIRED.length} 个核心 token`,
    missingTokens.length === 0,
    missingTokens.slice(0, 8).join('、')
  )

  // 共享契约的联合类型要覆盖 system + 全部主题 id
  const union = /export type ThemePreference =([^\n]+)/.exec(shared)?.[1] ?? ''
  const unionIds = [...union.matchAll(/'([a-z]+)'/g)].map((m) => m[1])
  const missingInUnion = [...registryThemes.keys()].filter((id) => !unionIds.includes(id))
  check(
    `shared 的 ThemePreference 覆盖 registry 的全部 ${registryThemes.size} 个主题 + system`,
    missingInUnion.length === 0 && unionIds.includes('system'),
    `缺：${missingInUnion.join(', ') || '无'}｜system ${unionIds.includes('system') ? '有' : '缺'}`
  )

  // 主进程也要认得每个主题（它决定窗口底色与 nativeTheme）
  const missingInMain = [...registryThemes.keys()].filter((id) => !mainWindow.includes(`'${id}'`))
  check(
    '主进程 window.ts 认得 registry 的全部主题（否则启动底色会错）',
    missingInMain.length === 0,
    `window.ts 里缺：${missingInMain.join(', ') || '无'}`
  )

  /**
   * 语法高亮：**浅色主题必须各自覆盖**。
   *
   * 这条最初写成「所有非默认主题都要覆盖」，结果深色的 graphite 被判红 ——
   * 那是**断言写错了**，不是代码错了：深色主题共用暗色那套语法配色完全合理
   * （同为暗底，对比度一样够）。真正会出问题的是浅色主题沿用暗色配色：
   * 注释与字符串在白底上看不清 —— 这是最初那版 light 主题真实踩过的坑。
   */
  const lightThemesWithoutSyntax = [...cssThemes.entries()]
    .filter(([id]) => registryThemes.get(id) === 'light')
    .filter(([, block]) => !block.includes('--color-syn-keyword:'))
    .map(([id]) => id)
  check(
    '浅色主题各自覆盖了语法高亮配色（深色主题可共用暗色那套）',
    lightThemesWithoutSyntax.length === 0,
    `没覆盖的浅色主题：${lightThemesWithoutSyntax.join(', ') || '无'}`
  )
}

/**
 * 跨包防漂：**思考强度的档位取值，必须与内核逐字一致**。
 *
 * shared 里手写了一份 `ThinkingLevelValue`（因为本项目的硬性分工：
 * `pi-*` 只能在 agent-host 里出现，shared 不能 import 内核类型）。
 * 手写就意味着会漂 —— 内核升一版加了档位、或者改了个拼写，这边不会有任何反应，
 * 而症状是「用户选了某个档位、请求里静默变成了另一个」。
 *
 * 所以这条断言**直接去读内核的 d.ts**，把两边逐个值比对。这是本项目里
 * 唯一一处「跨包比对类型」的检查，值得单独写出来而不是塞进上面那张正则表。
 */
{
  const kernelTypes = join(
    repoRoot,
    'packages/agent-host/node_modules/@earendil-works/pi-agent-core/dist/types.d.ts'
  )
  const sharedTypes = join(repoRoot, 'packages/shared/src/types.ts')

  if (!existsSync(kernelTypes)) {
    check('能找到内核的类型定义（找不到说明依赖树变了，这条断言需要重写）', false, kernelTypes)
  } else {
    const kernelText = readFileSync(kernelTypes, 'utf8')
    const sharedText = readFileSync(sharedTypes, 'utf8')
    const parseUnion = (text, name) => {
      const match = new RegExp(`(?:export )?type ${name} =([^\\n]+)`).exec(text)
      if (!match) return []
      return [...match[1].matchAll(/["']([a-z]+)["']/g)].map((entry) => entry[1])
    }
    const kernelLevels = parseUnion(kernelText, 'ThinkingLevel')
    const sharedLevels = parseUnion(sharedText, 'ThinkingLevelValue')

    check('内核的档位定义读得到', kernelLevels.length > 0, `读到：${kernelLevels.join(',') || '空'}`)
    check('shared 的档位定义读得到', sharedLevels.length > 0, `读到：${sharedLevels.join(',') || '空'}`)
    check(
      'shared 的档位与内核**逐字一致**（顺序也一致，便于人眼比对）',
      kernelLevels.join(',') === sharedLevels.join(','),
      `内核：${kernelLevels.join(',')} ｜ shared：${sharedLevels.join(',')}`
    )
  }
}

console.log(`\n（检查了 ${checkedFiles} 个文件）`)
console.log(`\n${failures === 0 ? 'ALL_PASS' : `FAILURES=${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
