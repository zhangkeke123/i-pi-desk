/**
 * 空状态的起手任务：**基于当前工作区的真实情况**，而不是写死的三条。
 *
 * ## 为什么值得单独做
 *
 * 参考材料里那句「空状态是功能唯一一次在第一次请求前设定期望的机会」，
 * 以及它的具体做法：起手任务要**用用户自己的上下文**。写死的「带我过一遍项目结构」
 * 在任何一个项目上都成立，也就等于什么都没说；而「跑一遍 pnpm test，把失败用例列出来」
 * 只有在这个目录里真的有 test 脚本时才出现 —— 它同时完成了两件事：
 * 告诉用户它能干什么，以及**它已经看过你的项目了**。
 *
 * ## 为什么是纯函数
 *
 * 规则的价值全在「什么时候给哪一条、为什么给」上，措辞也容易在改动中退化成万能句。
 * 这里只吃一个 `WorkspaceFacts`（主进程扫出来的事实）加工作区名，输出三条以内的建议，
 * 因此每一条规则都能被单测钉住（见 scripts/verify-ui-logic.ts）。
 */

import type { WorkspaceFacts } from '@i-pi-desk/shared'

export interface Starter {
  id: string
  /** 图标名（由界面映射到具体图标组件）。 */
  glyph: 'test' | 'structure' | 'todo' | 'readme' | 'git' | 'plan'
  /** 点击后填进输入框的文本。 */
  text: string
  /** 「为什么给你这条」——这也是「它看过你的项目」的证据。 */
  why: string
}

/** 最多给三条：给五条等于让用户重新做一次选择。 */
const MAX_STARTERS = 3

/** 没有工作区、或者什么都没扫到时用的通用三条（诚实降级，不编造）。 */
export const GENERIC_STARTERS: Starter[] = [
  {
    id: 'generic-structure',
    glyph: 'structure',
    text: '先带我过一遍这个项目的结构，指出入口文件',
    why: '还没读到项目信息，先给一条通用的'
  },
  {
    id: 'generic-todo',
    glyph: 'todo',
    text: '找出代码里所有 TODO，按文件归类',
    why: '通用建议'
  },
  {
    id: 'generic-plan',
    glyph: 'plan',
    text: '我想给这个项目加一个小功能，先跟我确认要改哪些文件',
    why: '通用建议'
  }
]

/** `pnpm test` / `npm run test` —— 让命令看起来像用户会自己敲的那条。 */
function commandFor(facts: WorkspaceFacts, script: string): string {
  const manager = facts.packageManager
  if (!manager) return `运行 ${script}`
  if (manager === 'npm') return `npm run ${script}`
  return `${manager} ${script}`
}

function pickTestStarter(facts: WorkspaceFacts): Starter | null {
  const testScript = facts.scripts.find((script) => script === 'test' || script.startsWith('test:'))
  if (testScript) {
    return {
      id: `test-${testScript}`,
      glyph: 'test',
      text: `跑一遍 ${commandFor(facts, testScript)}，把失败的用例和原因列出来`,
      why: `package.json 里有 ${testScript} 脚本`
    }
  }
  if (facts.testFiles > 0) {
    return {
      id: 'test-files',
      glyph: 'test',
      text: '跑一遍这个项目里的测试，把失败的用例和原因列出来',
      why: `扫到 ${facts.testFiles} 个测试文件`
    }
  }
  return null
}

function pickStructureStarter(facts: WorkspaceFacts): Starter | null {
  if (facts.sourceFiles === 0) return null
  const where = facts.srcDir ? `${facts.srcDir}/` : '项目'
  return {
    id: 'structure',
    glyph: 'structure',
    text: `带我过一遍 ${where} 的结构，指出入口文件`,
    why: facts.truncated
      ? `扫到 ${facts.sourceFiles} 个源文件（目录较大，只扫了一部分）`
      : `扫到 ${facts.sourceFiles} 个源文件`
  }
}

function pickTodoStarter(facts: WorkspaceFacts): Starter | null {
  if (facts.todoCount === 0) return null
  return {
    id: 'todo',
    glyph: 'todo',
    text: '找出代码里所有 TODO，按文件归类',
    // 「只统计了部分文件」这句话只有**真的**只读了一部分时才说。
    why: facts.todoPartial
      ? `扫到 ${facts.todoCount} 处 TODO / FIXME（只统计了部分文件）`
      : `扫到 ${facts.todoCount} 处 TODO / FIXME`
  }
}

function pickReadmeStarter(facts: WorkspaceFacts): Starter | null {
  if (!facts.hasReadme) return null
  return {
    id: 'readme',
    glyph: 'readme',
    text: '读一遍 README，用三句话说明这个项目是做什么的',
    why: '目录里有 README'
  }
}

function pickGitStarter(facts: WorkspaceFacts): Starter | null {
  if (!facts.hasGit) return null
  return {
    id: 'git',
    glyph: 'git',
    text: '看一下最近的提交在改什么，帮我理出主线',
    why: '这是一个 git 仓库'
  }
}

/**
 * 生成起手任务。
 *
 * 顺序有意固定（先跑得起来的、再看结构、再看待办、最后看文档与历史）：
 * 用户第一次用最想要的是「它现在就能替我干点什么」，而不是先读一份项目说明。
 *
 * 扫不到任何事实时返回通用三条：**宁可通用，也不编造** ——
 * 一条假的「检测到 12 个测试文件」比没有建议更伤信任。
 */
export function buildStarters(facts: WorkspaceFacts | null | undefined): Starter[] {
  if (!facts) return GENERIC_STARTERS

  const candidates = [
    pickTestStarter(facts),
    pickStructureStarter(facts),
    pickTodoStarter(facts),
    pickReadmeStarter(facts),
    pickGitStarter(facts)
  ].filter((starter): starter is Starter => starter !== null)

  if (candidates.length === 0) return GENERIC_STARTERS
  return candidates.slice(0, MAX_STARTERS)
}

/**
 * 空状态的第一句话。
 *
 * 用工作区名打招呼（上游 PI-Desktop 的做法）：一句话就说清「这是你的项目」，
 * 比任何「本地优先的 AI 编程工作台」都更像在跟人说话。
 */
export function emptyStateTitle(workspaceName: string | undefined): string {
  return workspaceName ? `今天想在 ${workspaceName} 里做点什么？` : '今天想做点什么？'
}
