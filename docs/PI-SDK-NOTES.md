# Pi Coding Agent SDK 集成配方手册

> 面向：为 Electron 桌面 AI 编程客户端编写 **agent sidecar**（Node 子进程 / 同进程 SDK）。
> 依据：`@earendil-works/pi-coding-agent@1.1.0`（MIT）本地安装包内的 `docs/`、`examples/`、`dist/**/*.d.ts`。
> **所有结论都标注了 文件:行号**。凡类型定义与文档冲突、或文档未明确的，都在文中显式标出。

## 路径缩写（全文使用）

| 缩写 | 绝对路径（相对 `D:\work\code\shudao\a3-lib`） |
|---|---|
| `P/` | `i-pi-desk/packages/agent-host/node_modules/@earendil-works/pi-coding-agent/` |
| `AI/` | `i-pi-desk/packages/agent-host/node_modules/@earendil-works/pi-ai/` |
| `AC/` | `i-pi-desk/packages/agent-host/node_modules/@earendil-works/pi-agent-core/` |

例：`P/dist/core/sdk.d.ts:116` = `.../pi-coding-agent/dist/core/sdk.d.ts` 第 116 行。

**本文档中「运行时已验证」的项目**：我用临时 `PI_CODING_AGENT_DIR` 起过真实的 `createAgentSession()` 探针（探针脚本已删除，未改动 `node_modules`），验证结果在 §9 标注。

---

## 1. 最小可跑示例

### 1.1 完整脚本（`sidecar-minimal.ts`）

来源：写法逐项对照 `P/dist/core/sdk.d.ts:10-116`、`P/dist/core/agent-session.d.ts:534`、`P/examples/sdk/01-minimal.ts`、`P/examples/sdk/12-full-control.ts`、`P/dist/core/model-runtime.d.ts:56,71,93,117`。

```ts
// sidecar-minimal.ts  — 目标：内网 OpenAI 兼容端点 + 只读工具 + 流式事件
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  getAgentDir,
  type AgentSessionEvent,          // P/dist/index.d.ts:3
} from "@earendil-works/pi-coding-agent";

const cwd = process.cwd();

// agentDir 决定 Pi 写哪儿（默认 ~/.pi/agent）。容器化部署时务必显式指定。
const agentDir = process.env.SIDECAR_DATA_DIR ?? getAgentDir();   // getAgentDir: P/dist/index.d.ts:2

// ── 1) 模型运行时（凭证 + 模型目录），来源 P/dist/core/model-runtime.d.ts:56
const modelRuntime = await ModelRuntime.create({
  authPath: `${agentDir}/auth.json`,     // CreateModelRuntimeOptions.authPath
  modelsPath: `${agentDir}/models.json`, // CreateModelRuntimeOptions.modelsPath
  allowModelNetwork: false,              // 默认 false，不联网刷新目录（:11-12）
});

// ── 2) 注册自建 / 内网 OpenAI 兼容端点
//    ModelRuntime.registerProvider(providerId, config: ProviderConfigInput)
//    P/dist/core/model-runtime.d.ts:117 ; ProviderConfigInput: P/dist/core/provider-composer.d.ts:49-62
modelRuntime.registerProvider("intranet", {
  name: "Intranet Gateway",
  baseUrl: process.env.INTRANET_BASE_URL ?? "http://10.0.0.10:8000/v1",
  api: "openai-completions",                     // KnownApi: AI/dist/types.d.ts（"openai-completions"）
  apiKey: process.env.INTRANET_API_KEY ?? "sk-noauth",
  models: [
    {
      type: "chat",                              // ProviderChatModelConfig，omitted type 也归一为 chat
      id: "qwen2.5-coder-32b",
      name: "Qwen2.5 Coder 32B (intranet)",
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      reasoning: false,
      contextWindow: 131072,
      maxTokens: 8192,
    },
  ],
});

// ── 3) 取模型。必须用 modelRuntime.getModel()：见 §9「getModel 陷阱」
const model = modelRuntime.getModel("intranet", "qwen2.5-coder-32b"); // :71
if (!model) throw new Error("model intranet/qwen2.5-coder-32b not registered");

// ── 4) 建会话
const { session } = await createAgentSession({
  cwd,
  agentDir,
  modelRuntime,
  model,
  thinkingLevel: "off",                 // ThinkingLevel: off|minimal|low|medium|high|xhigh|max
  tools: ["read", "grep", "find", "ls"],// 名称 allowlist；默认是 read,bash,edit,write
  sessionManager: SessionManager.inMemory(cwd),   // 若用默认 SessionManager.create() 会写 ~/.pi/agent/sessions
  settingsManager: SettingsManager.inMemory({     // :213 inMemory(settings?, options?)
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 2 },
    enableInstallTelemetry: false,
  }),
});

// ── 5) 订阅流式事件（必须在 prompt 之前订阅）
//    AgentSession.subscribe(listener) => unsubscribe  P/dist/core/agent-session.d.ts:379
const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
  switch (event.type) {
    case "message_update":                       // 文本 / 思维链 / 工具参数增量都从这里出
      if (event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);        // AI/dist/types.d.ts:589-592
      } else if (event.assistantMessageEvent.type === "thinking_delta") {
        process.stderr.write(`[thinking] ${event.assistantMessageEvent.delta}`);
      }
      break;

    case "tool_execution_start":                  // AC/dist/types.d.ts:474-477
      console.log(`\n▶ tool ${event.toolName} args=${JSON.stringify(event.args)}`);
      break;

    case "tool_execution_end":                    // AC/dist/types.d.ts:485-492
      console.log(`◀ tool ${event.toolName} isError=${event.isError} durationMs=${event.durationMs}`);
      break;

    case "message_end":                           // 权威完成消息；用量在这里
      if (event.message.role === "assistant") {
        console.log("\n[usage]", event.message.usage);   // P/docs/message-types.md:72-88
      }
      break;

    case "agent_settled":                         // 真正的「结束」：Pi 不会再自动继续
      console.log(`[settled] aborted=${event.aborted}`);
      break;

    default:
      break;
  }
});

// ── 6) 发送 prompt。prompt() 在整轮结束时 resolve（含自动重试）
try {
  await session.prompt("列出当前目录的文件，并说明这个项目是做什么的。");  // :534
  console.log("\nlast assistant text:", session.getLastAssistantText());   // :904
} finally {
  unsubscribe();        // 先解订阅
  session.dispose();    // :386 abort 活动工作、失效扩展上下文、断开事件
}
```

**运行方式**：`P/docs/sdk.md:20` 明确 `prompt()` 在 run 结束时 resolve；`P/examples/sdk/README.md:28-31` 用 `node examples/sdk/01-minimal.ts`（Node ≥22 的类型剥离）。若不用类型剥离，先 `tsc`。
`P/package.json:105-107` 声明 `"engines": { "node": ">=22.19.0" }`。

### 1.2 「同进程」还是「子进程」

- 同进程 SDK：本文档全部内容。
- 隔离子进程：`P/docs/cli-integration.md`（print / JSON / RPC 模式）。RPC 模式额外白送一套**审批对话框协议**，见 §6.4。

---

## 2. AgentSession 全貌

### 2.1 工厂函数（唯一入口）

```ts
// P/dist/core/sdk.d.ts:116
export declare function createAgentSession(
  options?: CreateAgentSessionOptions
): Promise<CreateAgentSessionResult>;

// P/dist/core/sdk.d.ts:67-74
interface CreateAgentSessionResult {
  session: AgentSession;
  extensionsResult: LoadExtensionsResult;
  modelFallbackMessage?: string;   // 恢复会话时模型不可用会给出提示
}
```

> ⚠️ **`createAgentSession` 不会自动调用 `bindExtensions()`**（`P/dist/core/sdk.js:303-327` 的返回路径里没有）。扩展工厂会在 `resourceLoader.reload()` 时加载，但 UI 上下文只有 `bindExtensions` 才装上。见 §6.2 与 §9。

### 2.2 `CreateAgentSessionOptions` 全字段

来源：`P/dist/core/sdk.d.ts:10-65`。

| 字段 | 类型 | 默认 | 说明（行号） |
|---|---|---|---|
| `cwd` | `string` | `process.cwd()` | 项目本地发现、context 文件、会话分组、内置工具路径 (11-12) |
| `agentDir` | `string` | `~/.pi/agent` | **全局配置目录**，决定 Pi 往哪写 (13-14) |
| `modelRuntime` | `ModelRuntime` | 基于 `agentDir/auth.json` + `models.json` 新建 | (15-16) |
| `model` | `Model<any>` | 设置里的默认，否则第一个可用 | (17-18) |
| `thinkingLevel` | `ThinkingLevel` | 设置，否则 `medium`（按模型能力 clamp） | (19-20) |
| `scopedModels` | `Array<{model, thinkingLevel?}>` | — | Ctrl+P 循环用 (21-25) |
| `noTools` | `"all" \| "builtin"` | — | 无显式 allowlist 时的默认抑制模式 (26-33) |
| `tools` | `string[]` | 见下方说明 | 名称/通配 allowlist (34-49) |
| `excludeTools` | `string[]` | — | 在 `tools` 之后生效的 denylist (50-54) |
| `customTools` | `ToolDefinition[]` | — | **SDK 注册的自定义工具**（不经过扩展）(55-56) |
| `resourceLoader` | `ResourceLoader` | `DefaultResourceLoader` | 扩展/skills/prompts/themes/context 文件 (57-58) |
| `sessionManager` | `SessionManager` | `SessionManager.create(cwd)` | 持久化 (59-60) |
| `settingsManager` | `SettingsManager` | `SettingsManager.create(cwd, agentDir)` | 设置 (61-62) |
| `sessionStartEvent` | `SessionStartEvent` | — | 扩展运行时启动元数据 (63-64) |

**`tools` 的语义（`P/dist/core/sdk.d.ts:34-49`）——容易踩错**：

- 省略 → 用设置里的 `defaultTools`；未配置时启用内置默认（`read, bash, edit, write`）。
- 纯普通名字（可含 `*`）→ **allowlist**，只有匹配的工具被启用。**非空且不含 `mcp__` 时，MCP 工具仍为 codemode / tool_search 保留注册**。
- **只有 `+name` / `-name` 的列表不是 allowlist**，而是在默认选择上增删；与普通名字混用会 **throw**。
- 空数组 ≈ `noTools: "all"`。

### 2.3 `AgentSessionConfig`（直接 `new AgentSession(...)` 时才用到）

`P/dist/core/agent-session.d.ts:112-164`。相比工厂选项，多出这些**工厂不暴露**的字段：

- `agent: Agent`（必需，工厂内部构造）
- `cwd`、`resourceLoader`、`modelRuntime`、`settingsManager`、`sessionManager`（必需）
- `initialActiveToolNames?: string[]` — 初始激活内置工具名，默认 `[read, bash, edit, write]` (130-131)
- `allowedToolNames?` / `excludedToolNames?` (148, 150)
- `baseToolsOverride?: Record<string, AgentTool>` — **替换内置工具实现**（自定义 runtime 用）(151-157)
- `cacheWarmer?` (129)、`usesDefaultTools?` (136)、`defaultToolModifiers?` (141)、`extensionRunnerRef?` (159-161)

> **`baseToolsOverride` 只在 `AgentSessionConfig` 里，`CreateAgentSessionOptions` 没有。** 这是 §4 里 `createCodingTools()` 无法直接喂给 `createAgentSession` 的根因。

### 2.4 生命周期与状态方法（全部来自 `P/dist/core/agent-session.d.ts`）

**运行 / 生命周期**

