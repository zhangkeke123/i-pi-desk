# 交接清单

> 这份文档面向**接手这个项目的人**。目标不是复述架构（那是 [ARCHITECTURE.md](./ARCHITECTURE.md)），
> 而是把三件最花时间的事一次说清：**现在有什么**、**什么是刻意不做的**、**什么只有真实环境才能验**。
>
> 架构与逐条取舍在 [ARCHITECTURE.md](./ARCHITECTURE.md)；pi SDK 的实测坑在
> [PI-SDK-NOTES.md](./PI-SDK-NOTES.md)；控制面契约在 [CONTROL-PLANE.md](./CONTROL-PLANE.md)。

---

## 0. 交付状态与自查方式（先读这一节）

**状态一句话**：目标里那 12 条要求（三进程桌面壳、agent 工具闭环、多 provider、会话持久化、四块面板、skills 与插件、控制面接入点、代码 + 架构文档 + 里程碑计划）**都有可复核的证据**（唯一没验的是「只有真实端点 / 真实机器才能验」的那几条，逐条列在 §4，并明确标注为未验证）。

### 自己跑一遍（约 8 分钟，全部离线）

```bash
pnpm install
pnpm verify                       # 全量验证链（typecheck + 单测 + verify:* + 渲染层端到端 + 体积守卫）
pnpm --filter @i-pi-desk/desktop run pack
pnpm --filter @i-pi-desk/desktop run verify:packaging   # 打包配置与产物结构
pnpm --filter @i-pi-desk/desktop run verify:packaged    # 真启动打包产物
```

三条把「结论」变成证据的命令：

| 命令 | 它证明什么 | 实测耗时 |
|---|---|---|
| `node tools/objective-evidence.mjs <日志>` | 目标 12 条逐条对上脚本与产物（缺一条就红） | 秒级 |
| `node tools/reconcile-counts.mjs <日志>` | README 里逐脚本的断言数与日志**逐条一致** | 秒级 |
| `node tools/clean-checkout.mjs` | **只有源码的副本**能装、能构建、能跑验证，且构建可复现 | 数分钟 |

（把 `pnpm verify` 的输出重定向到文件即可当 `<日志>` 用；后两条打包命令要接在同一份日志后面，
`reconcile-counts` 取决于脚本横幅。）

### 只有你能做的两件事
1. **装上 `i-pi-desk-0.1.0-win-x64-setup.exe` 用一次* ——解包目录与便携版都已实测能跑）   但「真的装到系统上」会改动本机环境，所以留给你（? 有一条专门说这个）。2. **给我一个真实模型端点*（OpenAI / Anthropic / Gemini 任一家，或内网vLLM/Ollama）——   §4 里一半的未验证项会一次清掉，而且那是唯一可能在*协议层*而不是我们代码里发现问题的地方、
---

## 1. 三分钟上所
```bash
pnpm install
pnpm dev            # 会自己确信Electron 二进制、构建packages、再起窗口pnpm verify         # 全量验证（一条26 段的链：typecheck + 单测 + 22 个跨包`verify:*` + 渲染层端到端 + 体积守卫，共 1455 条断言（```

环境：Node ≀22.19、pnpm ≀10。*不需要Rust 工具链*（这是与上游最大的工程差异）。
终端面板需要`node-pty` 一Electron ABI 匹配：`pnpm rebuild:pty`、本机用的是改写过 vcxproj（关掉Spectre 缓解库要求）的手工构建，**换机器或换Electron 版本都要重编**。
---

## 2. 现在有什么
| 能力 | 状态|
|---|---|
| 三进程骨架（渲染层→主进程→agent sidecar，| ✀有自测|
| agent 闭环：流式输出、工具调用、审批、结果回传、用量与审计 | ✀离线全链路实测（做OpenAI 端点，|
| 权限三档（`readonly` / `ask` / `auto`） 危险命令强制询问 | ✀策略表逐条钉住 |
| 面板：文件树（增删改移、删除进回收站）、CodeMirror 编辑器、差异视图、真 PTY 终端、会话栏 | ✀端到端实测|
| 会话持久化（关掉重开历史还在、模型也还记得） | ✀含真重启实测 |
| skills（渐进式披露、增删、离线校验） | ✀|
| 插件（manifest 契约、独立子进程、工具代理、技能贡献、启停与知情同意，| ✀含失败路径与孤儿进程收尾 |
| 打包（NSIS + 便携版）与产物启动验证| ✀解包目录与便携版已验 |
| 控制面*客户端侧接入点*（登录/ 模型下发 / 技能分可/ 配额 / 审计）| ✀契约 + mock 参考实现+ 21 条验收脚本|
| 文档 | 架构 2900+ 行、SDK 实测笔记 85 KB、控制面契约、本清单 |

