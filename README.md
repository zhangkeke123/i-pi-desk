# i-pi-desk

> 本地优先的 AI 编程桌面客户端。代码与密钥留在本机，模型可以指向你内网的端点。
>
> 这是一个**从零仿写**的独立实现，架构参考 [`vastsa/PI-Desktop`](https://github.com/vastsa/PI-Desktop)（但**不含**它的任何源代码：它是 LGPL-3.0-or-later 且无 linking 例外，对外分发实质要求整体开源）。真正复用的第三方是 MIT 的 [`@earendil-works/pi-*`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) agent 内核 —— 也就是 PI-Desktop 自己用的那套。

---

## 它是什么
- **三进程架构*：React 渲染层→Electron 主进程（薄编排+ 唯一数据 owner）→ Node agent sidecar（内核+ 工具执行）- **自带 agent 闭环**：对话、流式输出、读写文件、跑命令、搜代码
- **权限三态*：`readonly` / `ask`（默认）/ `auto`，危险命令即作`auto` 也会强制询问
- **审批看得到后果*：改文件前先给你真diff，而不是让你盲批准
- **面板**：工作区文件树（**新建 / 重命名/ 移动到—/ 删除，删除走系统回收端*）。*CodeMirror 6 代码编辑器*（语法高亮、括号匹配、自动缩进、撤销历史、搜索、折叠；含并发写保护不*未保存改动保护*）。*差异视图（上一/ 并排可切换）**、*真PTY 终端**（多标签、可跑`vim`/`top`）。编辑器与终端*按需加载**：主 chunk 1300 KB，不打开它们就不必解析这几百 KB
- **会话持久化*：关掉应用再打开，历史还在，**模型也还记得**（重启后追问能接着上文）；会话可重命名、可搜索、删除*有二次确认*；输入框上下键翻阅本会话发过的内容- **随时可中止*：运行中随时能停（卡在审批上也能停），中止后不会留一张点不动的审批卡物- **会话组织**：可按当前目录过滤、可**置顶**（单独一组、不改时间序）、超进30 个给「加载更多」；
  **别的目录里的会话**在「项目」里列出，点一下连工作目录一起切过去
- **发送前能看到「这一次怎么跑。*：模型、权限模式。*思考强度*三个 chip 就贴在输入框下沿）  接近步数上限）0%）会提前提醒，长会话默认只渲染最近40 条- **界面**：五套主题（暖炭默/ 苔绿 / 暖白 / 米黄约/ 高对比）、窄了1080px 侧栏自动折叠成图标条、  设置是整窗面板（左导舀+ 搜索 + 行式布局 + 分段控件）、`Ctrl+K` 快速启动面板与 `?` 键盘地图
- **技能（Skills：*：可复用的团队规范与操作手册，渐进式加载 ——写得多也不占上下文- **插件（Plugins：*：可执行代码扩展，能后agent 注册新工具、附带技能；跑在独立子进程、不继承环境变量、默认不启用
- **控制面接入（可选）**：指向内网的「管理服务」即可统一下发模型与技能、上报用量；**不配也能完整使用**、  > 上游 PI-Desktop **没有**这个概念（ADR 0004 明确不做远程 Gateway）；这里只实现*客户端侧接入点*（  > 服务端不在本仓库、也不在交付范围内。详见[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) §9.0、- **内网一等公永*：Ollama / vLLM / 企业网关这类 OpenAI 兼容端点按预设即可接入- **密钥不落盘明文*：系统密钥环加密（Windows DPAPI / macOS Keychain），只在调用时进内核内存

详见 [架构设计](docs/ARCHITECTURE.md)。另有[pi SDK 集成笔记](docs/PI-SDK-NOTES.md)（6KB，含大量实测坑）。
**界面与交互的设计程*解[docs/UI-DESIGN.md](docs/UI-DESIGN.md)：八种状态的定义与验收判据、组件规格、交互流程与键盘地图、与现状的差距清单；
**现在实际长什么样、以及覆盖到哪一层*在它的[§12](docs/UI-DESIGN.md)（v2：暖色单色、行动色、Geist、整窗设置、侧栏IA）。想先用手感判断，直接打开 [docs/ui-mockup.html](docs/ui-mockup.html)（单文件、零依赖，可切五套主题、可点审批）。
第三方许可与内核归属解[THIRD-PARTY.md](THIRD-PARTY.md)（MIT 声明随产物一起分发）。
**要交给别的agent 继续开发？** 把仓库根的[AGENTS.md](./AGENTS.md) 给它（agent 会自动读它）：详细交接在[docs/AGENT-HANDOFF.md](docs/AGENT-HANDOFF.md)：环境与命令、三条不变式、十条约定。**最贵的十个坏*、现状地图、收尾清单、以及明确的边界、
**要接手这个项目？** 先看 [交接清单](docs/HANDOVER.md) 的**§0**：交付状态一句话、三条把结论变成证据的命令（约 8 分钟跑完）、以及只有你能做的那两件事、那份文档还写了现在有什么、什么是刻意不做的、什么只有真实端点真实机器才能验、
---

## 环境要求

| 依赖 | 版本 |
|---|---|
| Node.js | ≀22.19 |
| pnpm | ≀10 |

不需要Rust 工具链（这是与上游最大的工程差异之一：上游有 ~7.7 万行 Rust 宿主）。
---

## 快速开姀
```bash
pnpm install
pnpm dev
```

`pnpm dev` 自己会把前提造出来：**确保 Electron 二进制在**（缺了就下载，已有则毫秒级返回）
→**构建 `packages/*`**（共享契约+ agent 宿主）→ 资electron-vite 与窗口、不需要先手动跑别的命令、
> **关于「干净检出。*：这三步以前不都是自动的 ——> `dev` 之前该做的两件事写在 `predev` 里，而**pnpm 11 默认不执行pre/post 脚本**
> （`enable-pre-post-scripts` 默认 false），所以它其实从没跑过，> Electron 二进制则要靠手查文档补一次（pnpm 会把「构建副作用」缓存进 store）> 一旦某台机器上手工补过，之后所有安装都会认为「已构建」而跳过）。> 两处都已改成显式串联的自举检查。>
> 这条不是靠读代码发现的，而是**把一个只含源码的副本单独跑了一遍*（> 在没有`dist/`、没有`out/`、没有Electron 二进制的副本里，
> `pnpm typecheck` 会因为`agent-host` 找不到`@i-pi-desk/shared` 的类型而失败，
> `packages/shared` 的测试会因为 import 不到 `dist/index.js` 而失败。> 解§15.6、
### 常用命令

```bash
pnpm dev            # 开发模式（含窗口热重载（pnpm build          # 构建 main / preload / renderer 三份产物
pnpm typecheck      # 全部子包类型检查pnpm test           # 快速自测（越界防御 / 技能文件/ 审批差异预览（pnpm verify         # 一键全量校验：typecheck + 自测 + 渲染层端到端
pnpm rebuild:pty    # 不Electron 重编 node-pty（终端功能需要，见下（pnpm -r build       # 只构建packages/*
```

### 打包

```bash
pnpm --filter @i-pi-desk/desktop run pack   # 解包目录（快，日常用（pnpm --filter @i-pi-desk/desktop run dist   # NSIS 安装包+ 便携版pnpm verify:packaged                        # 验证解包目录能跑
```

> 注意是`run pack` ——`pnpm pack` 会命不pnpm 自己的同名内置命令（打成 tgz），产出完全不是你想的东西、
**打包成功不等于能跑。* 有四类问题只在运行时暴露，而且现象离原因很远（「终端打不开」的原因是asar 打包策略）。所以`verify:packaged` 会真的把产物启动起来，断言 22 条：布局（sidecar 路径 / 插件运行器同目录 / node-pty 已外置）
+ 运行时（真PTY 资shell 并回显、插件被激活且工具注册给内核、生产档 CSP 下不白屏）。
也能直接验最终的便携版产物：

```bash
pnpm --filter @i-pi-desk/desktop run verify:packaged -- --exe "release/i-pi-desk-0.1.0-win-x64-portable.exe"
```

> 国内网络下打包需要镜像（否则 electron-builder 原GitHub 下载工具二进制会超时）：
> ```powershell
> $env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
> $env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
> ```

### 终端功能需要一步额外操作
终端用的是`node-pty`（编译型原生模块）。*不编译它，应用照常启动，只是终端面板会显示「不可用」并说明原因** ——刻意做成这样，免得一个可选功能把整个安装搞失败、
```bash
pnpm rebuild:pty
```

Windows 上这个模块默认要求MSVC 装有 **「Spectre 缓解库。* 组件，否则报 `MSB8040`、该脚本提供了一条不依赖那个组件的退路（configure 后改写生成的 `.vcxproj`）。
> ⚠️ 关掉 Spectre 缓解**确实降低了这一处原生代码的加固强度**。环境允许的话*优先装组件*（>
> ```powershell
> vs_installer modify --add Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre
> pnpm rebuild:pty
> ```
>
> 脚本只是「没有管理员权限 / 不想装几不GB 组件」时的退路。>
> **换机器才需要重编；据Electron 版本不需要。* node-pty 用的是Node-API
> （node-addon-api），ABI 路Node/Electron 版本稳定 ——这一点是实测的：
> 同一个`pty.node` 在Node 24 不Electron 43（Node 22）下都能加载并spawn）> 二进制里有`napi_register_module_v1` 而没有`NODE_MODULE_VERSION`。> 所以这里需要重编的原因只有「本机没有编译产物」，不ABI 无关、
### 自测覆盖了什么
这些不是「跑个例子看看」，而是针对**已知会出错的地方**写的断言）
| 命令 | 覆盖 |
|---|---|
| `pnpm test` | 插件 manifest 校验 **56 例*；provider key 解析 **22 例*；窗口尺寸位置恢复规则 15 例；**diff 解析与左右配对27 例*（配对错位、删多增少、纯增纯删、跨块不混配、元信息行不参与）；审批差异预览 20 例；**工作区文件操作与越界防御 81 例*（含移动独有的四个坑：目标越界、移进自己子孙、覆盖、源目标相同）；技能文件39 例；**原生模块失败归因 21 例*（用真实错误串区分「绑定没编出来/ 整包不在 / 工具链失败」，保证提示指向正确的修复命令）：*关窗拦截规则 12 例*（含「兜底放行」与「干净状态永不被拦住」）：*会话按目录过滤15 例*：*最近目录的 id 复用与隐藏规则26 例* |
| `pnpm verify:plugins` | 插件运行时**16 条*：工具*真的在子进程里执行*、*环境变量确实被裁剪*（看不到宿主敏感变量作PATH 可用）、错误路径不抛异常、停用后无残留进程|
| `pnpm verify:history` | 历史恢复 **28 条*：模拟「销每runtime 再新建」 应用重启，断言**带历史时模型能看到之前的对话**、*不带历史时确实失忆*（对照组，防止断言恒真）、只重放文本、合并相邻同角色、丢掉悬挂提问、条数与字符双上限。*裁剪切断点落在assistant 上时不再件assistant 开失*（Anthropic 会400）|
| `pnpm verify:approval-timeout` | 审批超时 **16 条*：注入小值验机制（超时按 deny 生效、运行正常收尾、文件没被写），**外加对照组*（手动放行→文件真的写出来，证明这条路径本身是通的）。加 `-- --real` 会用真实默认值跑一次完整的 **5 分钟** |
| `pnpm verify:anthropic-history` | 拦*真实 Anthropic 请求构建**证伪「重放历史合法。*33 条*：拦不`fetch` 检查真正会发出去的报文 ——首条是`user`、角色严格交替、无空内容块；并断言「pi 不会替我们兜住」与「有预算确实会制造出病态序列」（防止断言空转：|
| `pnpm verify:api-matrix` | **四种可配线协议*各跑一遍真实请求构建**36 条*：构建不抛错、重放序列首条user 且交替、工具定义按各自原生格式（`function.parameters` / `parameters` / `input_schema` / `parametersJsonSchema`）发出且 schema 完整、请求打到各自正确路径|
| `pnpm verify:anthropic-tool-loop` | **Anthropic 报文里的工具往进20 条*：本地假装一个Anthropic 端点，抓下真实agent 循环产生的第二次请求 ——`tool_result` 紧跟 `tool_use`、id 配对、承载者是 user、流式参数拼成完整JSON、报文里不混 OpenAI 字段 |
| `pnpm verify:allow-always` | 「允许并记住」的白名单*生命周期 12 条*：同一个会话里参数完全相同的调用不再问（但工具仍然执行）。*不跨会话**、*不跨进程**（新 runtime = sidecar 重启后重新问），外加一条对照（各轮参数逐字相同）。用**参数恒定**的假模型跑，因为 E2E 的夹具每次写入都带递增序号、参数永远不含|
| `pnpm verify:deny-feedback` | **拒绝之后模型看到了什么18 条*：让假模型把工具结果**原样回显**，于是「模型看到了什么」可断言 ——拒绝时它收到的是一可*给模型看的行动建计*（不是只给用户看的「已拒绝」）；只读模式的边界是*工具清单本身**（write/bash 根本不在清单里），硬调则得到「没有这个工具」而非成功；外加放行对照|
| `pnpm verify:tools-download` | **rg / fd 的查找与失败路径 20 条*：查找顺序（本地 `<agentDir>/bin` →PATH）、`PI_OFFLINE` 跳过下载且不联网、下载失败*不留半截二进制*（半截比没有更糟：`existsSync` 会把它当成已安装）、PATH 命中时一次网络都不碰；以及*走真实工具调用*验「模型会收到点名 ripgrep 的工具结果、整轮正常收尾」。下载失败用**必抛的fetch 档*并断言桩确实被调用（否则分不清是我们造的失败还是网络本来就不通） |
| `pnpm verify:no-persistence` | **内核侧不落盘 13 条*（这条曾是「未验证」）：整棵内核数据目录里**搜不到对话里的暗可*（没有任何隐藏的第二份历史）、新 runtime 完全失忆（所以主进程回灌是唯一的记忆来源）、`disposeSession` 只作用于内存；对照是「假模型确实收到了那句暗号、|
| `pnpm verify:diff-preview` | **差异预览的内容17 条*（这条曾是「未验证」）：走真实「工具调用→审批」链路断言**显示的就是那几行** ——write 覆盖（删的旧行与加的新行都在）、write 新建：*没有**删除行）、edit（pi 的参数是 `{path, edits:[{oldText,newText}]}` 数组）；外加两个**必须退包*的分支：`oldText` 匹配不到时明说未匹配、出现多次时标注位置可能不同（给一个可能与实际不一致的漂亮 diff 比不给更糟） |
| `pnpm verify:project-trust` | **工作区`.pi/` 资源已被关掉 10 条*（修的是一个真漏洞）：`SettingsManager.projectTrusted` **默认 true**，于是陌生仓库能执行 `.pi/extensions/*.js`、把 `.pi/SYSTEM.md` 注入系统提示、加载它的技能——现在显式 `setProjectTrusted(false)`。三组断言：*夹具活态*（显式信任时真的会执行注入/加载）。*修复后一个都不生效*、*对照**（我们自己的全局技能照常加载）。修复前那三条是红的 |
| `pnpm verify:doc-claims` | **文档完整性守单52 条*：① 20 条「文档承诺过的修复必须还在代码里」（每条带失效后果与对应小节）② 3 条「旧写法不该再出现」③ 5 条对照②**4 条文档自染*（?1.1 第10 条、M3 行的过时说法假*行首锚点**）⑤ **3 条引用解析*：本地链接11 条、`§小节` 73 条、`pnpm` 脚本 63 条。正负两个方向都**先剥注释再匹配*（注释掉的修复不算修复）；⑥ **2 条体积快照*：文档里写的「主 chunk 当前 N KB / JS 总量当前 M KB」与实测产物比对 ②**3 条文档自活*：三处「多少个脚本、多少条断言」必须互相一致、且不`package.json` / README 表格的真实数量一致；②**3 条跨包防漏*：shared 手写的思考强度档位必须与内核 `ThinkingLevel` **逐字一致*（直接读内核 d.ts 比对（|
| `pnpm verify:danger-gate` | **`auto` 模式的边界26 条*（这条原来*一条断言都没有*）：12 个危险样本在 `auto` 下仍要问且带 danger 说明、 个普通命令对照不问、拒绝后文件**真的还在**、只读不问直接拦、`ask`/`auto` 的差别、以及「`auto` 真的在执行普通命令」的正对照。*修掉一个真活*：原正则要求递归标志在强制标志之前，于是 `rm -fr`/`rm -r -f` 在`auto` 下会被静默执行|
| `pnpm verify:approval-policy` | **审批闸门的策略表 53 条*：直接构造闸门逐条调用，穷举「三种模式× 各类工具」——只读模式**白名单之外一切都要拦**（含 `mcp__filesystem__write_file` 这类认不出来的名字）。*未知工具名按 `write` 处理**（fail-safe 方向）、以及此前*从无断言**的契约：**差异预览抛异常时审批照常进行**（降级为参数视图，且工具仍被放行，异常不变成拒绝（|
| `pnpm verify:plugin-failure` | **插件失败路径 26 条*（原来只测了「插件守规矩」那条线）：激活抛错/ 激活卡住（15s 有上限）/ 调用中通`process.exit`（转 `isError` 且不拖到超时） stdout 写非协议内容（丢弃不崩）/ 坏插件不污染宿主 / `activateAll` 一个坏的挡不住好的。*修掉一个真泄漏**：激活失败时子进程从未被杀 ——卡住的插件会永远活着、并占着插件目录让用户删不掉；`PluginRuntimeInfo` 因此新增 `running`/`pid`（`state` 是记录，`running` 是事实，两者可以不一致） |
| `pnpm verify:plugin-orphan` | **崩溃/强退之后不留孤儿进程 7 条*：起一个假父进程激活插件并报出插件 pid，然后①礼貌退出（SIGTERM →`deactivateAll`）②**强杀**父进程（SIGKILL，什么都来不及做）——两种情况下插件进程都必须消失；判据用 `process.kill(pid, 0)` 而不是状态字（父进程都死了就没人记得状态）。含一条对照证明判据本身有效。*诚实标注**：A/B 实验显示本环境的外部进程树清理也会收尾，所以这条断言保的是*性质**而非某个实现 |
| `pnpm verify:contract` | 控制面HTTP 契约 **21 条*、*Java 侧实现完后把 base URL 换掉即可当对接验收脚本* |
| `pnpm verify:kernel-deps` | **内核依赖与许可26 条*：三个内核包都被声明不*版本一致*（.1.0）。*没有踩裸包名占位第*（npm 上的 `pi-ai` 等是占位项目）、实际安装的包`license` 字段是MIT、`THIRD-PARTY.md` 含版权行不MIT 正文并点名三个包。*上游 LGPL 项目不是依赖也不含其源码**（锁文件无痕、仓库无 Rust、源码里提到它的地方只有注释）、声明进了`extraResources`、以及*三进程边界*（`apps/desktop` 不声明内核包、源码里导入内核的地方只在`packages/agent-host/` 下） |
| `pnpm verify:protocol` | sidecar 线协议**9 条*：*stdout 每行都是合法 JSON**、应等id 对应、未知方法返回错误帧而非崩溃、日志只赖stderr。加 `-- --bundle` 测打包产物|
| `pnpm verify:renderer` | 渲染层端到端 **405 条*（CDP 驱动真实窗口）：**会话按当前目录过滤、切目录后agent 真的在新目录里干活*、*打不开的目录会说明原因并可移除**、*等审批时切走再切回仍可批准*、*「允许并记住」的范围与行为一致*、*完整 agent 循环**、*中止（含卡在审批上时中止，限时20 秒内结束，且不被记成失败：*、*让假模型真的调用一次插件工具*（审批→参数进插件进程→结果回传模型 →回写落盘）。*重启应用后模型仍记得之前的对话+ 窗口尺寸被恢复*、*编辑器真实交互*（真按键 Ctrl+S →从测试进程读盘确认；**改名/移动后路径会跟着改写、仍能保存*：*未保存改动在六条路径上都不会被静默丢弃（含切工作区与关窗口）**，且**切换文件不会把上一个文件的内容写进新文件*）。*编辑器/ 终端 chunk 按需加载（CDP Network 域取证，并验证xterm 的CSS 也生效）**、*文件树操作*（新建重命名**移动到—*/删除，均从磁盘确认存亡；并断言**移动之后树没有变空*）。*会话重命名/ 搜索 / 删除（确认、取消、删当前会话：*、*差异视图**、*输入框历史（真实上下键）**、*终端界面路径（新建/ 关标签/ 收起面板，并数系统shell 进程：*、*一条消息只出现一次*、*发送失败时已输入内容被还回**、技能被内核加载并进入系统提示、无未捕获异常与 `console.error` |
| `pnpm verify:bundle` | 渲染层体积守单**8 条*：入口用相对路径（`file://` 下才能加载）。*不chunk ≀1350 KB**、*编辑器内核（`CodeEditor-*.js`）、终端（`TerminalPanel-*.js`）与快速启动面板（`CommandPalette-*.js`）确实被拆成独立的按需 chunk**、至少切出6 个独立chunk、JS 总量没有异常膨胀（防拆包复制依赖）。守的不是功能，而是**一个容易被无声回退的优化决定* |
| `pnpm verify:packaged` | 打包产物 **24 条*：sidecar 入口路径、插件运行器同目录。*node-pty 代asar.unpacked 加载**、生产档 CSP 下不白屏。*生产档CSP 下编辑器高亮仍生效（顺带证明按需 chunk 能从 `file://` 加载）*、打包后 PTY 仍能赖shell、打包后插件仍能被激活|
| `pnpm verify:packaging` | 打包配置与产物结果**15 条*：三平台目标声明、`nsis`/`portable` **产物名不撞车**、sidecar/插件运行器asar 布局，以及*包里原生模块的格式必须与目标平台一致*（PE/ELF/Mach-O）——在 Windows 上打 Linux 包会在这里红，因为那确实是个跑不了的包|
| **合计** | **1455 条断言**。数字是**数出来的**：逐个脚本跑一遍、统计输出里的`PASS` 行，并与一次完整`pnpm verify` 的日志行数对账（离线可复现；不含只有接真实厂商之后才能验的那几项，见 `docs/ARCHITECTURE.md` 末尾的未验证清单（|

### 不接真模型也能验完整 agent 循环

`verify:renderer` 里有一整段「对话→工具调用 →审批 →工具执行 →结果回传 →收尾」，
用的是mock 控制面*同时充当的脚本化假模型端点*（OpenAI 兼容流式 SSE）。它覆盖了流式正文、工具调用增量参数拼接、审批的**拒绝与放行两条路径*、工具真实执行（文件真的落盘，从测试进程直接读盘确认）、结果回传、第二轮收尾、以及 `run.completed` 的用量与 `tool.approved` / `tool.denied` 审计、
这条路径做过两件「让测试别骗自己」的事：假模型*只在工具确实出现在请求里时*才发起调用（否则「工具集没暴露」会被伪装成一个正常对话）；审批按 `runId` 精确匹配
（事件是累积的，用「数组里第一个审批」会捞到上一轮已经裁决过的那个）。
它当场抓出一个真实缺陷：**provider 报错（01 / 连接被拒）会被判成`end_turn` 并审计成
`run.completed`** ——用户配错 key 时成功率和用量统计全是假的。原因见
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) §15.1、
`pnpm verify` 一次跑完全部（typecheck + 上述限`verify:packaged` / `verify:packaging` 之外的所有——打包验证需要先出产物，单独跑）。
**每一步都自己把前提造出来*：`typecheck` 先构建workspace 包，各验证脚本先构建自己要用的产物，
`verify:renderer` / `dev` 先确保Electron 二进制就位、所以`pnpm install && pnpm verify` 在*只含源码的干净检出*里就能跑通——这一点是实测的，不是推断的（解[ARCHITECTURE.md](docs/ARCHITECTURE.md) §15.6）。
> `verify:renderer` 会*先构建再验*（`build:deps && build && node …`）。> 这条不是多余的：它曾经只跑E2E，于是「忘了构建」时会*静默地测上一次的产物** ——> 一套会对着旧代码变绿的测试比没有测试更危险。空目录下现在也能自举跑通。>
> 而`build:deps` 自己也曾长期空转：它写的是`pnpm --filter '@i-pi-desk/desktop^...' build`）> 单引号在 Windows 的cmd 里是**字面里*、`^` 又是 cmd 的转义符 ——> 结果一个包都没匹配到，`shared/dist` 只是靠手工构建才存在。> 现在改成显式列出那两个包（不含任何shell 特殊字符），删掉 dist 也能自动重建」
五条尤其值得每次改动后跑）
- `verify:protocol` ——**sidecar 的stdout 是协议流**，一行误入的 `console.log` 就会让主进程的解析器吃到垃圾帧。这类问题一旦发生极难定位、- `verify:renderer` ——`typecheck` 不`build` 只能证明代码编译得过，证明不了窗口里真的渲染出了东西。渲染层恰恰最容易「编译没问题、一跑就白屏」、- `verify:renderer` 里的**插件**断言 ——它抓出过一个几乎无法从现象反推的bug：pi 的`tools` 数组**同时是白名单**，不在其中的工具会被直接从定义表里过滤掉，于是「插件已激活、技能也进了系统提示，但工具对模型不可见」、- `verify:renderer` 里的**控制面*断言 ——它抓出过 `ProviderConfig.source` 被归一函数丢掉，导自*每次同步都堆积一份重失provider**、- `verify:renderer` 里的**技能*断言 ——「技能被加载」和「技能被加载并且进了系统提示」是两件事。只有后者才说明模型真的会看到你的规范、
---