| 成员 | 签名 | 行 |
|---|---|---|
| `prompt` | `(text: string, options?: PromptOptions) => Promise<void>` | 534 |
| `steer` | `(text, images?, options?) => Promise<QueuedInputDisposition>` | 555-557 |
| `followUp` | `(text, images?, options?) => Promise<QueuedInputDisposition>` | 566-568 |
| `abort` | `() => Promise<void>` | 635 |
| `waitForIdle` | `() => Promise<void>` | 636 |
| `dispose` | `() => void` | 386 |
| `bindExtensions` | `(bindings: ExtensionBindings) => Promise<void>` | 755 |
| `reload` | `(options?) => Promise<void>` | 768-770 |
| `subscribe` | `(listener: AgentSessionEventListener) => () => void` | 379 |

`PromptOptions`（:176-187）：`expandPromptTemplates?`（默认 true）、`images?: ImageContent[]`、`streamingBehavior?: "steer" | "followUp"`（**流式中必须给，否则 reject**，见 `P/docs/sdk.md:66`）、`source?: InputSource`、`preflightResult?`。

**状态 getter**

| 成员 | 返回 | 行 |
|---|---|---|
| `state` | `AgentState` | 390 |
| `messages` | `AgentMessage[]`（含自定义类型） | 460 |
| `model` | `Model<any> \| undefined` | 396 |
| `thinkingLevel` | `ThinkingLevel` | 398 |
| `systemPrompt` | `string`（只读，含未发送的改动） | 409 |
| `isStreaming` / `isIdle` / `isCompacting` | `boolean` | 405 / 407 / 458 |
| `sessionFile` | `string \| undefined` | 466 |
| `sessionId` / `sessionName` | `string` / `string \| undefined` | 468 / 470 |
| `scopedModels` | `ReadonlyArray<{model, thinkingLevel?}>` | 472-475 |
| `promptTemplates` | `ReadonlyArray<PromptTemplate>` | 482 |

**工具控制**

| 成员 | 签名 | 行 |
|---|---|---|
| `getActiveToolNames` | `() => string[]` | 416 |
| `getCallableToolNames` | `() => string[]` | 418 |
| `getAllTools` | `() => ToolInfo[]`（含 name/description/schema/guidelines/source） | 422 |
| `getToolDefinition` | `(name: string) => ToolDefinition \| undefined` | 423 |
| `setActiveToolsByName` | `(toolNames: string[]) => void`（下一次 turn 生效） | 430 |

**模型 / 思考级别**

`setModel(model, options?)` :644 · `cycleModel(direction?, options?)` :652 · `setThinkingLevel(level, options?)` :661 · `cycleThinkingLevel(options?)` :666 · `getAvailableThinkingLevels()` :671 · `supportsThinking()` :675。`ModelMutationOptions.persist` 默认 session-only（:189-192）。

**用量 / 统计**

`getSessionStats(): SessionStats` :873（聚合**全部**条目含被压缩掉的历史；`SessionStats` 定义 :201-218）· `getContextUsage(): ContextUsage | undefined` :874 · `getLastAssistantText()` :904。

**压缩 / 重试**

`compact(customInstructions?)` :707 · `abortCompaction()` :711 · `setAutoCompactionEnabled` :752 · `abortRetry()` :792 · `isRetrying` :794 · `setAutoRetryEnabled` :800。

**对话式追加**

`sendCustomMessage` :594 · `sendUserMessage` :612 · `clearQueue` :621 · `pendingMessageCount` :626 · `getSteeringMessages` :628 · `getFollowUpMessages` :630 · `setSteeringMode` :683 · `setFollowUpMode` :688。

**bash / 会话树 / 导出**

`executeBash(command, onChunk?, options?)` :810 · `abortBash` :825 · `setSessionName` :838 · `navigateTree(targetId, options?)` :850 · `getUserMessagesForForking()` :864 · `exportToHtml` :881 · `exportToJsonl` :890 · `hasExtensionHandlers(eventType)` :909 · `extensionRunner` :913。

### 2.5 多会话替换：`AgentSessionRuntime`

当客户端要支持「新建 / 恢复 / fork / 导入」并切换工作目录时用。`P/dist/core/agent-session-runtime.d.ts:44-105`：

```ts
// P/examples/sdk/13-session-runtime.ts 的骨架
import {
  createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
  getAgentDir, SessionManager, type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};

const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(), agentDir: getAgentDir(), sessionManager: SessionManager.create(process.cwd()),
});

// 关键：替换会话后，旧订阅失效，必须重新绑定
await runtime.newSession();              // :80
await runtime.switchSession(path);       // :73
await runtime.fork(entryId);             // :87
await runtime.importFromJsonl(path);     // :101
await session.bindExtensions({ uiContext, mode: "rpc" });
const unsub = runtime.session.subscribe(handler);
await runtime.dispose();                 // :104
```

> `P/docs/sdk.md:60`：**runtime 替换后，订阅属于旧的 `AgentSession`，必须重绑。** `13-session-runtime.ts:7-9` 用注释强调同一件事。

---

## 3. 事件模型

### 3.1 `AgentSessionEvent` 完整变体

定义：`P/dist/core/agent-session.d.ts:47-109`。它是 `AgentEvent`（`AC/dist/types.d.ts:452-492`）去掉 `agent_end` 后的联合，**再并上** Pi 自己的一组事件。

`WithParentToolCallId<E>`（:41-45）：所有 `tool_execution_start|update|end` 事件都会额外带一个可选 `parentToolCallId?: string`（嵌套工具调用时出现）。

| `event.type` | 载荷字段 | 来源 |
|---|---|---|
| `agent_start` | — | AC:453 |
| `turn_start` | — | AC:458 |
| `turn_end` | `message: AgentMessage`; `toolResults: ToolResultMessage[]` | AC:460-462 |
| `message_start` | `message: AgentMessage` | AC:464-465 |
| `message_update` | `message: AgentMessage`; `assistantMessageEvent: AssistantMessageEvent` | AC:466-469 |
| `message_end` | `message: AgentMessage`（**权威完成消息**） | AC:470-472 |
| `tool_execution_start` | `toolCallId: string`; `toolName: string`; `args: any`; `parentToolCallId?` | AC:473-477 |
| `tool_execution_update` | 上者 + `partialResult: any` | AC:478-483 |
| `tool_execution_end` | `toolCallId`; `toolName`; `result: any`; `isError: boolean`; `durationMs?: number`; `parentToolCallId?` | AC:484-492 |
| `agent_end` | `messages: AgentMessage[]`; `willRetry: boolean` | AS:49-52 |
| `agent_settled` | `aborted: boolean` | AS:53-55 |
| `queue_update` | `steering: readonly string[]`; `followUp: readonly string[]` | AS:56-59 |
| `compaction_start` | `reason: "manual" \| "threshold" \| "overflow"` | AS:60-62 |
| `compaction_end` | `reason`; `result: CompactionResult \| undefined`; `aborted: boolean`; `willRetry: boolean`; `errorMessage?: string` | AS:72-78 |
| `entry_appended` | `entry: SessionEntry` | AS:63-65 |
| `session_info_changed` | `name: string \| undefined` | AS:66-68 |
| `thinking_level_changed` | `level: ThinkingLevel` | AS:69-71 |
| `auto_retry_start` | `attempt`; `maxAttempts`; `delayMs`; `errorMessage` | AS:79-84 |
| `auto_retry_end` | `success: boolean`; `attempt: number`; `finalError?: string` | AS:85-89 |
| `summarization_retry_scheduled` | `attempt`; `maxAttempts`; `delayMs`; `errorMessage` | AS:90-95 |
| `summarization_retry_attempt_start` | 两分支：`{source:"branchSummary"}` 或 `{source:"compaction"; reason}` | AS:96-103 |
| `summarization_retry_finished` | — | AS:104-105 |
| `bash_execution_update` | `id?: string`; `delta: string` | AS:106-108 |

（`AS` = `P/dist/core/agent-session.d.ts`，`AC` = `AC/dist/types.d.ts`）

### 3.2 `assistantMessageEvent` 的全部变体

`AI/dist/types.d.ts:581-634`：

| `type` | 字段 |
|---|---|
| `start` | `partial` |
| `text_start` / `text_delta` / `text_end` | `contentIndex`, `partial` (+ `delta: string` / `content: string`) |
| `thinking_start` / `thinking_delta` / `thinking_end` | `contentIndex`, `partial` (+ `delta` / `content`) |
| `toolcall_start` / `toolcall_delta` / `toolcall_end` | `contentIndex`, `partial` (+ `delta` / `toolCall: ToolCall`) |
| `done` | `reason: "stop"\|"length"\|"toolUse"\|"deferred"`; `message: AssistantMessage` |
| `error` | `reason: "aborted"\|"error"`; `error: AssistantMessage` |

> `contentIndex` 指向 assistant message 里的块下标；`partial` 是**该事件之后**的快照（`AI/dist/types.d.ts:571-580`）。

### 3.3 → UI 语义的映射建议

| UI 需求 | 用哪个事件 | 说明 |
|---|---|---|
| **文本增量** | `message_update` + `assistantMessageEvent.type === "text_delta"` → `.delta` | 与所有 SDK 示例一致（`P/examples/sdk/README.md:125-128`） |
| **思维链增量** | `message_update` + `"thinking_delta"` → `.delta` | 同上；`"thinking_end"` 给完整 `.content` |
| **工具参数流** | `message_update` + `"toolcall_delta"` | 提前渲染「正在生成参数」 |
| **工具即将调用（参数已完整）** | `message_update` + `"toolcall_end"` → `.toolCall` | 此时 `arguments` 已解析完整（`AI/dist/types.d.ts:137`） |
| **工具开始** | `tool_execution_start` → `toolName` / `args` / `toolCallId` | 是**执行**开始，不是 LLM 说完 |
| **工具中间输出** | `tool_execution_update` → `partialResult` | 长任务流式回显 |
| **工具结束** | `tool_execution_end` → `result` / `isError` / `durationMs` | |
| **用量（token / cost）** | `message_end` 且 `message.role === "assistant"` → `message.usage` | `Usage` 结构：`P/docs/message-types.md:71-88`。**没有独立的 usage 事件** |
| **会话级累计用量** | `session.getSessionStats()` | 包含被压缩掉的历史（`AS:868-873`） |
| **上下文水位** | `session.getContextUsage()` | `ContextUsage{tokens, contextWindow, percent}`（`AS:197-203`） |
| **本轮结束** | `agent_settled` | `P/docs/sdk.md:94`：**要判断「Pi 不会自动继续」必须用 `agent_settled`** |
| **单次底层 run 结束** | `agent_end`（注意 `willRetry`） | `P/docs/sdk.md:92`：之后仍可能有自动恢复 / 排队工作 |
| **排队状态** | `queue_update` → `steering` / `followUp` | 长度即待处理条数 |
| **压缩提示** | `compaction_start` / `compaction_end` | |
| **自动重试提示** | `auto_retry_start` / `auto_retry_end` | |
| **用户 `!` 命令输出** | `bash_execution_update` → `delta` | 对应 `agent.executeBash` |

**建议的 UI 状态机**：`agent_start` → 进入 streaming；`text_delta`/`thinking_delta` 累积气泡文本；`tool_execution_start/end` 驱动工具卡片；`message_end` 收用量；`agent_settled` 才把 UI 置回 idle。

---

## 4. 工具集

### 4.1 工具清单与构造函数

`P/dist/core/tools/index.d.ts:23-43`：

```ts
export type ToolName = "read" | "bash" | "powershell" | "edit" | "write" | "grep" | "find" | "ls";
export declare function createCodingTools(cwd: string, options?: ToolsOptions): Tool[];
export declare function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[];
export declare function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool>;
export declare function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef;
export declare function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef>;
```

`Tool = AgentTool<any>`（`index.d.ts:21`），**不是** `ToolDefinition`（`index.d.ts:22`）。

实际组成（`P/dist/core/tools/index.js`，`createCodingTools` / `createReadOnlyTools` 实现体）：

