import { useEffect, useRef } from 'react'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
  foldGutter,
  StreamLanguage,
  StringStream
} from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { tags as t } from '@lezer/highlight'

/**
 * 代码编辑器（CodeMirror 6）。
 *
 * ## 为什么之前是 textarea，现在才换
 *
 * 第一版刻意用带行号的 `<textarea>` —— 它能满足「**能改**」这个刚需，
 * 而且零依赖。但自用一段时间后，缺高亮成了最明显的摩擦：读代码时
 * 关键字、字符串、注释全是一个颜色，扫一眼分不清结构。
 *
 * 现在引进 CM6 是因为它把「能改」升级成「改得舒服」：
 * 高亮、括号匹配、自动缩进、撤销历史、搜索、代码折叠。
 *
 * ## 一个刻意不做的决定：**不引入动态 import 分语言**
 *
 * 语言包按需动态加载能省下首屏体积，但 Vite 会把它切成独立的 chunk，
 * 而打包后的 Electron 从 `file://` 加载这些 chunk —— **这类问题只在打包后才出现**
 * （开发时 `http://localhost` 一切正常）。当前 `verify:packaged` 不打开编辑器，
 * 覆盖不到它。
 *
 * 在桌面应用里为几百 KB 引入一类只在发布时暴露的风险，不划算。
 * 所以全部语言包**静态引入**：体积换确定性。
 */

/**
 * 按扩展名**异步**加载语言包。
 *
 * ## 为什么改成动态 import
 *
 * 静态引入时渲染层主 chunk 是 2.79 MB，其中绝大部分是各语言的 Lezer 语法包 ——
 * 而一次编辑只会用到其中一种。桌面应用虽然从本地磁盘读，但**主 chunk 必须在首帧前
 * 解析完**，白白拖慢启动。
 *
 * 切成动态 import 后，语言包变成独立 chunk，只在真正打开对应文件时才去取。
 *
 * ## 之前刻意不做，现在为什么敢做
 *
 * 第一版拒绝动态 import 的理由是：Vite 会切出独立 chunk，而打包后的 Electron 从
 * `file://` 加载它们 —— **这类问题只在发布时暴露**，当时 `verify:packaged` 也覆盖不到。
 *
 * 现在两件事都成立了：渲染层产物用的是相对路径（`./assets/...`，见 electron-vite 的
 * `base` 默认值），而 `verify:packaged` 会真的在生产档下打开编辑器并断言高亮生效 ——
 * **那条断言现在顺带证明了动态 chunk 能从 `file://` 加载成功**。
 * 也就是说：先有验证能力，再有优化。
 *
 * ## 加载期间的显示
 *
 * 语言未就绪时编辑器**照常可用**（纯文本）。高亮在 chunk 到位后补上，
 * 不会阻塞打开文件 —— 对一个本地编辑器来说这是正确的优先级。
 */
type LanguageLoader = () => Promise<Extension[]>

const LANGUAGE_LOADERS: Record<string, LanguageLoader> = {
  ts: () => import('@codemirror/lang-javascript').then((m) => [m.javascript({ typescript: true })]),
  tsx: () =>
    import('@codemirror/lang-javascript').then((m) => [m.javascript({ typescript: true, jsx: true })]),
  js: () => import('@codemirror/lang-javascript').then((m) => [m.javascript({ jsx: true })]),
  mjs: () => import('@codemirror/lang-javascript').then((m) => [m.javascript({ jsx: true })]),
  cjs: () => import('@codemirror/lang-javascript').then((m) => [m.javascript({ jsx: true })]),
  json: () => import('@codemirror/lang-json').then((m) => [m.json()]),
  jsonc: () => import('@codemirror/lang-json').then((m) => [m.json()]),
  md: () => import('@codemirror/lang-markdown').then((m) => [m.markdown()]),
  markdown: () => import('@codemirror/lang-markdown').then((m) => [m.markdown()]),
  css: () => import('@codemirror/lang-css').then((m) => [m.css()]),
  html: () => import('@codemirror/lang-html').then((m) => [m.html()]),
  htm: () => import('@codemirror/lang-html').then((m) => [m.html()]),
  vue: () => import('@codemirror/lang-html').then((m) => [m.html()]),
  py: () => import('@codemirror/lang-python').then((m) => [m.python()]),
  java: () => import('@codemirror/lang-java').then((m) => [m.java()])
}

