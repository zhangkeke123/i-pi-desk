# 第三方声明

> 这份文件存在的原因很具体：**本项目的打包产物里包含了第三方的 MIT 代码**
> （agent 内核随应用一起分发），而 MIT 许可要求随分发保留版权声明与许可文本。
> 它同时被 `verify:packaging` / `verify:packaged` 盯着 —— 声明缺了，验证会红。

---

## 1. agent 内核：`@earendil-works/pi-*`（MIT）

本项目把下面三个包作为 **agent 内核**使用，并以 `extraResources` 的形式
（`resources/THIRD-PARTY.md` 与 `resources/agent-host/`）随应用一起分发：

| 包 | 版本 | 许可 |
|---|---|---|
| `@earendil-works/pi-ai` | 1.1.0 | MIT |
| `@earendil-works/pi-agent-core` | 1.1.0 | MIT |
| `@earendil-works/pi-coding-agent` | 1.1.0 | MIT |

- 上游仓库：<https://github.com/earendil-works/pi>
- 作者与版权持有人：Mario Zechner
- 说明：这三个包的 `package.json` 声明了 `"license": "MIT"`，但**发布的 tarball 里没有
  LICENSE 文件**。因此下面的许可原文取自上游仓库的 `LICENSE`
  （<https://github.com/earendil-works/pi/blob/main/LICENSE>，取用日期 2026-10-11）。

```text
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. 界面字体：Geist / JetBrains Mono（SIL OFL-1.1）

界面字体**随应用分发**（不再是「机器上碰巧有就用」），因此这里附上版权与许可。
两者都是 SIL Open Font License 1.1 —— 该许可允许把字体嵌入并随应用一起分发，
要求附版权声明与许可文本（即本节），且**不得**在修改后的版本上继续使用其保留字体名
（本项目未修改字体文件）。

| 包 | 版本 | 许可 | 版权 |
|---|---|---|---|
| `@fontsource-variable/inter` | 5.3.0 | OFL-1.1 | Copyright 2016 The Geist Project Authors |
| `@fontsource-variable/jetbrains-mono` | 5.3.0 | OFL-1.1 | Copyright 2020 The JetBrains Mono Project Authors |

- Geist 上游：<https://github.com/rsms/inter>
- JetBrains Mono 上游：<https://github.com/JetBrains/JetBrainsMono>
- OFL 全文：<https://openfontlicense.org/open-font-license-official-text/>（也可在
  上面两个 npm 包的 `LICENSE` 文件里读到完整文本，随构建产物一并分发）

> 中文**没有打包**：一个可用的中文字体是 10 MB 量级，收益与体积不成比例。
> 中文继续走系统字体栈（见 `apps/desktop/src/styles.css` 顶部的说明）。

---

## 3. 架构参考：`vastsa/PI-Desktop`（LGPL-3.0-or-later）—— **未使用其源码**

本项目的**形态**参考了这个上游项目（它是 LGPL-3.0-or-later，且没有 linking 例外），
但**没有复制它的任何源码**：

- 它不在任何 `package.json` 的依赖里，也不在 `pnpm-lock.yaml` 里；
- 仓库里没有它的 Rust 宿主（无 `Cargo.toml`、无 `*.rs`）—— 上游最重的部分我们没有引入；
- 提到它的地方只有**文档与注释**（说明「为什么自己做」「与上游的差异」「哪些设计刻意不跟」），
  以及 `apps/desktop/src/features/workspace/WorkspacePanel.tsx` 里的一段**设计缘由注释**。

这一点由 `verify:kernel-deps` 逐条断言（依赖、锁文件、Rust 痕迹、THIRD-PARTY 的存在与内容）。

上游仓库：<https://github.com/vastsa/PI-Desktop>

---

## 4. 其余依赖：**没有做完整的法律审查**

应用与渲染层还打包了 React、CodeMirror、xterm.js、node-pty、Electron 等一大批依赖
（多为 MIT / Apache-2.0 / BSD）。**本项目没有做逐包的许可审查与完整清单**，
这是刻意的范围决定（个人 / 小范围自用，不对外分发）。

需要完整清单时，pnpm 自带命令即可：

```bash
pnpm licenses list            # 全部依赖的许可
pnpm licenses list --prod     # 只看运行时依赖
```

> 如果这个项目将来要对外分发，第 4 节必须先补成完整清单，
> 并把这份文件一起打进产物（第 1 节的做法已经就位）。
