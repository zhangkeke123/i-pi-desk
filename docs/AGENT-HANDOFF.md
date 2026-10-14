# 交给下一个 Agent 的开发交接

> **这份是给 agent 看的操作说明**，不是给人看的产品介绍。
> 给人看的那份是 [`HANDOVER.md`](./HANDOVER.md)（交付状态、刻意不做的、只有人能做的事）。
> 读法：**§1–§3 十分钟读完再动手**；改之前看 §5 的现状地图；改完照 §7 的清单收尾。
>
> 本文里的命令、路径、条数**都是从当前仓库里数出来的**（数法见 §1.3）。如果你改动了，
> 请连带更新本文与 README —— 这个仓库有一条守卫专门盯「文档与代码不漂」（§1.3）。

---

## 0. 这是什么、现在什么状态

- **i-pi-desk**：本地优先的桌面 AI 编码客户端（Electron + React + TypeScript + Vite）。**没有 Java 部分** —— 后端内核直接用 MIT 的 `pi-ai` / `pi-agent-core`，跑在 Node sidecar 里。
- **三进程**：React 渲染层 → Electron 主进程（薄编排 + 唯一数据 owner）→ Node agent sidecar（内核 + 工具执行）。
- **上游参照**：[vastsa/PI-Desktop] 只作**架构与交互**参照；**零复制**（有守卫，见 §4）。
- **当前状态**：全链路断言需以 `pnpm verify` 实测为准（近期单测有增减）；Windows 安装包（NSIS，约 108 MB）能装能跑。
- **代码位置**：`D:\work\code\shudao\a3-lib\i-pi-desk`
  ⚠️ 它在一个多仓工作区里，**是未跟踪目录、从未提交**（`git status` 看不到它作为已提交内容）。
  工作区根有 `AGENTS.md` 规定「用户没说 commit/push 之前不要推远程」—— 沿用这条。

---

## 1. 五分钟跑起来

### 1.1 环境

| 须| 值|
|---|---|
| 平台 | Windows（本仓库的验证脚本大量用 PowerShell/Windows 路径；Linux/macOS 未验）|
| Node | ≀22.19（本机用的是 DSH 运行时里的Node）|
| pnpm | ≀10 |
| 不需要| Rust 工具链（这是与上游最大的工程差异（|
| 终端面板 | 需要`node-pty` 不Electron ABI 匹配：`pnpm rebuild:pty`；换机器或换 Electron 版本都要重编 |

Electron 二进制下载慢时，先设这两个镜像（本机一直这么用）：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
```

### 1.2 命令（根目录 `package.json` 里一全36 个脚本）

```bash
pnpm install
pnpm dev                 # 自带 ensure:electron + build:deps + build，然后起窗口
pnpm verify              # 全量验证链（一条26 段的链：typecheck + 单测 + 22 个跨包`verify:*` + 渲染层端到端 + 体积守卫；见 1.3）pnpm --filter @i-pi-desk/desktop run dist       # 打Windows 安装包（约60—0 秒）
pnpm --filter @i-pi-desk/desktop run verify:renderer   # 只跑渲染层端到端（约 4 分钟，pnpm typecheck && pnpm test                     # 类型 + 桌面单测（几十秒：```

**跑得必vs 跑得全*：改一行UI →全`typecheck`，再 `verify:renderer`；改内核/宿主 →跑对应的
`verify:xxx`（?.3 的表）；**提交前一定跑一次`pnpm verify` 全量**（约 15—5 分钟，含打包校验）。
### 1.3 三个「不是测试、但同样会拦你」的工具

| 工具 | 作用 | 什么时候跑 |
|---|---|---|
| `pnpm verify` 链| 一条26 段的链：typecheck + 单测 + 22 个跨包`verify:*` + 渲染层端到端 + 体积守卫，共 1455 条断言 | 每次收尾 |
| `node tools/reconcile-counts.mjs <日志>` | **对账**：把 README 里声明每个脚本的断言数与日志里真实的 PASS 行比对| 改了断言数之后（它会打印每一处不一致） |
| `packages/agent-host/scripts/verify-doc-claims.mjs` | **文档守卫**：2 条）：文档承诺过的修复必须还在代码里、旧写法不该再出现。*文档里提到的文件必须存在**、CSS 与主题注册表不许漂| 改文档主题之后 |
| `apps/desktop/scripts/verify-bundle.mjs` | **体积守卫**： 条）：入口用相对路径、主 chunk ≀1350 KB、JS 总量 ≀3020 KB、按需加载的chunk 不被静态引全| 动了依赖或拆包之后|