| 集合 | 包含 |
|---|---|
| `createCodingTools(cwd)` | `read`, `bash`, `edit`, `write` |
| `createReadOnlyTools(cwd)` | `read`, `grep`, `find`, `ls` |
| `createCodingToolDefinitions` | 同上 4 个，但是 `ToolDefinition[]` |
| `createReadOnlyToolDefinitions` | 同上 4 个，但是 `ToolDefinition[]` |
| `createAllTools` / `createAllToolDefinitions` | 全部 8 个（含 `powershell`） |

> ⚠️ **`powershell` 不在 coding / readOnly 集合里**，只有 `createAllTools` 和 `createPowerShellTool` 能拿到。SDK 里启用它走 `tools: ["powershell"]`。

### 4.2 每个工具的入参 schema

全部来自 `P/dist/core/tools/*.d.ts` 的 `Type.TObject` 定义。

| 工具 | 入参 schema | 出处 | 返回 details |
|---|---|---|---|
| `read` | `{ path: string; offset?: number; limit?: number }` | `read.d.ts:6-10` | `ReadToolDetails{ truncation? }` (:29-31) |
| `bash` | `{ command: string; timeout?: number }` | `bash.d.ts:6-9` | `BashToolDetails{ truncation?, fullOutputPath? }` (:27-30) |
| `powershell` | 同 `bash`（`PowerShellToolInput = BashToolInput`） | `powershell.d.ts:10` | 同 `BashToolDetails` (:9) |
| `edit` | `{ path: string; edits: Array<{ oldText: string; newText: string }> }` | `edit.d.ts:5-11` | `EditToolDetails{ diff, patch, firstChangedLine? }` (:17-24) |
| `write` | `{ path: string; content: string }` | `write.d.ts:4-7` | `undefined` (:27) |
| `grep` | `{ pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number }` | `grep.d.ts:5-13` | `GrepToolDetails{ truncation?, matchLimitReached?, linesTruncated? }` |
| `find` | `{ pattern: string; path?: string; limit?: number }` | `find.d.ts:8-12` | `FindToolDetails{ truncation?, resultLimitReached? }` |
| `ls` | `{ path?: string; limit?: number }` | `ls.d.ts:5-8` | `LsToolDetails{ truncation?, entryLimitReached? }` |

**各工具的可注入点 `ToolsOptions`**（`index.d.ts:25-34`）——做远程执行 / 沙箱时用得上：

```ts
interface ToolsOptions {
  read?: ReadToolOptions;        // { autoResizeImages?, resizeOptions?, operations?: ReadOperations }
  bash?: BashToolOptions;        // { operations?, commandPrefix?, shellPath?, exposeSessionEnvironment?, spawnHook? }
  powershell?: PowerShellToolOptions; // Pick<BashToolOptions,"operations"|"exposeSessionEnvironment"|"spawnHook">
  write?: WriteToolOptions;      // { operations?: WriteOperations }
  edit?: EditToolOptions;        // { operations?: EditOperations }
  grep?: GrepToolOptions;        // { operations?: GrepOperations }
  find?: FindToolOptions;        // { operations?: FindOperations }
  ls?: LsToolOptions;            // { operations?: LsOperations }
}
```

Operations 接口：`ReadOperations`（`read.d.ts:36-43`）、`BashOperations`（`bash.d.ts:35-52`）、`WriteOperations`（`write.d.ts:17-22`）、`EditOperations`（`edit.d.ts:29-36`）、`GrepOperations`（`grep.d.ts:28-33`）、`FindOperations`（`find.d.ts:26-34`）、`LsOperations`（`ls.d.ts:22-33`）。

> ⚠️ **坑**：`createCodingTools()` / `createReadOnlyTools()` 返回 `AgentTool[]`，而 `createAgentSession` **没有**接收 `AgentTool[]` 的选项（只能 `tools: string[]`）。它们实际服务于 `AgentSessionConfig.baseToolsOverride`（`AS:151-157`，需直接 `new AgentSession`）或自定义 runtime。**常规集成请用 `tools: string[]` 而非这两个函数。**
> **但你可以用同名注册「覆盖」内置工具**（已核对代码）。`AgentSession._refreshToolRegistry()`（`P/dist/core/agent-session.js:2808-2891`）先放内置，再让扩展/SDK 工具**覆盖**：
> - `definitionRegistry`：内置定义先入表（:2822-2830），然后 `for (const tool of allCustomTools) definitionRegistry.set(tool.definition.name, ...)` **直接覆盖**（:2831-2836）。
> - `toolRegistry`（可执行实例）：`new Map(wrappedBuiltInTools...)`（:2860），随后 `toolRegistry.set(tool.name, tool)` 再覆盖（:2861-2863）。
> - `allCustomTools = [...registeredTools, ...this._customTools...]`（:2815-2820）——**扩展注册的工具排在 `customTools` 之前**。
> - 同名时的去重只在**扩展之间**发生：`getAllRegisteredTools()` 是 "first registration per name wins"（`P/dist/core/extensions/runner.js:410-420`）。
>
> 所以：`customTools: [myBashWrapper]` 或 `pi.registerTool({ name: "bash", ... })` 都能替换内置 `bash`。**绕过 `ToolsOptions.operations` 限制的现实路径**。不过做「审批」时仍推荐 §6 的 `tool_call` 钩子——不改工具实现，风险更低。

### 4.3 `defineTool()` 定义自定义工具

`defineTool` 从包根导出（`P/dist/index.d.ts:9`），定义在 `P/dist/core/extensions/types.d.ts:521`：

```ts
export declare function defineTool<TParams extends TSchema, TDetails = unknown, TState = any>(
  tool: ToolDefinition<TParams, TDetails, TState>
): ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition;
```

`ToolDefinition` 字段（`types.d.ts:448-506`）：`name`(450)、`label`(452)、`description`(454)、`promptSnippet?`(456)、`promptGuidelines?`(458)、`parameters`(460, TypeBox)、`constrainedSampling?`(462)、`renderShell?`(464)、`prepareArguments?`(466)、`outputSchema?`(471)、`exposure?`(475)、`namespace?`(477)、`annotations?`(479)、`defaultActive?`(485)、`prepareLoadout?`(491)、`executionMode?`(499)、`execute(...)`(501)、`renderCall?`(503)、`renderResult?`(505)。

`execute` 签名（`types.d.ts:501`）：

```ts
execute(
  toolCallId: string,
  params: Static<TParams>,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
  ctx: ExtensionToolContext
): Promise<AgentToolResult<TDetails>>
```

`AgentToolResult`（`AC/dist/types.d.ts:370-392`）：`content: (TextContent|ImageContent)[]`（必需）、`details: T`（必需）、`structuredContent?`、`usage?`、`isError?`、`terminate?`。

**完整可编译示例**（骨架取自 `P/examples/extensions/hello.ts:1-26`，并补上 `ctx.executeTool` 的用法，签名见 `types.d.ts:269-272`）：

```ts
// my-tools.ts —— 作为 ResourceLoader 的 extensionFactories 传入，或放进 <agentDir>/extensions/
import { Type } from "@earendil-works/pi-ai";                       // P/examples/extensions/hello.ts:5
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// (1) 简单工具
const helloTool = defineTool({
  name: "hello",
  label: "Hello",
  description: "A simple greeting tool",
  promptSnippet: "Greet someone by name",        // 会出现在系统提示的 Available tools 段
  parameters: Type.Object({
    name: Type.String({ description: "Name to greet" }),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    return {
      content: [{ type: "text", text: `Hello, ${params.name}!` }],
      details: { greeted: params.name },
    };
  },
});

// (2) 带结构化输出 + 调用其它工具 + 失败上报
const auditTool = defineTool({
  name: "audit_repo",
  label: "Audit Repo",
  description: "Count files by extension using the built-in find tool.",
  outputSchema: Type.Object({ total: Type.Number() }),
  parameters: Type.Object({
    glob: Type.String({ description: "Glob, e.g. **/*.ts" }),
  }),
  async execute(_toolCallId, params, signal, onUpdate, ctx) {
    onUpdate?.({ content: [{ type: "text", text: "searching…" }], details: undefined });

    // 嵌套调用：走完整工具流水线（校验 + tool_call/tool_result 钩子），
    // 会带 parentToolCallId，详见 P/docs/extensions.md:148 与 types.d.ts:273-277
    const res = await ctx.executeTool("find", { pattern: params.glob }, { signal });
    const total = res.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .reduce((n, c) => n + c.text.split("\n").filter(Boolean).length, 0);

    // 报告「失败但带数据」：用 isError 而不是 throw（P/docs/extensions.md:146）
    if (total === 0) {
      return {
        content: [{ type: "text", text: "no files matched" }],
        details: undefined,
        structuredContent: { total: 0 },
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `matched ${total} files` }],
      details: undefined,
      structuredContent: { total },
    };
  },
});

// (3) 只做「模型可见但不可被其它工具调用」：exposure: "model-only"（P/docs/extensions.md:157）
//     只做「只能被 codemode 调用」：exposure: "codemode"（:158）

export default function (pi: ExtensionAPI) {
  pi.registerTool(helloTool);
  pi.registerTool(auditTool);
}
```

**另一条路：不写扩展，直接 `customTools`**（`P/dist/core/sdk.d.ts:55-56`）：

```ts
const { session } = await createAgentSession({
  customTools: [helloTool, auditTool],   // ToolDefinition[]，绕过扩展系统
});
```

> 区别：`customTools` 只在 `AgentSession` 里注册；`pi.registerTool()` 才能配 `renderCall` / `exposure` / `prepareLoadout` 等扩展特性。`P/dist/core/sdk.d.ts:124-125` 注释明确 `customTools` 是「SDK custom tools registered outside extensions」。

`exposure` 五档语义见 `P/docs/extensions.md:156-160`：`direct`（默认，声明给模型）· `model-only`（声明给模型，不可被调用）· `codemode`（随时可被别的工具调，不自动声明）· `deferred`（同 codemode，但 codemode 不列出，`tool_search` 能找到）· `hidden`（注册但不可达）。

---

## 5. Provider / 模型（内网 OpenAI 兼容端点）

### 5.1 三种配置途径

| 途径 | 适用 | 出处 |
|---|---|---|
| **A. `ModelRuntime.registerProvider()`** | 纯 SDK，无需扩展（**推荐 sidecar 用**） | `P/dist/core/model-runtime.d.ts:117` |
| **B. `pi.registerProvider()`（扩展内）** | 需要 OAuth / `refreshModels` / 自定义 `streamSimple` | `P/dist/core/extensions/types.d.ts:1334-1335` |
| **C. `models.json` 文件** | 运维侧静态配置，不改代码 | `P/docs/models.md:45-66` |

三者关系：`P/docs/custom-provider.md:28` — 「Pi 把 `models.json` 的 overrides 叠加在已注册的原生 provider 之上」。

### 5.2 途径 A：`ModelRuntime.registerProvider()`（可直接用的代码）

`ProviderConfigInput`（`P/dist/core/provider-composer.d.ts:49-62`）：

```ts
interface ProviderConfigInput {
  name?: string;
  baseUrl?: string;
  apiKey?: string;        // 字面量 /  $ENV  /  ${ENV}  /  前导 !命令
  api?: Api;              // "openai-completions" | "openai-responses" | "anthropic-messages" | ...
  streamSimple?: (...);   // 自定义协议时才用
  images?: Partial<Record<ImageApi, ProviderImages>>;
  classifiers?: Partial<Record<ClassifierApi, ProviderClassifier>>;
  headers?: Record<string, string>;
  authHeader?: boolean;   // true → 加 Authorization: Bearer <key>
  oauth?: ExtensionOAuthConfig;
  models?: ProviderModelConfig[];      // 提供则「替换」该 provider 的全部模型
  refreshModels?(context): Promise<ProviderModelConfig[]>;
}
```