## 目录结构

```
i-pi-desk/
├─ packages/
─ ├─ shared/          跨边界契约：IPC 通道、Result 信封、领域模型、线协议
─ ─                  铁律：不 import Electron、不 import Node fs、不 import pi-*
─ └─ agent-host/      agent 宿主：sidecar 入口 + pi 封装 + 工具 + 事件翻译 + 审批闸门
─    ├─ src/sidecar.ts    进程入口，读内stdio 协议常─    ├─ src/runtime.ts    会话注册表、run 生命周期、审批等径─    ├─ src/approval.ts   权限闸门（挂在pi 的tool_call 钩子上）
─    └─ src/translate.ts  pi 原生事件 →自有 AgentEvent（内核升级只改这里）
└─ apps/desktop/
   ├─ electron/main/   主进程：窗口、IPC、持久化、密钥、sidecar 监督
   ├─ electron/preload/ 唯一出口，白名单式暴露window.desk
   └─ src/             React 渲染层（features/* + stores/app-store.ts（```

---

## 三条不变式
改代码前请先内化，跨越任何一条后面都要还债：

1. **Renderer 不碰 fs** ——所有文件系统与密钥操作在主进程、2. **Main 不跑 agent** ——prompt 组装、工具执行都在sidecar，主进程只做编排、3. **Sidecar 不碰窗口** ——它只认stdio 上的线协议，不知遍Electron 的存在、
另外两条硬约束：

- **pi-\* 只允许出现在 `packages/agent-host` 内。* 主进程与渲染层一行都不许 import 它、  这是「内核可替换」的物理保证」- **sidecar 的stdout 是协议流。* 业务代码禁止 `console.log`，一律用 `protocol.ts` 的`log()`（写 stderr）。
---

## 数据落在哪
```
<userData>/
├─ settings.json      # 设置 + provider 列表（无明文密钥（├─ secrets.json       # 系统密钥环加密的 API Key / 控制面令牌├─ sessions/          # 一个会话一个JSON
├─ plugins/           # 插件：每个插件一个目录，含manifest.json 与入口文件├─ plugins.json       # 插件启停状态（不manifest 分开，我们不修改插件自己的文件）
├─ control-plane.json # 控制面用户信息与同步时间：*不含令牌**（├─ window-state.json  # 窗口尺寸与位置（拔掉显示器后不会把窗口开到屏幕外，├─ pi-agent/          # pi 内核状态（被强制关在这里，不污染~/.pi）─ └─ skills/         # 技能：每个技能一个目录，含SKILL.md
└─ logs/
```

`<userData>` 的实际路径在应用内「模型与设置」面板底部可以看到「（Windows 通常是`%APPDATA%\i-pi-desk`）