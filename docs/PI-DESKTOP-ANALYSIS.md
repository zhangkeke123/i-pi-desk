# PI-Desktop 解剖报告

> 目的：在动手仿写前，把「上游到底是什么、值得抄什么、必须避开什么」钉死。
> 取证方式：**浅克隆真实源码**（HEAD `86fe811`，3244 个 tracked 文件）+ 解包本机安装版 `app.asar`（568 文件 / 86.41 MB）+ 对运行时与 Rust 宿主做字符串级分析。
> 三份完整报告（含逐条出处）留在 `D:\work\tmp\`：`pi-research\`（上游）、`pi-asar\`（打包产物）、`pi-runtime\`（运行时）。

---

## 1. 一句话定位

`Local-first AI coding agent desktop: Electron + Rust host core + pi Agent Harness + user-installable plugins`

它自我定位**不是 IDE 扩展、也不是终端代理，而是独立的 Agent 桌面平台**。
当前 `0.18.0-beta.4`（Early Preview），6,594 stars / 612 forks。

---

## 2. License：为什么不能 fork 当底座（最重要的一条）

**LGPL-3.0-or-later，三处一致，且没有任何 linking 例外条款。**

| 使用方式 | 义务 |
|---|---|
| 闭源自用（不分发） | 无义务 |
| 商用收费 | 允许 |
| **对外分发** | **实质要求整体开源** |

最后一条是关键：LGPL 的通常玩法是「动态链接一个可替换的库，库的开源义务不传染应用」。
但这里**「库」就是整个应用**，不存在可替换的库边界 —— 所以「动态链接豁免」在实践中不成立。

**结论**：要闭源商用 / 私有化交付，就不能拿它当底座。
→ 这就是 `i-pi-desk` 选择「架构参考 + 自研代码 + 只用 MIT 的 pi 内核」的原因。

---

## 3. 技术栈与规模

| 项 | 事实 |
|---|---|
| 包管理 | pnpm monorepo（`apps/*` + `packages/*` + `docs`），pnpm 12.8.1 |
| 前端 | Electron 43 + React 19.2.8 + Tailwind 4 + Zustand + electron-vite + electron-builder |
| 原生 | 单一 Rust crate `host-core` |
| 代码量 | TS/TSX ≈ **28.9 万行**；Rust ≈ **7.7 万行** |
| Agent 内核 | 上游 `@earendil-works/pi-*@1.1.0`（**3 个包被打了 patch 钉死**） |
| 环境 | Node ≥22.19 / pnpm ≥10 / stable Rust |

---

## 4. 架构：四进程 + 两种线协议

```
Renderer（311 个通道白名单，无 URL 路由）
   ⇅ contextBridge
Electron Main（23 个 registerXxxIpc 模块 + 通道级 backendRouter，薄编排）
   ⇄ stdio NDJSON JSON-RPC
Rust host-core（数据与执行的唯一权威）
Node pi agent sidecar（ELECTRON_RUN_AS_NODE=1，不额外分发 Node）
utilityProcess 插件宿主（25 命名空间 / 87 方法）
ws://…/v1/racp/ws（远端 pi-host）
```

### 最值得抄的一个决策：**信任边界画在 host-core，不画在 Node**

`session.*` / `projects.*` / `settings.*` / `secrets.*` / `tools.execute` **全在 Rust 侧**。
sidecar 的注释写得很直白：*"may request a path, but it never chooses the project root"* ——
它只能**申请**一个路径，永远不能自己决定项目根目录。而且它对宿主只有 23 项
`HOST_PROXY_ALLOWED` 白名单能力可借。

也就是说：**LLM 能碰到的一切都必须穿过一道不由它控制的边界**。
这是整个项目里最重的架构决策，也是仿写时最该保留的思想（哪怕我们第一版不用 Rust）。

### 另一条：同一套 IPC 契约同时覆盖本地与远端

`registrar.handle` 在调用本地 handler **之前**先过 `backendRouter.route(channel, args)`。
于是「把 agent 跑到另一台机器上」几乎不用改 renderer。
远端用 revision + epoch/sequence cursor + `resync.required` 保证断线可恢复，
事件区分 durable（带 sequence）与 ephemeral（可丢）。明文 `ws://` 仅允许 `127.0.0.1`。

---

## 5. Rust host-core 到底负责什么（反直觉的发现）

**它没有**：git、PTY、LSP、tree-sitter、tantivy —— 这些全部 0 命中，模块清单里也没有。

**它拥有**：

- SQLite（rusqlite + WAL + **FTS5 全文检索** `messages_fts` + 触发器）
- machine-key 加密的 secret 保险库（`secrets_meta` + aes/argon2/blake2）
- 文件读写与 **hashline 原子编辑**（自定义 `PUT N.=M:` / `CUT` / `REM` / `MV` + 4-hex tag 协议，
  明确禁用 `apply_patch`）
- ripgrep 家族搜索（ignore / globset / regex / aho-corasick / walkdir）
- **非交互** shell 执行（powershell / cmd / pwsh / posix，**不是 PTY**）
- 插件安装 / 校验 / 市场、plan 审批、定时任务、session/turn/queue、通知、MCP、config-sync

注意「非交互 shell」和「hashline 编辑」这两点 —— 它们解释了它为什么至今没有编辑器与终端。

---

## 6. 事件与工具协议（仿写要对齐的部分）

### 事件

sidecar 内部用 pi 的原生事件；**对外**归一化成自己的类型。pi 1.1.0 的原始事件是：

`agent_start` / `agent_end` / `turn_start` / `turn_end` / `message_start` / `message_update`
/ `message_end` / `tool_execution_start` / `tool_execution_update` / `tool_execution_end`

流式正文在 `message_update.assistantMessageEvent`，其变体为
`start` / `text_start|delta|end` / `thinking_start|delta|end` / `toolcall_start|delta|end` / `done`。

> ⚠️ 一个我们踩到并已修正的坑：**`agent_end` 之后还可能发生自动重试**，
> 判定「这一轮真的结束」要用 **`agent_settled`**。

### 工具集

上游 agent 模式常驻核心 8 个（Read / Glob / Grep / Write / Edit / Bash / asktool / Skill），
外加 9 个直声明、4 个定时任务、4 个 subagent、`new_context`、ToolSearch 延迟工具、`plugin_*`。

**执行体在 Rust**，统一走 `tools.execute` RPC，进度走 `tools.output`。

### Provider

适配器注册表按 apiStyle 分派，6 条明确的：

| apiStyle | 默认 baseUrl |
|---|---|
| `openai-completions` | `https://api.openai.com/v1` |
| `openai-responses` | 同上 |
| `anthropic-messages` | `https://api.anthropic.com` |
| `openai-codex-responses` | `https://chatgpt.com/backend-api` |
| `pi-messages` | `https://radius.pi.dev` |
| `google-generative-ai` | `https://generativelanguage.googleapis.com/v1beta` |

`models.dev` 快照：**226 provider / 8416 model**。

**密钥不在 Electron `safeStorage`**（那只用于远端 host 的 device token）——
而在 host-core 的加密保险库里，sidecar 通过 `provider.resolveAuth` **惰性**取，
且只允许取已绑定到该 session 的 provider（否则 `PROVIDER_NOT_BOUND`）。

---

## 7. 扩展机制

### Skills：渐进式披露

提示词里**只放** `skills` 段与 `skill:<id>` 一行目录（`- \`id\` — name: desc`），
**全文由 `Skill` 工具按 id 现读**。这样 20 个 skill 也只占几百 token。

- 文件形态：单个 `.md`，或「目录 + `SKILL.md`」
- frontmatter 是**自研扁平格式**，只有 `name` / `description`
- 单文件 ≤ 128 KiB
- 会自动扫描导入：`~/.claude/skills`、`<proj>/.claude/skills`、`~/.agents/skills`、`<proj>/.agents/skills`

### Plugins：声明式 manifest + 能力×范围双维度授权

必填 `schemaVersion` / `id` / `name` / `version` / `main`（本机装的两个插件实测如此）。
`contributes` 有 12 类：`commands` / `agentTools` / `skills` / `views` / `themes` / `mcpServers`
/ `services` / `bus` / `providers` / `settings` / `agentExtensions` / `globalShortcuts`。

**授权不是开关，而是「能力 × 范围」两维**：

- `permissions` 只管「能力名」（如 `ui.view` / `agent.tool.register` / `browser.cdp`）
- 真正的约束是 `manifest.fs.{read,write,delete}.scope` 与 `manifest.net.domains`
- 且有一批**不因 manifest 放宽**的硬性否定：凭据路径（`.env*` / `.ssh/*` / `*.pem` / `.git/`）、
  应用自身数据目录、先解符号链接、写删禁止整树、删除永不递归且进回收站并限速 50/min

配套：15s/5s/110s 分级超时、`load_error` 整体回滚、扩权必须显式重新确认（热重载绝不扩权）。
打包格式 `.piplug` = store-only zip，≤2000 文件 / 50 MB / 禁 symlink。

---

## 8. 作为仿写参考的价值评估

### ★★★★★ 值得抄（设计思想，不是代码）

1. **四进程分层 + 单一数据 owner + typed IPC + `Result<T>` 信封**
2. **信任边界放在「不由 LLM 控制的层」**（它选了 Rust；我们第一版用主进程 + 审批闸门）
3. **Plan/Goal 是同一个 agent 的契约状态，不是第二个 planner** ——
   审批走不可变 `.pi/plan/*.md` artifact（path/hash/size + 30 分钟绝对超时 + 原子 approve→Agent + 崩溃不重放）
4. **把「AI agent 怎么改这个仓库」写成带机械门禁的策略文件**（33KB AGENTS.md + 源码预算 / 样式 token / 策略同步 / 版本面检查）
5. **skills 渐进式披露** —— 这个便宜且效果显著，必须抄

### ✗ 明确不抄

- **规模**：349 个 ADR、15,840 行 E2E test plan、~180 个 agent-runtime 源文件、120 个 main 模块。
  仿写的价值在「小而易懂」，不在复刻体量。
- **Rust 宿主**：第一版不引。少一个工具链、少一处 ABI 坑。等真有性能瓶颈再把热路径下沉。
- **3 个 pi patch**：上游为了自己的需求 patch 了 `pi-ai` / `pi-agent-core` / `pi-coding-agent`，
  于是被钉死在 1.1.0。我们**不打 patch**，保持能跟随上游升级。

### 风险（决定「参考」而非「依赖」）

| 风险 | 事实 |
|---|---|
| 同步成本极高 | 峰值 **933 commits/周**，近 12 周 4,885 commits。只能做「冷冻基线」 |
| bus factor ≈1 | 第一贡献者 3,961 vs 第二名 104（**38:1**） |
| 外部贡献被限 | 自 2026-09-26 起外部 PR **仅收 `fix` / `perf`**，架构级贡献无法回流 |
| 版本钉死 | 硬依赖并 patch 上游 pi 1.1.0，升版须重做补丁 |
| 文档漂移 | docs 写 `0.14.x` / 「linter 未定」，实际 0.18 / 已用 Biome；AGENTS.md 指向不存在的 `electron/ipc/` |
| 功能缺口 | **无内置代码编辑器**（刻意不引 Monaco）、**无交互式终端**（无 node-pty，Bash 非交互）、插件无 OS 级沙箱、无签名信任模型 |

后一条正是 `i-pi-desk` 的差异化机会：**补上编辑器与真 PTY**，并把内网端点做成一等公民。

---

## 9. 竞品对照（2026-10-10 API 实测）

| 项目 | Stars | License | 形态 |
|---|---|---|---|
| OpenCode | 212,425 | MIT | CLI / TUI |
| Cline | 70,087 | Apache-2.0 | IDE 扩展 |
| Aider | 49,443 | Apache-2.0 | CLI（**已 5 个月无推送**，`pushed_at 2026-05-22`） |
| Continue | 36,162 | Apache-2.0 | IDE 扩展 |
| Cursor | — | 闭源 | 独立 IDE |
| **PI-Desktop** | 6,594 | **LGPL-3.0-or-later** | **独立桌面工作台** |

PI-Desktop 是这批里唯一「独立桌面工作台」形态、唯一有 Rust 特权宿主层、也是唯一 LGPL。

---

## 10. 这份报告把我们带到了什么结论

1. **不 fork，仿写** —— LGPL 的分发义务 + 933 commits/周的同步成本 + bus factor 1，三条叠加足以否定 fork 路线。
2. **复用 MIT 的 pi 内核** —— 这是上游自己选的底座，也是我们唯一该依赖的第三方。
3. **保留信任边界思想，但第一版不用 Rust** —— 用「主进程做唯一数据 owner + sidecar 内的审批闸门」实现同样的性质，成本低一个数量级。
4. **抄渐进式披露的 skills、typed IPC、Result 信封、单一 owner** —— 这几样便宜且长期受益。
5. **差异化押在**：内置编辑器（它能不做我们做）、真 PTY 终端、内网端点一等公民、可闭源分发。

具体落地见 [ARCHITECTURE.md](ARCHITECTURE.md)。