/** shell 的高亮是我们自己写的（见下），不占 chunk。 */
const SHELL_EXTENSIONS = (): Extension[] => [StreamLanguage.define(shellLike)]

/**
 * 取某个文件的语言扩展。
 *
 * 认不出扩展名、或语言包加载失败时**返回空数组**（纯文本）而不是抛错：
 * 高亮只是锦上添花，不该因为一个没见过的后缀或一次 chunk 加载失败就让文件打不开。
 */
async function loadLanguage(filePath: string): Promise<Extension[]> {
  const ext = filePath.toLowerCase().split('.').pop() ?? ''
  if (ext === 'sh' || ext === 'bash' || ext === 'zsh') return SHELL_EXTENSIONS()
  const loader = LANGUAGE_LOADERS[ext]
  if (!loader) return []
  try {
    return await loader()
  } catch {
    return []
  }
}

/** 语言扩展的插槽：加载完成后原地替换，不重建编辑器（否则会丢光标与撤销历史）。 */
const languageSlot = new Compartment()

/**
 * Shell 的极简高亮。
 *
 * 只为「注释 / 字符串 / 变量 / 命令名」几类上色 —— 完整语法需要 Lezer 语法包，
 * 而 shell 脚本在我们场景里主要是读一眼，不值得再加一个依赖。
 * 宁可少上色，也不要上错色。
 */
interface ShellState {
  inString: boolean
  inComment: boolean
}

const shellLike = {
  name: 'shell-like',
  startState: (): ShellState => ({ inString: false, inComment: false }),
  token(stream: StringStream, state: ShellState): string | null {
    if (state.inComment) {
      stream.skipToEnd()
      state.inComment = false
      return 'comment'
    }
    if (state.inString) {
      // 找到配对的引号就退出字符串态；找不到说明字符串还没结束（跨行）。
      if (stream.match(/^[^'"]*['"]/)) state.inString = false
      else stream.skipToEnd()
      return 'string'
    }
    if (stream.sol() && stream.match(/^\s*#/)) {
      stream.skipToEnd()
      return 'comment'
    }
    if (stream.match(/^['"]/)) {
      state.inString = true
      return 'string'
    }
    if (stream.match(/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/)) return 'variableName'
    // 行首的词多半是命令名，用 keyword 色把它和后面的参数区分开。
    if (stream.sol() && stream.match(/^[A-Za-z_][A-Za-z0-9_.-]*/)) return 'keyword'
    stream.next()
    return null
  }
}

/** 颜色全部走 CSS 变量，这样切主题时编辑器跟着变，不用重建。 */
const editorTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    color: 'var(--color-ink)',
    fontSize: '12px',
    height: '100%'
  },
  '.cm-content': {
    fontFamily: 'var(--font-mono)',
    padding: '8px 0',
    caretColor: 'var(--color-accent)'
  },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--color-muted)',
    border: 'none',
    borderRight: '1px solid var(--color-border)'
  },
  '.cm-activeLine': { backgroundColor: 'var(--color-surface-2)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--color-ink)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--color-accent-soft)'
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-accent)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--color-accent-soft)',
    outline: '1px solid var(--color-accent)'
  },
  '.cm-panels': { backgroundColor: 'var(--color-surface)', color: 'var(--color-ink)' },
  '.cm-searchMatch': { backgroundColor: 'var(--color-accent-soft)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--color-surface-2)', border: 'none', color: 'var(--color-muted)' }
})