`ProviderChatModelConfig`（`provider-composer.d.ts:25-36`）必填：`id`、`name`、`input: ("text"|"image")[]`、`cost`、`reasoning: boolean`、`contextWindow: number`、`maxTokens: number`。可选：`api`、`baseUrl`（模型级覆盖 provider 级）、`headers`、`thinkingLevelMap`、`promptCache`、`samplingParams`、`samplingParamsByThinkingLevel`、`compat`、`inputLimits`。

```ts
// intranet-provider.ts
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export async function createIntranetRuntime(agentDir: string) {
  const rt = await ModelRuntime.create({
    authPath: `${agentDir}/auth.json`,
    modelsPath: `${agentDir}/models.json`,
    allowModelNetwork: false,   // 内网：不要联网抓 catalog
  });

  // Ollama 风格：必须给个占位 key，Ollama 会忽略
  rt.registerProvider("ollama-local", {
    name: "Ollama (local)",
    baseUrl: "http://127.0.0.1:11434/v1",
    api: "openai-completions",
    apiKey: "ollama",
    models: [{
      type: "chat", id: "qwen2.5-coder:7b", name: "Qwen2.5 Coder 7B",
      input: ["text"], reasoning: false, contextWindow: 32768, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  });

  // vLLM / SGLang / 企业网关：带鉴权 + 自定义头
  rt.registerProvider("corp-gateway", {
    name: "Corp AI Gateway",
    baseUrl: process.env.CORP_BASE_URL!,       // e.g. https://ai.corp.internal/v1
    api: "openai-completions",
    apiKey: process.env.CORP_API_KEY!,         // 直接用字面量；也支持 "$CORP_API_KEY"
    headers: { "X-Tenant-Id": process.env.CORP_TENANT ?? "a3" },
    authHeader: true,
    models: [
      {
        type: "chat", id: "qwen3-235b-a22b", name: "Qwen3 235B",
        input: ["text"], reasoning: true, contextWindow: 131072, maxTokens: 16384,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        samplingParams: { temperature: 0.7, top_p: 0.9 },
      },
      {
        type: "chat", id: "deepseek-v3", name: "DeepSeek V3",
        input: ["text"], reasoning: false, contextWindow: 65536, maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });

  return rt;
}
```

**动态刷新 / 换 key**：

```ts
rt.registerProvider("corp-gateway", { baseUrl: "https://new-gw.corp/v1" }); // 只覆盖 URL，保留模型列表
rt.unregisterProvider("corp-gateway");                                       // :118
await rt.setRuntimeApiKey("corp-gateway", "sk-temp");                        // :93，进程级临时 key
await rt.removeRuntimeApiKey("corp-gateway");                                // :94
```

> `registerProvider` 与 `unregisterProvider` 都是**同步 void**；`setRuntimeApiKey` 返回 `Promise<void>`。`registerProvider` 只替换「扩展层」；`models.json` 的 override 优先级更高（`P/docs/custom-provider.md:28-30`）。

### 5.3 列出可用模型

`ModelRuntime` 实现了 pi-ai 的 `Models` 接口（`P/dist/core/model-runtime.d.ts:36`），可用方法（行号同该文件）：

```ts
rt.getProviders(): readonly Provider[];                                     // :68
rt.getProvider(providerId): Provider | undefined;                           // :69
rt.getModels(providerId?): readonly Model<Api>[];                           // :70  同步：全部模型
rt.getModel(providerId, modelId): Model<Api> | undefined;                   // :71  同步：按 id 取
rt.getAvailable(providerId?, options?): Promise<readonly Model<Api>[]>;     // :78  异步：有可用凭证的
rt.getAvailableSnapshot(): readonly Model<Api>[];                           // :79  同步快照
rt.getAllModels(providerId?): readonly AnyModel[];                          // :74
rt.getModelsOfType(type, providerId?): readonly ...[];                      // :72  chat|image|classifier
rt.getRegisteredProviderIds(): readonly string[];                           // :82
rt.checkAuth(providerId, options?): Promise<AuthCheck | undefined>;          // :77
rt.listCredentials(options?): Promise<readonly CredentialInfo[]>;            // :95
rt.getError(): string | undefined;                                          // :80
```

实际用法：

```ts
const available = await rt.getAvailable();                     // 只有凭证就绪的
console.log(available.map((m) => `${m.provider}/${m.id}`));    // 与 P/examples/sdk/02-custom-model.ts:24-28 一致

const all = rt.getModels("corp-gateway");                      // 同步，不看凭证
const one = rt.getModel("corp-gateway", "deepseek-v3");        // 同步
```

> ⚠️ `getAvailable()` 依赖凭证解析，`registerProvider` 的 `apiKey` 会让模型「临时视为已配置」（`model-runtime.d.ts:111-116` `markProvisionallyConfigured`）。凭证来自存储的 `auth.json` 或环境变量时，可用性检查是异步的。

### 5.4 途径 B：扩展里 `pi.registerProvider()`

两个重载（`P/dist/core/extensions/types.d.ts:1334-1335`）：

```ts
registerProvider(provider: Provider): void;                       // 完整原生 Provider（pi-ai）
registerProvider(name: string, config: ProviderConfig): void;     // 本节用的配置形态
```

JSDoc 原文示例（`types.d.ts:1295-1312`）：

```ts
pi.registerProvider("my-proxy", {
  baseUrl: "https://proxy.example.com",
  apiKey: "$PROXY_API_KEY",
  api: "anthropic-messages",
  models: [{
    id: "claude-sonnet-4-20250514",
    name: "Claude 4 Sonnet (proxy)",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 16384,
  }],
});
pi.unregisterProvider("my-proxy");
```

> 注册时机：`P/docs/custom-provider.md:21` — 扩展工厂**异步也会被等待**，所以在工厂里注册的 provider 对启动期模型选择可见。`types.d.ts:1288-1293`：加载期调用会入队，runner 绑好 context 后应用；之后立即生效。

### 5.5 途径 C：`models.json`

安装包自带的文档给的最小可用配置（`P/docs/models.md:49-62`）：

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "qwen2.5-coder:7b" }
      ]
    }
  }
}
```

- `apiKey` / header 值支持 `$NAME`、`${NAME}`、字面量、前导 `!command`（`P/docs/models.md:64`；语法细节 `P/docs/custom-provider.md:76-81`）。
- `models` 条目按 `id` 新增或替换同 provider 的同名模型；改不动内置 metadata 时用 `modelOverrides`（`P/docs/models.md:66`）。
- 文件位置：`<agentDir>/models.json`（`P/dist/config.js:503-505`），即默认 `~/.pi/agent/models.json`。
- 文件在 `/model` 打开时重新加载（`P/docs/models.md:66`）。

### 5.6 把 provider 配置传进 session

```ts
const modelRuntime = await createIntranetRuntime(agentDir);
const model = modelRuntime.getModel("corp-gateway", "qwen3-235b-a22b");
if (!model) throw new Error("intranet model unavailable");

const { session } = await createAgentSession({
  cwd, agentDir, modelRuntime, model,
  thinkingLevel: "medium",                     // 会被 clamp 到模型能力（sdk.js:143）
  tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
});
```

`thinkingLevel` 可选值：`off | minimal | low | medium | high | xhigh | max`（`P/dist/core/defaults.js`，`THINKING_LEVEL_OPTIONS`）。默认 `DEFAULT_THINKING_LEVEL = "medium"`。

**运行时切换模型**：`await session.setModel(model, { persist?: false })`（`AS:644`，`ModelMutationOptions` :189-192）。

### 5.7 必需 / 有用的环境变量

来源 `P/docs/environment-variables.md:79-98`（更全）与 `P/docs/providers.md:31-66`。

| 变量 | 作用 |
|---|---|
| `PI_CODING_AGENT_DIR` | **覆盖配置目录**（默认 `~/.pi/agent`）。**sidecar 必设** |
| `PI_CODING_AGENT_SESSION_DIR` | 覆盖会话存储目录（被 `--session-dir` 覆盖） |
| `PI_PACKAGE_DIR` | 覆盖包目录（Nix/Guix 用） |
| `PI_OFFLINE` | 关闭一切自动联网（含 catalog 刷新、`fd`/`rg` 下载） |
| `PI_SKIP_VERSION_CHECK` | 关闭 pi.dev 版本请求 |
| `PI_TELEMETRY` | `1/true/yes` 或 `0/false/no`，覆盖安装/更新遥测与 provider attribution 头 |
| `PI_CACHE_RETENTION` | 设 `long` 启用扩展 prompt 缓存 |
| `HTTP_PROXY` / `HTTPS_PROXY` | 出站代理 |
| `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`DEEPSEEK_API_KEY` … | 各 provider 主 key，完整表见 `P/docs/providers.md:31-66` |

> `P/docs/environment-variables.md:18`：`AI_AGENT=pi` 与 `PI_CODING_AGENT=true` 这两个进程标记**不会**在 SDK 嵌入时自动设置（只有 CLI / RPC 入口设）。

---

## 6. 权限拦截（重点结论）

### 6.1 结论：**有「工具执行前拦截」钩子**，但**没有内置的 Allow/Ask/Deny 策略引擎**

- **有拦截点**：扩展的 `tool_call` 事件**在每个工具执行前**触发，可返回 `{ block: true, reason }` 阻断。
  `P/dist/core/extensions/types.d.ts:955-960`：*"Fired before a tool executes. Can block."*
  结果类型 `ToolCallEventResult`（`types.d.ts:1065-1074`）：
  ```ts
  interface ToolCallEventResult {
    block?: boolean;
    reason?: string;
    terminate?: boolean;  // 提示 agent 在本批工具后停止；仅当该批全部结果都为 true 才生效
  }
  ```
- **`tool_call` 也是可变的**：`event.input` 可**原地 mutate** 改参数；后续 handler 看到前面的改动；**改动后不做重新校验**（`types.d.ts:957-958`）。
- **还有执行后钩子**：`tool_result`（`types.d.ts:961-1015`，结果可改 `content/details/structuredContent/isError/usage`，`ToolResultEventResult` :1090-1096）。
- **没有**任何内置审批 / 沙箱。`P/docs/security.md:3` 原文：*"Pi can read, change, and execute files with the permissions of the account that started it, and **it does not ask for approval before every tool call**."*（:7 进一步说明项目信任不构成安全边界。）
- **故障安全**：`tool_call` handler 抛错会**阻断该工具**（`P/docs/extensions.md:260`）。
- **MCP 工具同样受管**：`P/dist/extensions/mcp/index.d.ts:20-21` — *"Every call runs through pi's tool pipeline, so `tool_call`/`tool_result` hooks and permission extensions apply to MCP tools the same way they do to built-in tools."*

### 6.2 事件载荷（按工具判别）

`ToolCallEvent`（`types.d.ts:960`）是按 `toolName` 判别的联合，判别辅助函数 `isToolCallEventType(name, event)`（`types.d.ts:1044-1052`）：

```ts
type ToolCallEvent =
  | BashToolCallEvent        // { type:"tool_call"; toolCallId; parentToolCallId?; toolName:"bash"; input: BashToolInput }
  | PowerShellToolCallEvent  // toolName:"powershell"
  | ReadToolCallEvent        // toolName:"read"
  | EditToolCallEvent        // toolName:"edit"
  | WriteToolCallEvent       // toolName:"write"
  | GrepToolCallEvent        // toolName:"grep"
  | FindToolCallEvent        // toolName:"find"
  | LsToolCallEvent          // toolName:"ls"
  | CustomToolCallEvent;     // { toolName: string; input: Record<string, unknown> }
```

（各分支行号 `types.d.ts:918-953`）

### 6.3 在 Electron 里弹审批 → 等外部裁决 → 放行/拒绝

**关键机制**：拦截点里 `await ctx.ui.confirm(...)` / `ctx.ui.select(...)`，宿主通过 `ExtensionUIContext` 把它变成 IPC 往返。