> ⚠️ 体积守卫里那个总量是*预算**，不是「当前测得多少」。要调整基线，请在注释里写清
> 「为什么」＋「核对过没有复制依赖」（§15.25 有一次这样的记录）。
---

## 2. 三条不可破坏的不变式（每条都有守卫在盯）

1. **渲染层永远不碰文件系绿*。所有IO 起preload 暴露的API →主进程」   想加文件操作，就在主进程动IPC，不要在渲染层引 `node:fs`、2. **主进程永远不跑agent**。内核只在sidecar 里；主进程是编排者与数据 owner「3. **`pi-*` 只能出现在`packages/agent-host` 里*。别的地方import 它会被   `pnpm verify:kernel-deps`（6 条，含许可与版本一致性）拦下「
---

## 3. 这个仓库的十条约定（不做的话，改动会被判为「不合格」）

1. **每个改动都要有断言**；能自动化的进`verify:renderer`，逻辑类的进桌面单测「   没有断言的改动，在这个仓库里等于没做完「2. **每个新守卫都要A/B**：故意把它弄坏一次，确认它*真的会红**。   ⚠️ 破坏方式必须**构建安全** ——我试过把 `onChange` 改成空函数，结果一个import 变成未使用「   构建失败，自测以 **0 PASS 0 FAIL** 结束：那不是「断言变红」，而是**什么都没验分*。3. **断言要防盲区**。两个真实例子：⑀「`headline !== null`」对 `undefined` 恒真 →改成检查类型；
   ⑀「点导航后`scrollTop` 变大」在窗口够高时恒假→改成「滚动发生了**截*锚点已在视野里」。   写断言时问自己：*什么情况下它会恒真/恒假：*
4. **计数是数出来的*：改了断言数，同步 `README.md` 不`ARCHITECTURE.md` §15.10）   再跑 `tools/reconcile-counts.mjs` 确认 ALL_PASS「5. **文档是被守卫的*：不要写不存在的文件路径（守卫会当真的去查）、不要把旧写法留在文档里、6. **视觉改动必须真的看一看*：跑完断言写*截图/看安装版**。断言证明「没坏」，看不出「丑」。7. **端到端的段落位置就是状态契红*：新段落要想清楚「我从谁手里接状态、我留给下一段什么状态」。   我因为没想这件事，让相邻段落红了 6 条，而现象指向「那段坏了」。8. **UI 里新增可点元素，要避开「扫所有button」的段落**。这份自测里有若干段落按文字扫全须button
   （文件树里点目录后文件名）。我加「项目」行时用 `<button>`（*25 条完全无关的断言**级联变红）   改用 `<div role="button">` 后归零——既保住可访问性，也不进入那些扫描范围「9. **注释写「为什么」，不写「是什么。*。这个仓库的注释密度是刻意的：它记录的是**判断与代价*。10. **改完界面要重建安装包并在安装版上验一次*（`dist` →静默安装 →启动 →截图/染DOM）。
---