---

## 3. 刻意不做的（附原因，别当成缺口）

| 项| 为什么不做| 要做得先有什么|
|---|---|---|
| **Java 控制面的服务端* | 上游没有这个概念；且它属于组织基础设施，认证应委托给既有认证中必| 一个部署环境与运维责任文|
| **插件 OS 级沙箱* | 知情同意 + 最小环境变量+ 进程隔离已经是当前量级的合理防线；真正的沙箱要另一套抽象| 明确的威胁模型（要防的是「恶意插件」还是「手滑插件」） |
| **插件热重载* | 一skills 同一条限制：改文件后要重建会话才生效 | 一个「重载」入口+ 会话重建的代价评会|
| **工作区自带`.pi/` 配置** | 默认会被加载（含执行 `.pi/extensions/*.js`），现已**显式关掉**（?.9，| 一套信任机制（pi 提供 `resolveProjectTrust` 回调，|
| **mac / linux 可运行产物* | native 模块平台相关，Windows 侧的手工构建只能产出 Windows 二进制| 各平台的构建本|
| **代码签名** | 需要一张受信任证书，不是代码能解决的事 | 证书 + 发布流程 |
| **LSP 语义支持**（跳载类型/重命名） | 要LSP 客户端+ 每种语言一个server，是另一个量级| 明确的语言范围 |
| **多标签/ 并排编辑** | 当前是单文件编辑器；并排要重做布局与脏状态管理| 使用者反馈是否真的需要|
| **文件树拖拽移动/ 多选删除* | 拖拽在CDP 下验不了，而破坏性操作必须能验（移动改成了「可点可按的选择器」） | 一套能自动化验证拖拽的手段 |
| **agent 直接使用终端** | 边界声明：终端是给人的，agent 起`bash` 工具（仍需审批，| 会话级审批模型|
| **多窗口* | `workspace` 事件通道已留好，但渲染层选择「打开后主动再拉一次列表、| 一个真实的多窗口需求|
| **SQLite 换掉 JSON 落盘** | 当前量级（万条消息以内）JSON 足够 | 真实的数据量反馈 |

---

## 4. 只有真实环境才能验的（这一路都诚实地标着）
| 项| 怎么验| 成本 |
|---|---|---|
| **真实厂商的流式用量格式差异** | 接一个真实OpenAI / Anthropic / Gemini 端点各跑一轮| 一个key 或一个内网端点|
| **`provider.verify` 的语义缺口* | 协议里没有`modelId`，只能验 `provider.models[0]`；要支持「先保存再验证」得组`ProviderVerifyParams` 加可逐`modelId` | 半天 + 一个端点|
| **Gemini 对插件schema 的接受度** | 插件工具定义会带 `additionalProperties` 这`parametersJsonSchema`，Gemini 历来只吃 OpenAPI 子集 | 一个Gemini key |
| **历史重放的元数据宽容度* | 我们重放的assistant 消息常`usage` / `responseId` 等必填字段，真实厂商的接受度未知 | 同上 |
| **NSIS 安装到系统后的行为* | 解包目录与便携版已验：*没有真的装一遍*（会改动本机环境，| 一台可牺牲的机器+ 用户同意 |
| **冷机器/ 离线安装** | 干净副本验的是*源码自足**（store 是热的），不是「网络无关、| 一台干净机器 |
| **rg / fd 真正下载成功那条路* | 离线/失败/命中三路已验；成功路径要联网拉几 MB 二进制| 可接受在验证链之外单独跑一次|

---

## 5. 如果继续做，我建议的顺序

1. **先接一个真实端点跑一轮。* 第4 节里一半的未验证项会一次清掉，而且这是唯一
   可能在「协议层」而不是「我们的代码」里发现问题的地方、2. **把「只有真实机器能验」的两条补上**（NSIS 安装后验证、冷机器安装）——它们目前是
   交付形态上最后的黑盒、3. 再回到体验缺口：技能插件的重载入口、多标签编辑、文件树批量操作、4. 最后才考虑 SQLite 与多窗口 ——这两条都在等真实需求、
### 三个「杠杆」候选（成本低、收益明确）