const highlightStyle = HighlightStyle.define([
  { tag: t.comment, color: 'var(--color-syn-comment)', fontStyle: 'italic' },
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: 'var(--color-syn-keyword)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--color-syn-string)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--color-syn-number)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--color-syn-function)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--color-syn-type)' },
  { tag: [t.operator, t.punctuation, t.separator], color: 'var(--color-syn-operator)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--color-syn-property)' },
  { tag: [t.variableName, t.definition(t.variableName)], color: 'var(--color-ink)' },
  { tag: t.invalid, color: 'var(--color-syn-invalid)' },
  { tag: [t.heading, t.strong], color: 'var(--color-ink)', fontWeight: '600' },
  { tag: [t.link, t.url], color: 'var(--color-accent)', textDecoration: 'underline' },
  { tag: t.emphasis, fontStyle: 'italic' }
])

export interface CodeEditorProps {
  value: string
  /** 用于选语言的文件路径（相对路径即可，只看扩展名）。 */
  path: string
  readOnly?: boolean
  onChange?: (value: string) => void
  className?: string
}

/**
 * 组件**刻意不绑定 Ctrl/Cmd+S**。
 *
 * 快捷键只能有一个来源。如果这里绑一次、宿主（对话框的 window 监听）再绑一次，
 * 一次按键就会触发两次保存：第二次带着已经过期的 `expectedRevision`，
 * 必然被服务端式的校验拒绝，用户看到的是一个莫名其妙的「文件已被外部修改」。
 *
 * 而把快捷键放在宿主还有一个实际好处：**焦点不在编辑器里时也要能用**
 * （点过标题栏、或刚切换只读状态之后）。所以由宿主统一处理，这里只管编辑。
 */
export function CodeEditor({
  value,
  path,
  readOnly = false,
  onChange,
  className
}: CodeEditorProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)

  /**
   * 回调放进 ref。
   *
   * 编辑器是命令式的（CM6 自己管 state），如果把它写进 effect 依赖，
   * 每次 `onChange` 变化都会重建整个编辑器 —— 光标位置、撤销历史全丢。
   * 用 ref 存最新回调，effect 就只依赖真正需要重建的东西。
   */
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined

    const extensions: Extension[] = [
      // 行号、折叠、搜索、括号匹配、自动缩进、补全、撤销历史。
      // 不用 `basicSetup`：它把默认高亮与主题也带进来了，会和我们的主题打架。
      EditorView.lineWrapping,
      history(),
      foldGutter(),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      indentOnInput(),
      highlightSelectionMatches(),
      syntaxHighlighting(highlightStyle, { fallback: true }),
      editorTheme,
      keymap.of([
        ...closeBracketsKeymap,
        ...completionKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...defaultKeymap,
        indentWithTab
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChangeRef.current?.(update.state.doc.toString())
      }),
      // 语言槽先放空：加载完成后原地 reconfigure，不重建编辑器。
      languageSlot.of([])
    ]

    if (readOnly) {
      extensions.push(EditorState.readOnly.of(true), EditorView.editable.of(false))
    }

    const view = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: host
    })
    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // 只在文件切换 / 只读状态变化时重建。内容同步走下面那个 effect。
  }, [path, readOnly])

  /**
   * 外部内容变化时同步进编辑器。
   *
   * 必须判断「当前文档是否已经等于新值」再决定要不要 dispatch：
   * 用户打字时 onChange 会把值传出去、父组件再传回来，无脑 dispatch
   * 会导致光标每输入一个字符就跳到开头。
   */
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value }
    })
  }, [value])

  /**
   * 异步装载语言包。
   *
   * 两个必须处理的时序问题：
   *  - 编辑器可能在 chunk 到位前就被销毁（用户很快关掉对话框）→ 用 `cancelled` 挡住，
   *    否则会对一个已经 destroy 的 view 派发事务；
   *  - `path` 可能在中途变化（用户又打开了另一个文件）→ 同样靠 `cancelled` 挡住旧结果，
   *    否则会给新文件套上旧语言的高亮。
   */
  useEffect(() => {
    let cancelled = false
    void loadLanguage(path).then((extensions) => {
      if (cancelled) return
      const view = viewRef.current
      if (!view) return
      view.dispatch({ effects: languageSlot.reconfigure(extensions) })
    })
    return () => {
      cancelled = true
    }
  }, [path])

  return <div ref={hostRef} className={className} />
}