## 4. 千万别踩的坑（按我实际付出的代价排序）
完整坑表在[`HANDOVER.md`](./HANDOVER.md) §7（几十条）。以下是最贵的十条）
1. **不要在PowerShell 里用内联 `node -e` 改文件* ——引号/反斜杠会先被 PowerShell 解析一遍：
   脚本要么语法错、要么改了别的东西。*一律写我`.mjs` 文件写`node 文件`**。   这个错我在一个会话里犯了三次，每次都重跑了一遍构建或自测「2. **补丁脚本：先读、再改；行号替换一律带断言**。我用「行号区问+ 写入前断言」避免过**好几次*
   把文件写坏（断言不过就中止，文件不动）。锚点式替换经常匹配不上，而失败信息只说「找不到」。3. **hook 不能加在提前 return 之后** ——侧栏的紧凑模式是提前 return，我在它之后加了 `useState`（   首次渲染没事，视口变宽时 hook 数量变多 →React 报错。*整个侧栏消失**（一次红 10 条）。4. **JSX 注释不能放在 `return (` 的根元素之前** ——那是两个兄弟节点，直接语法错误「5. **命令要失败即做*。typecheck 已经报错、命令却继续跑完了`dist` →**装上去的是旧区*：   现象像「改动没生效」。6. **整词替换会误伤别失*：给自测变量加前缀时改到了另一个段落的同名变量 →`ReferenceError`、   替换脚本现在必须打印「每个新名字声明了几次」，并只回退自己那一段之后的行「7. **应用重启之后要用新的 CDP 连接**。自测中段会重启应用；对已断开的连接`await` **永不返回**：   现象是自测停在某一节直到超时（两次运行停在**完全相同的日志行数*）。8. **上一次运行留下的假模型进程会占端口*，新起的 mock 绑定失败后*安静退出*：   于是整套自测在跟**旧进程*说话（现象是「新加的行为完全没生效」）。自测里已有端口守卫「9. **`Emulation.clearDeviceMetricsOverride` 不触口`resize`** ——视口不会还原）   界面停在旧状态，后面一大片断言跟着红」10. **端到端用 esbuild，不做类型检查*。所以类型错误能一路绿过端到端 ——    改完一定要单独跑`pnpm typecheck`（我有一次就是靠它才发现 `readonly` 与可变数组不兼容）。
---

## 5. 现状地图（改哪儿看哪儿）

| 你要改—| 代码在哪 | 断言在哪 | 文档在哪 |
|---|---|---|---|
| 配色 / 字体 / 圆角 / 阴影 | `apps/desktop/src/styles.css` 的令牌层 | 主题与终端配色测试+ `verify:renderer` 的主题段 | `docs/UI-DESIGN.md` **§12** |
| 界面结构 / 交互 | `apps/desktop/src/features/**`、`src/lib/**` | `apps/desktop/scripts/verify-ui-logic.ts`（单测）+ `verify-renderer.mjs`（端到端（| `docs/UI-DESIGN.md` §2–?（v1 结构） §12（v2 现状（|
| 主进程（IPC / 存储 / 窗口 / 终端（| `apps/desktop/electron/main/**` | `verify:renderer` 相关段+ 宿主侧脚本| `docs/ARCHITECTURE.md` |
| agent 宿主 / 内核接线 | `packages/agent-host/**`（*唯一**能import `pi-*` 的地方） | `verify:kernel-deps`、`verify:thinking-level`、`verify:max-steps`、`verify:history` 等| `docs/ARCHITECTURE.md` §15.x |
| 跨进程类型| `packages/shared/**`（改了要 `build:packages`（| `verify:doc-claims` 里的跨包一致性3 条| ——|
| 假模型/ 端到端夹全| `tools/mock-control-plane/**` | 它是被测对象的对手方，本身不测| `docs/ARCHITECTURE.md` §15.23 |
| 打包 | `apps/desktop/electron-builder.yml` 等| `verify:packaging`（5） `verify:packaged`（4）| `docs/ARCHITECTURE.md` |

**文档分工**（别写重复的第二份）：
- `docs/ARCHITECTURE.md`（*250 KB）05 节*）：架构与实现的**唯一权威**。`§15.x` 是最近的迭代记录）  每一节都写「做了什么/ 为什么这么做 / 踩了什么坑 / 覆盖到哪一层」。- `docs/HANDOVER.md`：给人看的交付说明+ **坑表（?：* + 「我改了 X 该跑哪个脚本」（§6.1）。- `docs/UI-DESIGN.md`：设计稿。?–?1 是结构，**§12 是现在实际长什么样 + 覆盖缺口**。- `docs/ui-mockup.html`：单文件原型（配色字体已与产品同步），用来判断手感「- `docs/PI-SDK-NOTES.md`（5 KB）：内核实测验尸报告，接内核前值得翻「
---