- **桌面端自带ripgrep**：去掉「首次使用要联网下载一个二进制」这件事（?.6）。  代价是三平台的产物体积与打包矩阵、- **把`PI_OFFLINE` 暴露成一个设置项**：`grep`/`find` 找不到rg/fd 时会联网下载）  在受限网络里应当能一键关掉（§7.6 已实测该开关的行为）。- **结`provider.verify` 加`modelId`**：见上表、
---

## 6. 维护这套验证的方式（约定比脚本重要）

这一路的验证成本主要不在写脚本，而在**约定**。它们写在[ARCHITECTURE.md](./ARCHITECTURE.md) §15，这里只列最常被违反的几条：

- **数字要数出来。* 断言条数从日志里数，不靠记忆。README 的表格里每个验证脚本都标了条数，
  而`node tools/reconcile-counts.mjs <全量日志>` 会*逐脚本核对*它们（含总计那句）——  加断言时顺手核对一次，成本是一条命令、- **对照是必需的。* 断言「X 消失了」对「X 从来没出现过」和「一次删干净了」是同样瞎的 ——  每条「不该发生」都要配一条「该发生的确实发生了」。- **守卫要做 A/B。* 新加的断言要能证明**它会红*：临时把修复改回去，看它报不报、  这一路每个安全守卫都做过这一步「- **等待要有上限，且上限要能被断言。* 「卡住」和「很慢」在日志里长得一样、- **红了先问它观察到了什么。* 这一路十几次红色里有相当一部分是  「脚手架自己错了」（消息正文是部件数组、桩没卸、正则漏抄空格、只查了标package.json）。- **文档里的承诺要能被执行。* `verify:doc-claims` 把「修过的别再坏回去」与
  「引用必须能解析」变成断言；新增修复时顺手加一行，成本很低、
---

### 6.1 「我改了 X，该跑哪个脚本、
24 个脚本分层的全貌，2 个在 `pnpm verify` 链里，另 2 个是打包脚本，要单独跑）。改了哪一块就跑对应那几个；跑全量）2 个脚本）实测 **≀ 分钟**，加打包与产物验证共 ≀ 分钟、
| 你改了什么| 跑这了| 条数 |
|---|---|---|
| **渲染层*（React / 面板 / 交互，| `verify:renderer` | 312 |
| **sidecar 协议 / 内核集成** | `verify:protocol`、`verify:no-persistence`、`verify:history` | 9 + 13 + 28 |
| **审批与权限*（闸门、三档模式、危险命令） | `verify:approval-policy`、`verify:danger-gate`、`verify:approval-timeout`、`verify:allow-always`、`verify:deny-feedback` | 53 + 26 + 16 + 12 + 18 |
| **插件** | `verify:plugins`、`verify:plugin-failure`、`verify:plugin-orphan` | 16 + 26 + 7 |
| **provider / 各家协议适配** | `verify:api-matrix`、`verify:anthropic-history`、`verify:anthropic-tool-loop` | 36 + 33 + 20 |
| **差异预览 / diff** | `verify:diff-preview`、`verify-diff-parse`（单测） | 17 + 27 |
| **工作区/ 文件操作** | `verify-workspace-fs`、`verify-workspace-list`、`verify:renderer` 的文件树段落 | 81 + 26 |
| **项目信任 / 工作区自带配置* | `verify:project-trust` | 10 |
| **rg / fd 这类外部依赖** | `verify:tools-download` | 20 |
| **控制面契约* | `verify:contract` | 21 |
| **打包配置** | `verify:packaging`、`verify:bundle`、`verify:packaged` | 14 + 7 + 22 |
| **文档与数字* | `verify:doc-claims`、`tools/reconcile-counts.mjs` | 35 |

### 6.2 `pnpm test` 里的单测）47 条）

它们不在 `pnpm verify` 的脚本清单里，而是由各包的 `test` 脚本串起来的
（`pnpm test` →`pnpm -r --if-present test`）：

| 位置 | 脚本 | 条数 |
|---|---|---|
| `packages/shared` | `verify-plugin-manifest.mjs` | 56 |
| `packages/agent-host` | `verify-approval-preview.ts` | 20 |
| `apps/desktop` | `verify-provider-key.ts` | 22 |
| `apps/desktop` | `verify-window-state.ts` | 15 |
| `apps/desktop` | `verify-diff-parse.ts` | 27 |
| `apps/desktop` | `verify-workspace-fs.ts` | 81 |
| `apps/desktop` | `verify-skills.ts` | 39 |
| `apps/desktop` | `verify-pty-failure.ts` | 21 |
| `apps/desktop` | `verify-close-guard.ts` | 12 |
| `apps/desktop` | `verify-session-scope.ts` | 15 |
| `apps/desktop` | `verify-workspace-list.ts` | 26 |