**⚠️ 最重要的坑（运行时已验证）**：`ctx.hasUI` 的实现是 `this.uiContext !== noOpUIContext`（`P/dist/core/extensions/runner.js:404-406`），而 `setUIContext(uiContext, mode = "print")` 在 `uiContext` 为空时替换为 `noOpUIContext`（`runner.js:355-357`）。`noOpUIContext.confirm` 是 `async () => false`（`runner.js:132-134`）。

**结论**：只传 `mode: "rpc"` **不会**让 `hasUI` 变 true；**必须通过 `session.bindExtensions({ uiContext })` 传入真实对象**，否则所有审批一律 `false` → 全部被拒。

```ts
// approval.ts —— tool_call 拦截 + 外部裁决
import type { ExtensionAPI, ExtensionUIContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";

export type Verdict = "allow" | "ask" | "deny";

/** policy 由宿主提供：可以是静态规则，也可以是「查本地白名单」 */
export function policyFor(event: ToolCallEvent, cwd: string): Verdict {
  if (event.toolName === "read" || event.toolName === "grep" || event.toolName === "find" || event.toolName === "ls") {
    return "allow";
  }
  if (event.toolName === "bash" || event.toolName === "powershell") {
    const cmd = String((event.input as { command?: unknown }).command ?? "");
    if (/\b(rm\s+-rf|sudo|mkfs|format\s+[a-z]:|chmod\s+777|curl\s+.*\|\s*(ba)?sh)\b/i.test(cmd)) return "deny";
    return "ask";
  }
  if (event.toolName === "write" || event.toolName === "edit") {
    const p = String((event.input as { path?: unknown }).path ?? "");
    if (/(^|[\\/])(\.env|\.git|node_modules)([\\/]|$)/.test(p)) return "deny";
    if (p.startsWith(cwd)) return "allow";     // 工作区内直接放行
    return "ask";
  }
  return "ask";                                 // 未知 / MCP / 自定义工具：默认问
}

/** 挂到 DefaultResourceLoader.extensionFactories */
export function approvalExtension(resolve: (event: ToolCallEvent, cwd: string) => Verdict) {
  return (pi: ExtensionAPI) => {
    pi.on("tool_call", async (event, ctx) => {
      const verdict = resolve(event, ctx.cwd);

      if (verdict === "allow") return undefined;                 // undefined = 放行
      if (verdict === "deny") {
        return { block: true, reason: `denied by policy: ${event.toolName}`, terminate: false };
      }

      // verdict === "ask"
      if (!ctx.hasUI) {
        // 无 UI 时 fail-safe 阻断（与 examples/extensions/permission-gate.ts:20-23 一致）
        return { block: true, reason: "审批不可用（未绑定 uiContext），已默认阻断" };
      }
      const ok = await ctx.ui.confirm(
        `允许执行 ${event.toolName}？`,
        JSON.stringify(event.input).slice(0, 2000),
        { timeout: 120_000 },                                    // ExtensionUIDialogOptions（types.d.ts:40-45）
      );
      return ok ? undefined : { block: true, reason: "用户拒绝" };
    });
  };
}
```

**宿主侧：实现 `ExtensionUIContext` 并绑定**

```ts
// electron-ui.ts
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

type AskRenderer = (req: {
  kind: "select" | "confirm" | "input";
  title: string;
  message?: string;
  options?: string[];
  timeoutMs?: number;
}) => Promise<{ value?: string; confirmed?: boolean }>;

/**
 * 只实现有语义的方法；其余用 no-op。
 * Electron 场景下真正需要的是 select / confirm / input / notify。
 * RPC 模式下的官方降级清单见 P/docs/rpc-extension-ui.md:14-25（可照抄）。
 *
 * 末尾的 `as unknown as ExtensionUIContext` 是必要的：`custom()`、`theme`、
 * `setWidget()` 等带泛型/重载/TUI 组件的成员无法在无终端环境里如实实现。
 */
export function createElectronUIContext(ask: AskRenderer): ExtensionUIContext {
  const impl = {
    // —— 对话方法：这里就是「弹审批、等外部裁决」的落点 ——
    select: async (title: string, options: string[], opts?: { timeout?: number }) =>
      (await ask({ kind: "select", title, options, timeoutMs: opts?.timeout })).value,
    confirm: async (title: string, message: string, opts?: { timeout?: number }) =>
      (await ask({ kind: "confirm", title, message, timeoutMs: opts?.timeout })).confirmed === true,
    input: async (title: string, placeholder?: string, opts?: { timeout?: number }) =>
      (await ask({ kind: "input", title, message: placeholder, timeoutMs: opts?.timeout })).value,

    // —— 通知：单向推给渲染进程 ——
    notify: (message: string, type?: "info" | "warning" | "error") => {
      /* ipc.send("pi:notify", { message, type }) */
    },

    // —— 以下按 RPC 模式的降级方式给最小实现（P/docs/rpc-extension-ui.md:14-25）——
    editor: async () => undefined,
    custom: async () => undefined,
    onTerminalInput: () => () => {},
    setStatus: () => {}, setWorkingMessage: () => {}, setWorkingVisible: () => {},
    setWorkingIndicator: () => {}, setHiddenThinkingLabel: () => {},
    setWidget: () => {}, setFooter: () => {}, setHeader: () => {}, setTitle: () => {},
    pasteToEditor: () => {}, setEditorText: () => {},
    getEditorText: () => "",
    addAutocompleteProvider: () => {}, setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    getAllThemes: () => [], getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "not supported in sidecar" }),
    getToolsExpanded: () => false, setToolsExpanded: () => {},
    theme: undefined,
  };
  return impl as unknown as ExtensionUIContext;
}
```

```ts
// sidecar-with-approval.ts（装配顺序很重要）
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { approvalExtension, policyFor } from "./approval";
import { createElectronUIContext } from "./electron-ui";

const agentDir = process.env.SIDECAR_DATA_DIR!;
const cwd = process.cwd();
const modelRuntime = await ModelRuntime.create({ authPath: `${agentDir}/auth.json`, modelsPath: `${agentDir}/models.json` });

// 1) 扩展通过 ResourceLoader 装载
const resourceLoader = new DefaultResourceLoader({
  cwd,
  agentDir,
  extensionFactories: [approvalExtension(policyFor)],
  noExtensions: true,            // 不要扫 ~/.pi/agent/extensions（P/dist/core/resource-loader.d.ts:80）
  noSkills: true,                // 按需
  noThemes: true,
  noPromptTemplates: true,
  noContextFiles: false,
});
await resourceLoader.reload();    // 必须：加载扩展工厂

const { session } = await createAgentSession({
  cwd, agentDir, modelRuntime,
  resourceLoader,
  sessionManager: SessionManager.inMemory(cwd),
  settingsManager: SettingsManager.inMemory({ enableInstallTelemetry: false }),
});

// 2) 装 UI 上下文 —— 这一步决定 ctx.hasUI（见上文 runner.js:355-357,404-406）
await session.bindExtensions({
  uiContext: createElectronUIContext(askRendererOverIPC),
  mode: "rpc",                   // ExtensionMode: "tui"|"rpc"|"json"|"print"（types.d.ts:212）
  // onError: (err) => log(err)  // ExtensionErrorListener，可选
});

// 3) 之后再 prompt
await session.prompt("重构 src/utils/date.ts");
```

> `ExtensionBindings` 全字段：`uiContext?`、`mode?`、`commandContextActions?`、`abortHandler?`、`shutdownHandler?`、`onError?`（`AS:165-172`）。
> `bindExtensions({})` 是合法调用（`P/examples/sdk/14-codemode-mcp.ts:50`、`P/examples/sdk/13-session-runtime.ts:43`）——用于触发 `session_start`（MCP 连接等）。

**用 `annotations` 做审批决策**（MCP 工具会带服务端声明的 hints）——官方给的可直接抄的片段（`P/docs/extensions.md:168-178`）：

```ts
pi.on("tool_call", async (event, ctx) => {
  const hints = pi.getAllTools().find((t) => t.name === event.toolName)?.annotations;
  const needsApproval =
    hints?.destructiveHint === true ||
    (!hints?.readOnlyHint && ((hints?.destructiveHint ?? true) || (hints?.openWorldHint ?? true)));
  if (needsApproval && !(await ctx.ui.confirm("Allow tool call?", event.toolName))) {
    return { block: true, reason: `${event.toolName} was not approved` };
  }
});
```

`annotations` 字段：`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`；缺省按 MCP 默认（非只读、可能破坏性、可能开放世界）（`P/docs/extensions.md:166`）。定义见 `types.d.ts:479`。

**官方现成范例**（可直接读）：
- `P/examples/extensions/permission-gate.ts` — 危险 bash 模式（`rm -rf`、`sudo`、`chmod 777`）确认；无 UI 时默认阻断（`permission-gate.ts:20-23`）
- `P/examples/extensions/protected-paths.ts` — 按路径阻断 `write`/`edit`
- `P/examples/extensions/confirm-destructive.ts` — 会话级 `session_before_*` 取消

### 6.4 替代方案 A：RPC 模式的审批协议（sidecar 分离进程时首选）

`P/docs/rpc-extension-ui.md` 定义了一套**现成的**对话框子协议：`ctx.ui.select/confirm/input/editor` 会向 stdout 发 `extension_ui_request` 并阻塞，直到客户端在 stdin 回 `extension_ui_response`（:7）。

请求示例（`rpc-extension-ui.md:35-44`）：

```json
{ "type": "extension_ui_request", "id": "uuid-1", "method": "select",
  "title": "Allow dangerous command?", "options": ["Allow", "Block"], "timeout": 10000 }
```

应答（:176-194）：

```json
{"type":"extension_ui_response","id":"uuid-1","value":"Allow"}
{"type":"extension_ui_response","id":"uuid-2","confirmed":true}
{"type":"extension_ui_response","id":"uuid-3","cancelled":true}
```

要点：
- 带 `timeout` 的对话框，agent 侧超时自动用默认值解析，客户端不用管超时（:10）。
- RPC 模式下 `ctx.mode === "rpc"`、`ctx.hasUI === true`（:25）。
- 客户端范例：`P/examples/rpc-extension-ui.ts`；配套扩展：`P/examples/extensions/rpc-demo.ts`。

### 6.5 替代方案 B：operations 注入（不写扩展时的最后手段）

如果因为架构原因不能用扩展系统，可把内置工具的底层 I/O 换成自己的实现——**但注意 `createAgentSession` 不暴露 `ToolsOptions`**（§2.2），所以这条路同样需要直接构造 `AgentSession` 或自定义 runtime：

- `createLocalBashOperations(options?: { shellPath?: string }): BashOperations`（`P/dist/core/tools/bash.d.ts:61-63`，`P/dist/index.d.ts:26`）——用于拦截/改写 bash 后仍走 Pi 标准本地执行。
- `createLocalPowerShellOperations(): PowerShellOperations`（`powershell.d.ts:13`）。
- `BashOperations.exec(command, cwd, { onData, signal, timeout, env }) => Promise<{ exitCode: number | null }>`（`bash.d.ts:35-52`）——在这里做审批、改写命令、转发到远端。
- `BashToolOptions.spawnHook?: BashSpawnHook`（`bash.d.ts:80`）：`(ctx: BashSpawnContext) => BashSpawnContext`，`BashSpawnContext = { command, cwd, env }`（:64-69）。session 环境变量注入发生在 hook **之前**（`P/docs/environment-variables.md:53`）。
- `ReadOperations` / `WriteOperations` / `EditOperations` / `GrepOperations` / `FindOperations` / `LsOperations` 同构（§4.2 表格）。
- `AgentSessionConfig.baseToolsOverride: Record<string, AgentTool>`（`AS:151-157`）——整把替换。

---

## 7. Skills

### 7.1 文件格式

一个 skill = 一个目录，内含 `SKILL.md`（`P/docs/skills.md:11-22`）：

