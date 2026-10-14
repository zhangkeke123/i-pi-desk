# i-pi-desk — Agent 开发约定

> 这是**给 coding agent 的入口**。详细的操作交接在 [`docs/AGENT-HANDOFF.md`](./docs/AGENT-HANDOFF.md)；
> 给人看的交付说明在 [`docs/HANDOVER.md`](./docs/HANDOVER.md)；架构权威是 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)。

## 先读这三份（按顺序，十分钟）

1. `docs/AGENT-HANDOFF.md` **§1–§3**：环境与命令、三条不变式、十条约定。
2. `docs/ARCHITECTURE.md` 里**与你改动相关的那一节**（它是唯一权威，`§15.x` 是最近的迭代记录）。
3. `docs/HANDOVER.md` **§7** 的坑表：几十条踩过的坑，扫一眼再动手。

## 三条不变式（各有守卫，别破坏）

1. **渲染层永远不碰文件系统** —— 所有 IO 走 preload API → 主进程。
2. **主进程永远不跑 agent** —— 内核只在 sidecar 里；主进程是编排者与数据 owner。
3. **`pi-*` 只能出现在 `packages/agent-host`** —— 别处 import 会被 `verify:kernel-deps` 拦下。

## 改完必须走完（细则见 AGENT-HANDOFF §7）

```bash
pnpm typecheck && pnpm test          # 端到端用 esbuild，不做类型检查，别只信它
pnpm verify                          # 全量链：26 段，共 1449 条断言
node tools/reconcile-counts.mjs <日志>   # 断言计数对账，必须 ALL_PASS
pnpm --filter @i-pi-desk/desktop run dist   # 动了界面/打包才需要
```

- **每个改动都要有断言**；逻辑进桌面单测，能自动的进 `verify:renderer`。
- **每个新守卫都要 A/B**（故意弄坏一次、确认它真的红），且破坏方式必须**构建安全**。
- 断言要防盲区：问自己「什么情况下它会恒真/恒假」（两个真实例子见 AGENT-HANDOFF §3.3）。
- 计数是数出来的：改了断言数就同步 `README.md` 与 `ARCHITECTURE.md` §15.10。
- 视觉改动**必须真的看一眼**（断言证明「没坏」，看不出「丑」）。
- 端到端的**段落位置就是状态契约**；UI 里新增可点元素要避开「扫所有 button」的段落。

## 边界

- **不要 commit / push**（用户没说就不要推远程；这个目录当前也是未跟踪状态）。
- **上游 `vastsa/PI-Desktop` 只做架构与交互参照，零复制**（有守卫）。
- 两处**如实记录的覆盖缺口**、以及**刻意不做的事**：见 AGENT-HANDOFF §8。
- 假模型控制面默认 **8124** 端口；跑自测前确认没有遗留进程占着（自测里有守卫会直接报错）。