> 771（验证脚本）+ 334（单测）= **1105 条*，与 README 末尾那句总计一致，
> 可以随时用`node tools/reconcile-counts.mjs <全量日志>` 复核、
---

## 7. 已知的坑（踩过的，别重踩）
| 坏| 说明 |
|---|---|
| **pnpm 的包目录是符号链接* | 任何遍历脚本都要用`statSync`/`realpathSync` 判断目录，`dirent.isDirectory()` 对symlink 返回 false ——否则会静默扫出、 个文件」并得出错误结论 |
| **Windows 一ESM 的import 说明符必须是 `file://` URL** | 再`import ... from "D:\\..."` 会以 `ERR_UNSUPPORTED_ESM_URL_SCHEME` 立刻退出|
| **`pnpm 11` 默认不跑 `pre`/`post` 脚本** | `enable-pre-post-scripts` 默认 false；入口必须显式串联前提（§15.6）|
| **模板字符串里的注释不能有未转义反引号** | 会直接编译失败；仓库里有一个扫描脚本把这条变成前置守卫 |
| **`SessionManager` 的`projectTrusted` 默认 true** | 不显式关掉，工作区里的`.pi/` 扩展会被加载并执行（§7.9，|
| **pi 的`tools` 数组同时是白名单** | 插件工具必须并进去，否则「插件已激活、技能进了提示、工具却不可用、|
| **canvas 的`fillStyle` 不做色彩空间转换** | 想把 `oklch()` token 喂给不认 CSS 变量的库（xterm）时，用「设 `fillStyle` 再读回来。*不会**归一化成 `#rrggbb` ——Chrome 原样返回 `oklch(...)`。可靠办法是 `fillRect` + `getImageData` 读像素（任何色彩空间都会被光栅化成sRGB）。第一版用了错误办法，终端悄悄退回黑底白字且不报错（§15.11（|
| **`nativeTheme.themeSource` 不能先解析再设* | 主题偏好是`system` 时必须原样交组Electron。先解析成`light`/`dark` 再设，等于把「跟随系统。*钉死**在启动那一到——系统事后切亮暗，渲染层的 `matchMedia` 监听再也不会触发（?5.11（|
| **`electron-vite dev` 可HMR 渲染层* | 改了 `electron/main/**` 同dev 进程**不会重启**，主进程的改动看起来「没生效」。验证主进程行为前必须先重启 dev（症状：渲染层的主题切换正常，但 `prefers-color-scheme` 不变，|
| **「用户拒绝」的机器信号不是你以为的那个** | 主机把用户拒绝记成`state: 'failed'` + 一段*写给模型真*的错误文案（「用户拒绝执行…。请换一种方式…」），`state === 'denied'` 这条路径在真实运行里没被用到。只在单元测试里构逐`denied` 会一路绿灯，直到端到端拒绝一次审批才露馅（?5.17，|
| **`x !== null` 这种断言看不见「东西根本不存在。* | 判「卡片出现过」写成`headline !== null`：卡片缺失时它是 `undefined`，而`undefined !== null` 为真 ——于是「卡片没有渲染」这种情况反而是绿的。A/B（把卡片关掉再跑）才暴露） 条断言只红了3 条。改用`typeof —=== 'string'` 这类**要求真值存在*的断言（?5.17，|
| **补丁脚本在替换之后又重读了文件* | 脚本里`replace` 成功后，为了改另一处又 `readFileSync` 了一次——于是把刚写好的第一处修复*丢掉了*，而日志照样打印「已改掉」（因为替换当时确实成功）。症状是文档守卫仍然红、但脚本说改好了。改法：一次读、多次改、最后一次写；改完再 `grep` 确认（?5.18，|
| **测试依赖了前序段落的界面状态* | 文件面板一关就**卸载**，重开时展开状态回到根都——于是后面靠「文件树里有 hello.ts 这一行」的段落件`no-row` 失败，而那个信息看起来像「文件丢了」。修法是让每段*自己摆好前提**（打开面板 + 按目录名展开）。定位过程中真正起作用的是*把现场打出来**（面板状态/ 目录行标题/ 行文本）；中间按旧界面写法猜了两次（「进具src」这类按钮并不存在），两次都错（§15.19，|
| **A/B 的破坏方式必须构建安全* | 第一次把 `onChange` 改成 `() => undefined`，结果一个import 变成未使用→TS 报错 →构建失败 →自测件*退出码 2） PASS 0 FAIL：*结束。那不是「断言变红」，而是**什么都没验到*。破坏要挑「仍然能编译、但行为错了」的方式（?5.22，|
| **两个功能会互相撞上，而现象指向第三个地方** | 重启那一段故意把窗口设成 1040×720（验「尺寸被记住」），而这一轮新增的紧凑侧栏阈值是 1080 ——于是重启后侧栏是图标条。*里面没有会话列表**，长会话那一段以 `no-row` 失败（看起来像「那个会话不存在」，实际是「界面正处在紧凑模式」）。排查靠的是**把侧栏里的行打出来*：只有五个图标按钮（§15.22，|
| **类型错误能一路绿过端到端** | pageSessions 返回 readonly、下游要可变数组 ——端到端用 esbuild **不做类型检查*，所以全绿；一次顺手跑的typecheck 才发现。改完代码要跑typecheck，别只信端到端|
| **整词替换误伤别处（又犯了，* | 给自测变量加前缀时把**另一个段落*的同名变量也改了，那一段立刻ReferenceError（用了还没声明的变量）。替换脚本现在必须打印「每个新名字声明了几次」，并只回退自己那一段*之后**的行 |
| **命令没有失败即停** | typecheck 已经报错，命令却继续跑完了dist ——于是**装上去的还是旧包**，现象像「改动没生效」。构建类命令一律失败即停（§15.25，|
| **JSX 注释放在 return ( 的根元素之前** | 花括号注释是表达式，和根元素并排就是两个兄弟节点 →语法错误。注释要么在根元素内部，要么放在 return 之前 |
| **幂等/存在性判断要查对对象（反复犯：* | 判断「import 有没有加过」时查的是*用法**（文件里当然有那个名字）→import 永远没加上，一路走到typecheck 才暴露。同类：文档里只要出现过某三个字就跳过更新、判断夹具种子用了另一段文字。替换脚本现在一律先打印「每个新名字声明了几次」（§15.26）|
| **自测段落的「位置」就是状态契约* | 把新写的「项目」段放在「最近目录」段之前，它切换工作区之后，后者以 `no-recent-entry` 红了 6 条——现象指向「最近目录坏了」，真因是上一段改了状态。新增段落必须自己想清楚「我从谁手里接状态、我留给下一段什么状态」（§15.26）|
| **有些端到端段落天生会抢全局状态* | 「项目」分组（别的目录的会话）在自测里试了三种位置、两种还原方式：它必须切走工作区，而相邻的「最近目录」段依赖「此刻还在那个目录」，于是每次都以 `no-recent-entry` 红一版——现象永远指向「最近目录坏了」。最后把它的**逻辑**抽成纯函数用 8 条单测钉住，端到端段落撤掉并写明原因：*「点一下真的切过去」如实记为未覆盖**（手工验过，但手工验证不算覆盖） |
| **按需加载的chunk 要轮询等待，不能只等一次* | `verify:packaged` 里「打包后能打开代码编辑器」曾经以 `no-editor` 失败：它点完文件等900ms。*查一次*就下结论，而编辑器 chunk 有762 KB，从 asar 里冷加载 + CodeMirror 初始化经常超这1 秒——现象看起来像「打包后编辑器坏了」，我用独立探针跑同一个`win-unpacked` 产物（等 9 秒）一次就过、且无任何console 报错。改成最大10 秒的**轮询**后稳定通过。同类：凡是按需加载的东西（编辑器/ 终端 / 启动面板），断言都要轮询而不是「等一下再看一眼、|
| **不要在PowerShell 里用内联 `node -e` 改文件* | 引号、单引号与反斜杠会被 PowerShell 先解析一遍：脚本要么语法错误、要么静默改了别的东西。这个错我这个会话里犯了**三次**，每次都要重跑一遍构建或自测。一律写成`.mjs` 文件写`node 文件` ——同一条也适用于「用脚本改文件」之外的所有多行脚本|
| **在侧栏里加可点元素要避开「扫所有button」的段落** | 给侧栏加「项目」行时用 `<button>` 渲染，结果*25 条完全无关的断言**级联变红（现象是「编辑器打不开」「切工作区不弹确认框」）。真因：自测里有若干段落是「扫页面上所有button、按文字找目标」的（文件树里点目录名与文件名（例如夹具里的 `src` 与它下面的示例文件）），多出几个「目录名+会话数」的按钮就被误抓。改用`<div role="button">` 后级联归零，可访问性也保住了（§15.26）|
| **hook 加在提前 return 之后** | 侧栏的紧凑模式是「if (compact) return 轨道」，我把 useState 加在了那一return **之后**。首次渲染走完整分支没事：*重启后窗口1040px（紧凑）→设宽 →再走完整分支**时hook 数量变多 →React 报错。*整个侧栏消失**，端到端一次红 10 条（现象全是「找不到侧栏里的东西」）。hook 必须无条件、放组件最上面（?5.25，|
| **上一次运行留下的假模型进程还占着端口** | 新起的mock 绑定失败后*安静地退出*，整套自测一路在跑*旧进程*说话 ——现象是「新加的行为完全没生效」（`@loop4` 不循环），而日志里看不出异常。排查时先后怀疑了 mock 代码、界面接线、设置同步，最后靠**设mock 记录它收到的最后一条用户文本*才发现：记录里根本没这个字段，连的不是我改的那个进程。修法是自测里加**端口守卫**；守卫本身也要用**连接**探测而不是bind（TIME_WAIT 会让 bind 误报，于是自测在开跑前就退出，0 PASS 0 FAIL）（§15.23）|
| **`Emulation.clearDeviceMetricsOverride` 不触发resize** | 窄窗口那段用 CDP 改视口验完，只调 clear 就以为还原了 ——它不会触发`resize` 事件，界面*停在折叠状态*，后面所有依赖会话列表的段落全崩（一次红了30 条）。改成显式`setDeviceMetricsOverride` 设回一个宽视口（?5.22，|
| **端到端里「应用重启」之后必须用新的连接** | 自测在中段会重启应用（验「重启后内核还记得对话吗」），之后所有操作都必须走新的client。我新加的一段放在重启之后、却用了旧连接的 `evaluate` ——对一条已断的连接 `await` **永远不会返回**：现象是自测停在那一节直到超时，而两次运行停在*完全相同的日志行数*上。排查时先后怀疑了夹具与断言，真因是连接对象（?5.21（|
| **`file://` 加载的样式表读不到`cssRules`** | 「断言某个 CSS 规则存在」的第一版是遍历 `document.styleSheets` 打`pre { min-height }` ——在打包后的应用里永远是空数组（Chromium 把file:// 样式表当成跨源，访问 `cssRules` 抛异常被 catch 吞掉），而在开发服务器上却是好的。改法是**在带生产类名的容器里塞一个探针元素量高度**（?5.20（|
| **根链路里的`verify:x` 必须在根 package.json 有转发脚本* | 往链里加一条`verify:thinking-level` 时，它其实是 **agent-host 包里的脚本* ——根包没有同名转发，于是整条链在跑到那里时件`Command not found` 崩掉，*0 FAIL 却早退**，现象很像「某个自测挂了」）。照抄邻居的写法：根包加 `verify:x = pnpm --filter @i-pi-desk/agent-host run verify:x`（?5.20（|
| **按`title` 的精确选择器会被「给按钮加个后缀」打方* | 把按钮`title` 从「工作区文件」改成「工作区文件（Ctrl + B）」之后，自测里的 `button[title="工作区文件]` 再也匹配不到 ——点击从未发生，而失败信息是「点击文件树打不开文件」。反过来也踩了一次：技60 处统一改成前缀匹配后又「只保留 4 个」还原，而其中一处本来就靠*会话标题前半段*定位（`[title^="e2e-等审批A，]`），被还原成精确后永远匹配不到。*一律替换+ 部分还原**这种改法本身就在制造误伤（§15.19，|
| **补丁脚本的「幂等检查」可能匹配到另一个组件* | 用`if (!text.includes('const pickWorkspace = ...'))` 判断「要不要插入」时，这个名字已在*别的组件**里存在，于是整块插入被静默跳过——类型检查随后报「找不到名字」，而原因在补丁脚本里（§15.16 的实现过程）。改法是按*文件+组件**范围判断，而不是全文件搜一个名字|
| **窗口真的被关掉之后，CDP 求值永不返回* | 自测里若有一步「假定窗口还在」，一旦前置条件不成立（例如编辑器没打开 →没有未保存改动→主进程不拒close），`window.close()` 会*真的把窗口关掉*，之后的每次 `evaluate` 都挂作——现象是*整个套件卡死**而不是给出一条失败。防法两条：固定等待改成轮询；前置条件不成立时立刻抛错退出那一段（由外层catch 记FAIL、finally 收进程） |
| **写好的组件没人引用，不会有任何东西报譀* | `ThemeGrid` 写好了、导出了、类型检查通过，但**没有任何地方用它** ——界面看起来只是「没换」，很容易被当成还没做（§15.13）。防法：从界面点进去断言（卡片数、点击后 `data-theme` 变化），而不是搜代码里有没有这个符号 |
| **`StrictMode` 会把 effect 跑两次* | 开发模式下 `App` 的effect 双调用；`init()` 里的事件订阅**没有退计*就会挂两套监听→**每条消息在界面上出现两遍**（磁盘上的会话文件是干净的，纯渲染层重复）。打包版不双调用，所以生产没这现象、断言也不会红 ——只能靠「把界面截下来看」发现（§15.12，|
| **`live` 清空后，已定稿消息里的工具状态没人更新* | 助手消息在工具*还没跑完**时就定稿（写文件要先问授权），此后状态在 `live` 与磁盘上继续前进，但渲染层持有的定稿副本是冻结的 →工具卡永远停在「等待中」。只查store 数据的断言看不见它，必须断言**渲染结果**（?5.12，|
| **`pnpm pack` 不会刷新安装包* | 它只重做解包目录（`release/win-unpacked`，也就是 `verify:packaged` 验的那份）；**NSIS 安装包与便携版只有`pnpm dist` 才会重新生成**。于是可能「源码修完、验证全绿、用户手上的安装包却是旧的」——第 59 轮真的撞上了（装完发现`resources/` 里连 `THIRD-PARTY.md` 都没有）。`verify:packaging` 现在会在安装包比源码旧时打一行NOTE 提醒 |
| **pi 的`TOOLS_DIR` 在import 期固包* | `isolation.js` 必须早于 pi 求值，否则 rg/fd 会下载进用户主目录|
| **审批白名单的键是 `工具名+ JSON.stringify(参数)`** | 文案必须说清「只记相同参数、只在本会话」，否则承诺比实现大（?.3）|

---

## 8. 交付物在哪
> **界面与交互的设计程*：`docs/UI-DESIGN.md`（状态定义+ 组件规格 + 交互流程 + 验收判据 + 差距清单）；
> **可点原型**：`docs/ui-mockup.html`（单文件、零依赖，双击打开；可切五套主题、可点审批卡、可跑一遍思考→流式）。> 两者都是*设计**，实现进度以 §0 的交付状态为准、
| 交付物| 位置 |
|---|---|
| 可运行代码| `apps/desktop`（壳与面板）、`packages/agent-host`（内核与 sidecar）、`packages/shared`（契约） |
| 架构文档 | [docs/ARCHITECTURE.md](./ARCHITECTURE.md) |
| 里程碑计划与**未验证清单* | ARCHITECTURE §11（3 条，逐条标明验证到了哪一步） |
| 控制面契约| [docs/CONTROL-PLANE.md](./CONTROL-PLANE.md) + `tools/mock-control-plane/` |
| 验证 | `pnpm verify`（链里24 个脚本）+ 2 个打包脚本；逐脚本断言数写在README 表格里（`tools/reconcile-counts.mjs` 可核对） |
| 打包产物 | `apps/desktop/release/`（NSIS 安装包+ 便携版） |
| 第三方许可与内核归属 | [THIRD-PARTY.md](../THIRD-PARTY.md)（MIT 声明：*随产物分口*别`resources/THIRD-PARTY.md`，由 `verify:kernel-deps` + `verify:packaged` 盯着，|

---

## 9. 目标兑现核对行
这一节的用途是**让「做完了没有」可以被核对**，而不是靠叙述、
> **可执行版本*：ode tools/objective-evidence.mjs <全量日志> 会把下面这张表跑一遍> ——逐条报出对应脚本的断言数与产物是否在位，任何一条证据缺失它就红、左边是当初提的每一条，右边是仓库里对应的东西与**可执行的证据**。
| # | 目标里的要求 | 仓库里的对应物| 证据（可跑） |
|---|---|---|---|
| 1 | Electron + React + TypeScript + Vite | `apps/desktop`（electron-vite：main / preload / renderer 三份产物）、`packages/*` 全TS | `pnpm typecheck`、`pnpm build`、`pnpm verify:bundle`） 条，含产物结构与按需 chunk，|
| 2 | 复用 `@earendil-works/pi-*`（MIT）作内核 | `packages/agent-host` 只依赖这三个 MIT 包；上游 LGPL 项目**只作架构参考、零源码复制**（`docs/ARCHITECTURE.md` §0（| `pnpm verify:protocol`） 条，内核边界之外的线协议）、`docs/PI-SDK-NOTES.md`（5 KB 实测笔记，|
| 3 | 可跑的桌面壳 + 三进程架构| main（薄编排 + 唯一数据 owner） preload / renderer / agent sidecar；sidecar 崩溃有监督与重启 | `pnpm dev`、`pnpm verify:renderer`（12 条，真窗口+ CDP）、`verify:packaged`（2 条，**打包产物真的启动起来**（|
| 4 | agent 会话与工具调用闭环| 工具零`read / grep / find / ls / write / edit / bash / powershell`（pi 时`glob`，其等价物是 `find`）、流式输出、审批、结果回会| `verify:api-matrix`（6 条，四种协议下工具定义与请求构建）、`verify:anthropic-tool-loop`（0 条，一次完整往返）、`verify:renderer` 的agent 循环与审批段落|
| 5 | 多模型provider 配置 | provider CRUD + 密钥环加密（DPAPI/Keychain） 四种 `apiStyle` + 内网端点预设 | `verify-provider-key`（2 条单测）、`verify:api-matrix`、`verify:renderer` 的provider 段落 |
| 6 | 会话持久化| 主进程落盘（JSON） 内核内存 + **重启后把历史回灌**（模型也记得）| `verify:history`（8 条）、`verify:no-persistence`（3 条，内核不落盘）、`verify:renderer` 的重启段落（5 条） |
| 7 | 工作区/ 编辑器/ 终端 / 差异等面板| 文件树（增删改移、删除进回收站）、CodeMirror 6 编辑器、真 PTY 终端（多标签）、差异视图（上下/并排，| `verify:renderer`（12 条覆盖四块面板）、`verify-workspace-fs`（1 条）、`verify-skills`（9 条）、`verify-pty-failure`（1 条）、`verify:packaged`（在打包产物里再验一遍面板） |
| 8 | skills 与插件扩展机制| skills（渐进式披露、增删、离线校验）；插件（manifest 契约与校验、独立子进程、最小环境变量、工具代理、技能贡献、启停与知情同意，| `verify:plugins`（6 条）、`verify:plugin-failure`（6 条）、`verify:plugin-orphan`） 条）、`verify-plugin-manifest`（6 条单测）、`docs/ARCHITECTURE.md` §10 |
| 9 | 对齐控制面（登录 / 模型下发 / 技能分可/ 配额 / 审计）的**接入点* | 契约 `docs/CONTROL-PLANE.md`、可跑的最小参考实现`tools/mock-control-plane/`、客户端侧接入（登录态、模型与技能下发、用量上报、审计事件） | `verify:contract`（1 条验收脚本）、`verify:renderer` 的控制面段落。*服务端不在本仓库、不在交付范围*（?.0 说明了原因） |
| 10 | 交付包含可运行代码| `apps/desktop` + `packages/{shared,agent-host}`；`tools/clean-checkout.mjs` 证明**只有源码的副本也能装、能构建、能跑验证* | `node tools/clean-checkout.mjs`） 正+ 产物名一致） |
| 11 | 交付包含架构文档 | `docs/ARCHITECTURE.md`（900+ 行、8 个编号小节）、`docs/HANDOVER.md`、`docs/PI-SDK-NOTES.md`、`docs/CONTROL-PLANE.md` | `verify:doc-claims`（5 条：引用可解析、过时说法不留） |
| 12 | 交付包含里程碑计划| `docs/ARCHITECTURE.md` §11 的M0–M6 表（含每阶段的验收标准与状态）+ §11.1 的未验证清单）3 条，逐条标明验到哪一步） | 里程碑表的每一行都指向对应的`verify:*`；未验证清单里凡已实测的条目都注明了小节 |

### 三条要如实说的边界
1. **控制面只有客户端侧接入点**，服务端不在交付范围内。这是刻意的范围决定）   理由写在 §9.0（上游没有这个概念；服务端属于组织基础设施）。2. **有一批「只有真实端点真实机器才能验」的项*：真实厂商的流式与用量格式差异、   `provider.verify` 编`modelId`、Gemini 对插件schema 的接受度、NSIS 装到系统后的行为、   冷机器离线安装、rg/fd 真正下载成功那条路。清单在 §4，逐条写了怎么验与成本、3. **`glob` 这个名字**：目标里写的是`glob`，而pi 当前的工具名是`find`
   （风险表里还留着 `glob` 的旧名，两者都是只读类）。功能对得上，名字对不上）   这里明说一句，免得接手的人去找一个不存在的工具、