```text
pdf-tools/
├── SKILL.md
├── scripts/extract.sh
├── references/formats.md
└── assets/template.json
```

```markdown
---
name: pdf-tools
description: Extract text and tables from PDF files. Use when reading, converting, or inspecting PDFs.
---

# PDF tools

Read `references/formats.md` before converting a document. Run scripts relative to this skill directory.
```

**frontmatter 全部字段**（Agent Skills 规范，`P/docs/skills.md:69-79`）：

| 字段 | 用途 |
|---|---|
| `name` | 命令名与显示名 |
| `description` | 展示给模型的路由描述（决定何时加载） |
| `license` | 许可证名或随包许可证文件 |
| `compatibility` | 环境要求 |
| `metadata` | 附加键值对 |
| `allowed-tools` | 实验性的预批准工具列表 |
| `disable-model-invocation` | 从自动模型选择中隐藏该 skill |

约束（`P/docs/skills.md:81-85`）：`name` 仅小写字母/数字/连字符，不能有前导、尾随、连续连字符，≤64 字符；`description` ≤1024 字符。malformed 或**无 description** 的 skill **不会被加载**；同名冲突保留**第一个**并给 warning。Pi 不会因为 `name` 与父目录不同名而报错或告警（:83）。

**TypeScript 侧类型**（`P/dist/core/skills.d.ts:3-16`）：

```ts
interface SkillFrontmatter {
  name?: string;
  description?: string;
  "disable-model-invocation"?: boolean;
  [key: string]: unknown;      // 其余字段透传
}
interface Skill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  sourceInfo: SourceInfo;
  disableModelInvocation: boolean;
}
```

> 注意：`SkillFrontmatter` 只**声明**了 3 个字段 + 索引签名；`license` / `compatibility` / `metadata` / `allowed-tools` 走索引签名，**不被解析成 `Skill` 上的字段**。

### 7.2 加载

```ts
// P/dist/core/skills.d.ts:21-35
export interface LoadSkillsFromDirOptions {
  dir: string;
  source: string;
}
export declare function loadSkillsFromDir(options: LoadSkillsFromDirOptions): LoadSkillsResult;
// LoadSkillsResult = { skills: Skill[]; diagnostics: ResourceDiagnostic[] }   (:17-20)

// P/dist/core/skills.d.ts:48-62
export interface LoadSkillsOptions {
  cwd: string;
  agentDir: string;
  skillPaths: string[];       // 显式路径（文件或目录）
  includeDefaults: boolean;   // 是否含默认目录
}
export declare function loadSkills(options: LoadSkillsOptions): LoadSkillsResult;
```

**发现规则**（`skills.d.ts:27-35`）：
- 目录含 `SKILL.md` → 视为 skill 根，**不再向下递归**
- 否则加载根目录下的直接 `.md` 子文件
- 再递归子目录找 `SKILL.md`

**默认扫描位置**（`P/dist/core/skills.js:354-357`，仅当 `includeDefaults`）：
- `<agentDir>/skills`（source `"user"`）
- `<cwd>/.pi/skills`（source `"project"`，`CONFIG_DIR_NAME` 默认 `.pi`，见 `P/dist/config.js:473`）

另外 Pi 也支持 Agent Skills 的 `~/.agents/skills/` 与 `.agents/skills/`（`P/docs/skills.md:61`）。**注意这不是 `loadSkills()` 的职责**：`loadSkills()` 本体只处理 `<agentDir>/skills`、`<cwd>/.pi/skills` 与显式 `skillPaths`（`P/dist/core/skills.js:354-357,377`）；`.agents/skills` 由包管理器层处理——`P/dist/core/package-manager.js:297`（逐级向上找 `.agents/skills`）与 `:2023`（`~/.agents/skills`）。

> 项目级 `.agents/skills` 属于**需要项目信任**的资源（`P/dist/core/trust-manager.js:146-160`），而用户级 `~/.agents/skills` 始终被当作可用（同文件 :148）。与 `P/docs/security.md:43` 一致。

用法：

```ts
import { loadSkills, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

// 只要我自己的目录
const { skills, diagnostics } = loadSkillsFromDir({ dir: "/opt/a3/skills", source: "a3" });
for (const d of diagnostics) console.warn(d);

// 或走全部默认位置
const all = loadSkills({ cwd: process.cwd(), agentDir: getAgentDir(), skillPaths: [], includeDefaults: true });
```

### 7.3 注入 system prompt

```ts
// P/dist/core/skills.d.ts:36-47
/**
 * Uses XML format per Agent Skills standard.
 * Skills with disableModelInvocation=true are excluded from the prompt.
 * `fileReadTool` names the tool that loads skill files; `indirect` names none.
 */
export declare function formatSkillsForPrompt(
  skills: Skill[],
  fileReadTool?: "read" | "bash" | "indirect"
): string;
```

**两条路径**：

1. **推荐（默认自动）**：`DefaultResourceLoader` 会自己发现 skills，并由内部 `buildSystemPrompt` 注入。
   `P/dist/core/system-prompt.js:102-108`：
   ```js
   const readers = ["read", "bash"];
   const skillFileReadTool = readers.find((t) => declaredTools.includes(t))
     ?? (readers.some((t) => selectedTools.includes(t)) ? "indirect" : undefined);
   if (skillFileReadTool && skills.length > 0) {
     const skillsPrompt = formatSkillsForPrompt(skills, skillFileReadTool).trim();
     if (skillsPrompt) promptSections.skills = skillsPrompt;
   }
   ```
   装配时只需给 `skillsOverride` 做筛选/追加（`P/examples/sdk/04-skills.ts:30-37`）：
   ```ts
   const loader = new DefaultResourceLoader({
     cwd: process.cwd(),
     agentDir: getAgentDir(),
     skillsOverride: (current) => ({
       skills: [...current.skills.filter((s) => s.name.includes("browser")), customSkill],
       diagnostics: current.diagnostics,
     }),
   });
   await loader.reload();
   const { skills: allSkills, diagnostics } = loader.getSkills();   // :41
   ```
   构造内存里的 skill 需要 `sourceInfo`：
   ```ts
   import { createSyntheticSourceInfo, type Skill } from "@earendil-works/pi-coding-agent";
   const customSkill: Skill = {
     name: "my-skill",
     description: "Custom project instructions",
     filePath: "/virtual/SKILL.md",
     baseDir: "/virtual",
     sourceInfo: createSyntheticSourceInfo("/virtual/SKILL.md", { source: "sdk" }),
     disableModelInvocation: false,
   };
   ```
   （`04-skills.ts:18-25`；`createSyntheticSourceInfo` 签名 `P/dist/core/source-info.d.ts:20-25`，`SourceScope = "user"|"project"|"temporary"`，`SourceOrigin = "package"|"top-level"`）

2. **完全自己控 prompt**：自定义 `ResourceLoader.getSystemPrompt()`，把 `formatSkillsForPrompt(skills, "read")` 拼进去（接口见 `P/dist/core/resource-loader.d.ts:32-62`，`P/examples/sdk/12-full-control.ts:36-49` 给了完整骨架）。

> ⚠️ **坑**：skills 段只在 `read` 或 `bash` 出现在「声明或选中」工具里时才注入（`system-prompt.js:102-105`）。如果你的 `tools: ["grep","find","ls"]`，**所有 skill 描述会静默消失**。

### 7.4 模型怎么用它

- 启动时只把 `name` / `description` / 路径放进 system prompt，**不放全文**（`P/docs/skills.md:43`）。
- 命中任务时模型自己去读 `SKILL.md`。
- 强制调用：`/skill:name args`，参数会作为 user request 追加（`P/docs/skills.md:45-51`）。
- `disable-model-invocation: true` → 只能显式命令调用；`enableSkillCommands` setting 控制是否注册为斜杠命令（`P/docs/skills.md:53`；setting 见 `P/docs/settings.md:156`）。
- 会话中改了 skill 文件要 `/reload`（`P/docs/skills.md:89`）。

---

## 8. MCP（最小接入配方）

### 8.1 配置文件 `mcp.json`

位置（`P/docs/mcp.md:32`）：
- 用户级：`~/.pi/agent/mcp.json`（即 `<agentDir>/mcp.json`）
- 项目级：`<cwd>/.pi/mcp.json`（**需要项目信任**）
- 项目条目覆盖同名用户级条目（:34）