## 6. 平台与环境的坑（Windows 特有）
- **端口**：假模型控制面用 **8124**；调试端口一般用 **9365+**。跑自测前确认没有遗留进程占着
  （自测里有守卫会直接报错并告诉你查法）。- **安装位置**：`%LOCALAPPDATA%\Programs\i-pi-desk`；静默安装`setup.exe /S`、- **数据目录**：`%APPDATA%\i-pi-desk`（会话一文件一会话；`workspaces.json` 记目录列表）。  跑端到端时用的是**临时 userData**，不会碰你自己的数据「- **长驻进程**：用 `Start-Process` 起的后台进程会在工具调用结束时被连带杀接——要长期存活就用  `Invoke-CimMethod -ClassName Win32_Process -MethodName Create`（工作区 `AGENTS.md` 里有同样一条）。- **什DSH 的shell 里启动打包产物，要先删掉 `ELECTRON_RUN_AS_NODE`**。  这个 shell 里它被设成了 `1`（DSH 运行时留下的），而Electron 只看安*在不在* ——  在的话打包产物会什**Node 模式**运行，报 `bad option: --remote-debugging-port=…`（  看起来像「打包坏了」。注意：把它设成空字符串**没用**，必须`delete env.ELECTRON_RUN_AS_NODE`、  （自测脚本自己构通env，所以它不受影响；手工探针很容易栽在这里 ——我就栽了一次。）
- **调试端口**：Electron 的调试端点*没有实现 Browser 基*（改真实窗口尺寸走不通）：  验证视口相关的行为要用`Emulation.setDeviceMetricsOverride`，并**显式给`scale: 1`**
  （不给的话整页会被缩放，量出来的边框是0.666px 这种怪值）。
---

## 7. 一个改动做完，走完这张清单

- [ ] `pnpm typecheck` 通过（端到端**不做**类型检查，别只信它（- [ ] `pnpm test`（桌面单测）通过
- [ ] 相关 `pnpm verify:xxx` 通过
- [ ] **A/B**：把新守卫弄坏一次，确认它真的红（且破坏方式构建安全（- [ ] `pnpm verify` 全量通过
- [ ] `node tools/reconcile-counts.mjs <日志>` →ALL_PASS
- [ ] 计数同步（`README.md` + `ARCHITECTURE.md` §15.10（- [ ] 文档：`ARCHITECTURE.md` 加一节（做了什么为什么坑覆盖）；踩到新坑就进 `HANDOVER.md` §7
- [ ] 界面改动：`dist` →静默安装 →启动 →**看一看*（截图或染DOM）
---

## 8. 明确的边界（这些不是缺口，是决定）
- **上游只做参照，零复制**：`vastsa/PI-Desktop` 是LGPL，我们用它的**架构与交互判断*：  但一行源码都没搬（守卫：源码里提到上游只允许出现在文件头注释里）。- **不要 commit/push**：当前用户的约定是「没说就不要推远程」。仓库本身也是未跟踪状态、- **两处如实记录的覆盖缺口*（不是忘了，是选择，理由见 `UI-DESIGN.md` §12.7）：
  ⑀「项目」分绿*点击切目录*那条路径没有端到端覆盖（逻辑有8 条单测；手工验过，但手工不算覆盖）；
  ⑀上下文截断的说明仍未做「- **刻意不做**（别当成待办）：自由拖拽多面板、会话流入场动画、把终端纳入 agent 能力、用 emoji 当结构图标「  详见 `HANDOVER.md` §3「- **只有真实环境能验的*：真实厂商端点的报文差异、密钥环在不同机器上的行为、高 DPI 观感「  换机器后的`node-pty` 重编。`HANDOVER.md` §4 列全了」
---

## 9. 如果你要继续做，我建议的顺序

1. **把两处覆盖缺口补一*（? 的两条）——它们已经有明确的起点与理由「2. **上下文截断的说明**（限额那一族里唯一没做完的一条）。3. **检查器：token 用量与成本的会话汇态*（现在只在每条消息上）。4. **真·虚拟滚动*（现在是渲染窗口：默认最近40 条+ 展开；引虚拟滚动要先解决
   消息高度不可预测带来的滚动位置漂移）。
---

[vastsa/PI-Desktop]: https://github.com/vastsa/PI-Desktop