格式（与其它 MCP 客户端一致，`P/docs/mcp.md:46-60`）：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "docs": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" },
      "description": "Search and read the product documentation"
    }
  }
}
```

字段全集（`P/dist/core/mcp-servers.d.ts:25-107`）：

| 字段 | 适用 | 说明 |
|---|---|---|
| `type?` | 两者 | 可选，`"stdio" \| "http" \| "streamable-http"`；有 `command` → stdio，有 `url` → HTTP。**`sse` 被拒**（`mcp.md:79`） |
| `command` / `args` / `env` / `cwd` | stdio | `command` 是**单个可执行文件**，不是 shell 字符串（`mcp.md:80`） |
| `url` / `headers` / `oauth` | http | |
| `exposure?` | 两者 | `"codemode"`（**默认**）\| `"deferred"` \| `"direct"` \| `"hidden"` |
| `toolExposure?` | 两者 | `Record<toolNameOrPattern, McpExposure>`，精确名优先于 pattern |
| `description?` | 两者 | 一句话；用于 `mcp_servers` system prompt 段、tool_search 排序、codemode 的 `describeNamespace()` |
| `enabled?` | 两者 | 默认 `true`；`false` 保留条目不连接 |
| `timeout?` | 两者 | 单请求超时秒数，默认 60 |
| `auth?` | http | `{ provider: "<pi provider>" }` 用 `/login` 的 token；**项目 mcp.json 不允许** |

顶层可选 `autoEnableCodemode`（默认 true）（`P/dist/extensions/mcp/config.d.ts:28-30`）。

**exposure 语义**（`P/dist/extensions/mcp/index.d.ts:9-18`、`mcp-servers.d.ts:16-23`）：
- `codemode`（默认）：工具**不声明给模型**，只能被 codemode 脚本用 `searchTools()` 找到。会自动激活 `codemode` 工具。
- `deferred`：不声明，直到 `tool_search` 加载它们；会激活 `tool_search` 而非 codemode。
- `direct`：立即声明给模型。
- `hidden`：注册但不可达。

**工具命名**：`mcp__<server>__<tool>`，非字母数字下划线字符替换为 `_`（`mcp.md:77`）。服务器名只能用字母/数字/`_`/`-`；`-` 与 `_` 差异会被视为同名服务器冲突。

### 8.2 SDK 里最小可用配方

来源：`P/examples/sdk/14-codemode-mcp.ts` + `P/docs/sdk.md:116`。

```ts
import {
  createAgentSession, createCodemodeExtension, createMcpExtension, createToolSearchExtension,
  DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

const cwd = process.cwd();
const agentDir = getAgentDir();

const resourceLoader = new DefaultResourceLoader({
  cwd,
  agentDir,
  extensionFactories: [
    createCodemodeExtension({ mode: "on" }),   // CodemodeExtensionOptions
    createToolSearchExtension(),
    createMcpExtension(),                      // 读 <agentDir>/mcp.json + 受信项目的 .pi/mcp.json
  ],
});
await resourceLoader.reload();

// codemode / tool_search 默认「注册但未激活」。用 +name 追加而非替换（14-codemode-mcp.ts:40）
const settingsManager = SettingsManager.create(cwd);
settingsManager.applyOverrides({ defaultTools: ["+codemode", "+tool_search"] });

const { session } = await createAgentSession({
  cwd, agentDir, resourceLoader, settingsManager,
  sessionManager: SessionManager.inMemory(cwd),
});

// 关键：发出 session_start，MCP 服务器在后台开始连接
await session.bindExtensions({});
console.log("active tools:", session.getActiveToolNames());
```

配套要点：
- **CLI 会把 codemode / tool_search / MCP 作为内置扩展自动加载；SDK 不会**，必须自己加进 `extensionFactories`（`P/docs/sdk.md:116`）。
- 若想让 MCP 工具**直接声明给模型**（不用 codemode），在 `mcp.json` 里给服务器设 `"exposure": "direct"`。
- 首个 prompt 最多等 `direct` 服务器 `startupWaitMs`（默认 10000）毫秒（`mcp/index.d.ts:49-54`）。
- `P/docs/sdk.md:116` 提醒：如果只用 `tools: [...]` 白名单，会隐藏 MCP 工具；用 `defaultTools` 的 `+name` 形式更好。

**编程式注册（不写 mcp.json）**——扩展里（`P/docs/extensions.md:192-201`）：

```ts
pi.registerMcpServer("jira", { url: "https://mcp.example.com/jira", exposure: "codemode" });
pi.unregisterMcpServer("jira");
```

`P/dist/core/mcp-servers.d.ts:118-137` 给出 `RegisteredMcpServer{ name, config, extensionPath }` 与 `McpServerRegistry`。注册在**加载期**的服务器随 `session_start` 连接；之后注册的立即连接。`mcp.json` 同名条目会覆盖注册的服务器（`mcp/index.d.ts:5-6`）。
自定义扩展也可以自己读：`pi.getMcpServers()` 于 `session_start`，并处理 `mcp_servers_change` 事件（`extensions.md:203`）。

**`createMcpExtension` 可配项**（`P/dist/extensions/mcp/index.d.ts:33-55`）：`loadConfig?`、`createTransport?`、`credentials?`（默认 `<agentDir>/mcp-auth.json`）、`logPath?`（默认 `<agentDir>/mcp.log`）、`openUrl?`、`updateConfig?`、`startupWaitMs?`。

**限制**：不支持 legacy SSE 传输（`mcp.md:64`）。把 `loadConfig` 换掉可以完全绕开文件系统（适合把 MCP 配置放在 Electron 的应用配置里）。

---

## 9. 坑与注意

### 9.1 `~/.pi` 污染 —— 会，而且创建会话就会开始写（运行时已验证）

**默认 agent 目录**：`getAgentDir()` → `join(homedir(), CONFIG_DIR_NAME, "agent")`，即 **`~/.pi/agent`**（`P/dist/config.js:491-497`；`CONFIG_DIR_NAME` 来自 `package.json` 的 `piConfig.configDir` = `".pi"`，`P/package.json:6-8`、`P/dist/config.js:473`）。可用 `PI_CODING_AGENT_DIR` 覆盖（`ENV_AGENT_DIR = \`${APP_NAME.toUpperCase()}_CODING_AGENT_DIR\``，`APP_NAME` 默认 `"pi"`，`P/dist/config.js:471,476`）。

**agent 目录下的全部内容清单**（`P/docs/configuration.md:11-24`）：

| 路径 | 责任 | Pi 会写吗 |
|---|---|---|
| `<agentDir>/settings.json` | 用户级设置 | 仅在调用 setter 后（见下） |
| `<agentDir>/keybindings.json` | 键位 | 交互模式 |
| `<agentDir>/mcp.json` | MCP 服务器 | 仅 `/mcp` 或 `pi mcp add` |
| `<agentDir>/models.json` | 兼容端点 / 模型覆盖 | **只读**（未观察到创建） |
| `<agentDir>/auth.json` | API key / OAuth 凭证 | **会创建**（已验证） |
| `<agentDir>/AGENTS.override.md`、`AGENTS.md`、`CLAUDE.md` | 用户级指令 | 只读 |
| `<agentDir>/SYSTEM.md`、`APPEND_SYSTEM.md` | 系统提示替换/追加 | 只读 |
| `<agentDir>/extensions/`、`skills/`、`prompts/`、`themes/` | 用户资源 | 只读 |
| `<agentDir>/models-store.json` | 模型目录缓存 | **会创建**（已验证） |
| `<agentDir>/sessions/--<encoded-cwd>--/` | 会话 | **会 mkdir**（已验证） |
| `<agentDir>/bin/` | 托管二进制 `fd` / `rg` | **会下载**（见 9.2） |
| `<agentDir>/mcp.log`、`mcp.log.1` | MCP 服务器日志（>5MB 轮转） | 用 MCP 时（`P/docs/mcp.md:98`） |
| `<agentDir>/mcp-auth.json` | MCP OAuth token | 用 MCP OAuth 时（`P/docs/mcp.md:129`） |
| `<agentDir>/trust.json` | 项目信任决策 | 做信任决策时（`P/docs/security.md:70`） |
| `<agentDir>/pi-debug.log` | 调试日志 | `getDebugLogPath()`（`P/dist/config.js:531-533`），CLI 用 |

**运行时验证结果**（临时 `PI_CODING_AGENT_DIR`，`node v22.22.0`）：

```
== Test B: default createAgentSession() ==
B agentDir = <temp>\pi-probeB-9K17N7
B sessionFile = <temp>\pi-probeB-9K17N7\sessions\--D--work-code-shudao-a3-lib-i-pi-desk-packages-agent-host--\2026-10-10T04-56-30-090Z_01a1242b-....jsonl
B tree after createAgentSession():
   auth.json
   models-store.json
   sessions/
     --D--work-code-shudao-a3-lib-i-pi-desk-packages-agent-host--/
```

即：**只要 `await createAgentSession()`，就会在 agent 目录写入/创建 `auth.json`、`models-store.json`，并 `mkdir` 出 `<cwd>` 专属的 `sessions/` 子目录**（`.jsonl` 文件本身此时尚未落盘）。

代码依据：
- `createAgentSession` 默认 `sessionManager = SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir))`（`P/dist/core/sdk.js:77`）
- `getDefaultSessionDir` 内部 `mkdirSync(sessionDir, { recursive: true })`（`P/dist/core/session-manager.js:296-302`）
- 默认目录拼接：`join(resolvedAgentDir, "sessions", "--<cwd 去掉前导分隔符、[/\:]→->--")`（`session-manager.js:290-295`）
- 会话目录结构：`~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl`（`P/docs/session-format.md:11`；`<session-id>` 默认 UUID，`:14`）
- `.jsonl` 落盘时机：**只在会话首次包含 user 或 assistant 消息时创建**（`P/dist/core/session-manager.d.ts:248-254`；`P/docs/session-format.md:16-21` 讲删除）

**cwd 侧不污染（已验证）**：`createAgentSession({ cwd })` 后 `cwd` 目录条目为空——Pi **不会**在你的项目里建 `.pi/`。只有 CLI 或你手动放 `SYSTEM.md`/`settings.json` 才有。

**`SettingsManager` 的写时机**：`SettingsManager.create(cwd, agentDir?)` **只读**（`P/dist/core/settings-manager.js:223-230`、`257`）。只有调用 setter（`setDefaultModel`、`setDefaultThinkingLevel`、`setTheme`、`setEnabledModels` …）才 `this.save()` → `enqueueWrite("global"|"project", ...)`（`settings-manager.js:474-482`、`521`、`536`、`541`）。`applyOverrides()` **纯内存**（`settings-manager.js:389-391`），不落盘。

**SDK 侧的隔离配方**（sidecar 强烈建议）：

```ts
// 方式 1：进程环境（最省事，覆盖 getAgentDir/getSessionsDir 的所有下游）
process.env.PI_CODING_AGENT_DIR = path.join(app.getPath("userData"), "pi-agent");
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(app.getPath("userData"), "pi-sessions");
process.env.PI_OFFLINE = "1";              // 关掉 catalog 刷新 + fd/rg 下载
process.env.PI_TELEMETRY = "0";

// 方式 2：SDK 选项（更显式）
await createAgentSession({
  agentDir: myDataDir,                          // 同时决定 auth.json/models.json 默认位置
  modelRuntime: await ModelRuntime.create({
    authPath: p.join(myDataDir, "auth.json"),
    modelsPath: p.join(myDataDir, "models.json"),
    modelsStorePath: p.join(myDataDir, "models-store.json"),
    allowModelNetwork: false,
  }),
  sessionManager: SessionManager.inMemory(cwd),  // 或 SessionManager.create(cwd, mySessionsDir)
  settingsManager: SettingsManager.inMemory({ ... }),   // 完全不碰 settings.json
  resourceLoader: new DefaultResourceLoader({
    cwd, agentDir: myDataDir,
    noExtensions: true, noThemes: true,          // 不被用户的 ~/.pi 影响
  }),
});
```

> 想彻底「零落盘」：`SessionManager.inMemory()` + `SettingsManager.inMemory()` + `ModelRuntime.create({ modelsPath: null })`（`modelsPath: null` → 无 `models.json`，且 `FileModelsStore` 换成 `InMemoryCodingAgentModelsStore`，见 `P/dist/core/model-runtime.js` `create` 内联逻辑）——但 `auth.json` 仍会被 `DefaultAuthStorage` 创建。**文档未明确**是否可以用自定义 `CredentialStore` 完全避免；`CreateModelRuntimeOptions.credentials?: CredentialStore`（`model-runtime.d.ts:6`）看起来可行，需运行时验证。

### 9.2 `grep` / `find` 会下载二进制到 `<agentDir>/bin/`

`P/dist/core/tools/grep.js:52` 调 `ensureTool("rg")`，`P/dist/core/tools/find.js:119` 调 `ensureTool("fd")`。`ensureTool`（`P/dist/utils/tools-manager.js:300-341`）：
1. 先找系统 PATH 上的 `rg`/`fd`/`fdfind`（`getToolPath`，:75）；
2. 找不到且**未设 `PI_OFFLINE`** → 从 GitHub release **下载**到 `getBinDir()`（`TOOLS_DIR = getBinDir()`，`tools-manager.js:9`；`getBinDir() = join(getAgentDir(), "bin")`，`P/dist/config.js:519-521`）。

默认 `tools` 是 `read,bash,edit,write`（不含 grep/find），所以**只有当你启用 `grep`/`find` 时才触发**。本机 `~/.pi/agent/bin/fd.exe` 已存在，印证此行为。设 `PI_OFFLINE=1` 会跳过下载并让工具返回「unavailable」错误。

### 9.3 `getModel` 陷阱（文档与类型不一致 —— 最高优先级）

**文档说**（两处）：
- `P/dist/core/sdk.d.ts:90`：`import { getModel } from '@earendil-works/pi-ai';`
- `P/examples/sdk/README.md:36`：`import { getModel } from "@earendil-works/pi-ai";`

**实际（v1.1.0）**：`@earendil-works/pi-ai` 的入口 `AI/dist/index.d.ts` **不导出 `getModel`**；`export * from "./models.ts"`（`index.d.ts:20`）而 `AI/dist/models.js` 只导出 `ModelsError`、`getModelType`、`isModelType`、`createModels`、`createProvider`、`hasApi`、`calculateCost`、`getSupportedThinkingLevels`、`clampThinkingLevel`、`modelsAreEqual`。我逐一核对过 `AI/dist/index.js` 与 `AI/dist/models.js` 的 `export` 语句：**没有 `getModel`**。

所以`import { getModel } from "@earendil-works/pi-ai"` 在 v1.1.0 下会**编译报错 / 运行时 undefined**（`package.json` 无 `getModel` 的 subpath 导出，`AI/package.json` 的 `exports` 只有 `.`、`./models`、`./compat`、`./providers/*`、`./api/*`、`./utils/*`、`./oauth`、`./bedrock-provider`、`./bun-oauth`）。

**唯一存在的 `getModel`** 在 `@earendil-works/pi-ai/compat`，且**已废弃**（`AI/dist/compat.d.ts:33-34`）：

```ts
/** @deprecated Static catalog read. Use `getBuiltinModel` from "@earendil-works/pi-ai/providers/all" or `Models.getModel()`. */
export declare const getModel: typeof getBuiltinModel;
```

而 `compat.d.ts:1-11` 自己声明这个入口「is deleted with the coding-agent ModelManager migration」。**更重要的是：`getBuiltinModel` 只查内置 catalog，返回不了你 `models.json` / `registerProvider` 注册的内网模型。**

**正确写法**（本文档全程使用）：

```ts
const modelRuntime = await ModelRuntime.create({ /* ... */ });
const model = modelRuntime.getModel("corp-gateway", "qwen3-235b-a22b");  // P/dist/core/model-runtime.d.ts:71
```

这与 `P/examples/sdk/02-custom-model.ts:12,18`（用 `modelRuntime.getModel(...)`）一致；`12-full-control.ts:7,25` 用 compat 的 `getModel` 是**历史遗留写法**。

### 9.4 `createAgentSession` 文档里的 `continueSession` 不存在

`P/dist/core/sdk.d.ts:96-99` 的 JSDoc 示例写：

```typescript
// Continue previous session
const { session, modelFallbackMessage } = await createAgentSession({ continueSession: true });
```

但 `CreateAgentSessionOptions`（同文件 :10-65）**没有 `continueSession` 字段**。正确做法是 `SessionManager.continueRecent(cwd, sessionDir?)`（`P/dist/core/session-manager.d.ts:384`），见 `P/examples/sdk/11-sessions.ts:24-27`。

### 9.5 `thinkingLevel` 默认值三处不一致

| 出处 | 说法 |
|---|---|
| `P/dist/core/sdk.d.ts:19` | `Default: from settings, else 'medium'` |
| `P/examples/sdk/README.md:113` | `From settings/"off"` |
| `P/docs/settings.md:13` | `defaultThinkingLevel` 默认 `"medium"` |
| 代码 `P/dist/core/defaults.js` | `export const DEFAULT_THINKING_LEVEL = "medium";` |

**代码为准：`medium`。** README 表格过期。

### 9.6 其他必须知道的点

- **`prompt()` 在流式中必须给 `streamingBehavior`**，否则 reject（`P/docs/sdk.md:66`，`PromptOptions.streamingBehavior` `AS:181-182`）。
- **`agent_end` ≠ 结束**：之后可能有自动重试 / 恢复 / 排队工作。要判断「不会再自动继续」用 **`agent_settled`**（`P/docs/sdk.md:92-94`，`extensions.md:66-67`）。
- **`dispose()` 必须调**：abort 活动工作、失效扩展上下文、断开事件监听（`P/docs/sdk.md:56`）。
- **runtime 替换后订阅失效**：`AgentSessionRuntime.newSession()/switchSession()/fork()/importFromJsonl()` 之后必须重新 `bindExtensions` + `subscribe`（`P/docs/sdk.md:60`）。
- **`createAgentSession` 不自动 `bindExtensions`**（`P/dist/core/sdk.js:303-327`）。虽然运行时验证显示 `hasExtensionHandlers("tool_call")` 在 `bindExtensions` **之前**就已经是 `true`（因为 runner 在构造时就读了 `resourceLoader.getExtensions()`），但 **UI 上下文确实要 `bindExtensions` 才装上**——`hasUI` 会是 `false`，`ctx.ui.confirm` 恒返回 `false`（`runner.js:132-134, 355-357, 404-406`）。**审批功能必须调 `bindExtensions`。**
- **skills 需要 `read` 或 `bash` 在工具集里**才会注入 system prompt（`system-prompt.js:102-108`）。
- **`tools` 里 `+name`/`-name` 不能与普通名字混用**，会 throw（`P/dist/core/sdk.d.ts:44-48`）。
- **同名工具的优先级（已核对代码，容易搞反）**：
  - 内置 < 扩展/SDK 工具。`definitionRegistry` 与 `toolRegistry` 都在内置之后被自定义工具 **覆盖**（`P/dist/core/agent-session.js:2831-2836`、`2860-2863`），所以注册名为 `bash` 的工具能替换内置 `bash`。
  - `allCustomTools = [...registeredTools, ...customTools]`（:2815-2820）→ **扩展工具优先于 `customTools`**。
  - 扩展**之间**才是 "first registration per name wins"（`P/dist/core/extensions/runner.js:410-420`）。
- **MCP 不支持 SSE**（`mcp.md:64`）。
- **`hasExtensionHandlers(eventType)`**（`AS:909`）可在装配后自检钩子是否挂上。
- **进程标记不自动设**：SDK 嵌入时 `AI_AGENT=pi` / `PI_CODING_AGENT=true` 不会自动设，需要自己设（`P/docs/environment-variables.md:18`）。
- **`PI_*` 会话变量**会注入 `bash`/`powershell` 工具的子进程：`PI_SESSION_ID`、`PI_SESSION_FILE`、`PI_PROVIDER`、`PI_MODEL`、`PI_REASONING_LEVEL`（`P/docs/environment-variables.md:24-32`）。可用 `createBashTool(cwd, { exposeSessionEnvironment: false })` 关闭（:66-71）。
- **`grep`/`find` 依赖 ripgrep/fd**：缺失会触发下载，见 9.2。
- **遥测默认开**：`enableInstallTelemetry` 默认 `true`（`P/docs/settings.md:167`）。内网/离线环境建议设 `enableInstallTelemetry: false` + `PI_TELEMETRY=0` + `PI_OFFLINE=1`。
- **`allowModelNetwork` 默认 `false`**（`model-runtime.d.ts:11-12`），所以 SDK 默认**不**联网刷模型目录；CLI 交互模式会（`interactive-mode.js` 里 `refreshModelCatalogs`）。
- **`maxRetries` / `retry.provider` 建议保持 `0`**：provider 级重试会拖延 Pi 自己处理配额/限流（`P/docs/settings.md:133`）。
- **不明确的点**（需运行时验证）：① `ModelRuntime.create({ credentials })` 传自定义 `CredentialStore` 能否完全避免创建 `auth.json`；② 用自定义 `ResourceLoader` 时 skills/projects 的用户级发现的精确边界；③ `session.dispose()` 后 `sessionFile` 是否被 finalize 写盘（`_hasConversation` 逻辑表明不写）。

### 9.7 我找到的示例代码文件路径（全部）

**SDK 示例（14 个 + README）** —— 最重要的参考，全部经过仓库类型检查（`P/docs/sdk.md:22`）：

```
P/examples/sdk/README.md              P/examples/sdk/08-prompt-templates.ts
P/examples/sdk/01-minimal.ts          P/examples/sdk/09-api-keys-and-oauth.ts
P/examples/sdk/02-custom-model.ts     P/examples/sdk/10-settings.ts
P/examples/sdk/03-custom-prompt.ts    P/examples/sdk/11-sessions.ts
P/examples/sdk/04-skills.ts           P/examples/sdk/12-full-control.ts
P/examples/sdk/05-tools.ts            P/examples/sdk/13-session-runtime.ts
P/examples/sdk/06-extensions.ts       P/examples/sdk/14-codemode-mcp.ts
P/examples/sdk/07-context-files.ts
```

**权限 / 安全相关**：
```
P/examples/extensions/permission-gate.ts       P/examples/extensions/confirm-destructive.ts
P/examples/extensions/protected-paths.ts       P/examples/extensions/project-trust.ts
P/examples/extensions/sandbox/index.ts         P/examples/extensions/tool-override.ts
P/examples/extensions/timed-confirm.ts
```

**工具 / 扩展 API**：
```
P/examples/extensions/hello.ts                 P/examples/extensions/tools.ts
P/examples/extensions/dynamic-tools.ts         P/examples/extensions/truncated-tool.ts
P/examples/extensions/structured-output.ts     P/examples/extensions/todo.ts
P/examples/extensions/subagent/                （完整多 agent 实现，含 agents/ 与 prompts/）
```

**Provider**：
```
P/examples/extensions/custom-provider-anthropic/index.ts     P/examples/extensions/custom-provider-gitlab-duo/index.ts
P/examples/extensions/custom-provider-gitlab-duo/test.ts    P/examples/extensions/provider-payload.ts
P/examples/extensions/debug-provider.ts                      P/examples/extensions/jev-router.ts
```

**进程间 / RPC（sidecar 分离进程时看这些）**：
```
P/examples/rpc-client.ts                       P/examples/rpc-extension-ui.ts
P/examples/extensions/rpc-demo.ts
```

**其它有用**：
```
P/examples/extensions/README.md                （扩展示例总索引，10KB）
P/examples/extensions/preset.ts                P/examples/extensions/minimal-mode.ts
P/examples/extensions/gondolin/index.ts        （远程执行 operations 注入的完整范例）
P/examples/extensions/subagent/index.ts        （35KB，最完整的扩展工程范例）
P/examples/plugins/pi-example-plugin/          （插件契约示例）
```

**权威类型定义文件**（写代码时对着看）：
```
P/dist/core/sdk.d.ts                     createAgentSession 的选项与返回值
P/dist/core/agent-session.d.ts           AgentSession 全部方法 + AgentSessionEvent
P/dist/core/agent-session-runtime.d.ts   多会话替换
P/dist/core/agent-session-services.d.ts  cwd-bound services
P/dist/core/model-runtime.d.ts           ModelRuntime / provider 注册
P/dist/core/provider-composer.d.ts       ProviderConfigInput / ProviderModelConfig
P/dist/core/extensions/types.d.ts        81KB，扩展 API / 事件 / ToolDefinition 全量
P/dist/core/tools/*.d.ts                 8 个内置工具的 schema 与 operations
P/dist/core/settings-manager.d.ts        Settings 全字段 + SettingsManager
P/dist/core/session-manager.d.ts         SessionManager + 会话条目类型
P/dist/core/skills.d.ts                  Skill / loadSkills / formatSkillsForPrompt
P/dist/core/resource-loader.d.ts         ResourceLoader / DefaultResourceLoaderOptions
P/dist/core/mcp-servers.d.ts             McpServerConfig
P/dist/extensions/mcp/{index,config}.d.ts MCP 扩展
P/dist/config.d.ts                       所有路径函数与 ENV 常量
P/dist/index.d.ts                        包根导出总表（判断「能不能 import」看这个）
AI/dist/types.d.ts                       AssistantMessageEvent / Usage / 消息类型
AI/dist/compat.d.ts                      （废弃的）getModel / streamSimple
AC/dist/types.d.ts                       AgentEvent / AgentToolResult / AgentTool
```

---

## 附录 A：装饰器式的「照抄」速查

| 我要… | 写 |
|---|---|
| 起一个会话 | `const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model })` |
| 只读模式 | `tools: ["read", "grep", "find", "ls"]` |
| 内网 OpenAI 端点 | `modelRuntime.registerProvider(id, { baseUrl, api: "openai-completions", apiKey, models: [...] })` |
| 列可用模型 | `await modelRuntime.getAvailable()` / `modelRuntime.getModels(providerId)` |
| 流式文本 | `session.subscribe(e => e.type==="message_update" && e.assistantMessageEvent.type==="text_delta" && out(e.assistantMessageEvent.delta))` |
| 思维链 | 同上，`"thinking_delta"` |
| 工具开始/结束 | `tool_execution_start` / `tool_execution_end` |
| 用量 | `message_end` → `event.message.usage`（assistant） |
| 真正结束 | `agent_settled` |
| 中断 | `await session.abort()` |
| 收尾 | `unsubscribe(); session.dispose()` |
| 审批拦截 | `pi.on("tool_call", async (e, ctx) => verdict==="deny" ? {block:true, reason} : undefined)` |
| 装 UI 上下文 | `await session.bindExtensions({ uiContext, mode: "rpc" })` **（必须）** |
| 自定义工具 | `defineTool({ name, label, description, parameters: Type.Object({...}), execute })` |
| 不落盘 | `SessionManager.inMemory(cwd)` + `SettingsManager.inMemory(...)` |
| 不污染 home | `process.env.PI_CODING_AGENT_DIR = <userData>/pi-agent` |
