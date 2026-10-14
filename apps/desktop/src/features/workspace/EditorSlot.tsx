import { Suspense, lazy } from 'react'
import { ChunkBoundary, ChunkLoading } from '../../lib/chunk-boundary.js'
import type { CodeEditorProps } from './CodeEditor.js'

/**
 * 按需加载的代码编辑器。
 *
 * ## 为什么要拆
 *
 * CodeMirror 的内核（state / view / commands / search / autocomplete / language）
 * 是渲染层最重的一块依赖，而**它只在用户真的打开一个文件时才需要**。
 * 放进主 chunk 意味着每次启动都要解析、编译这部分代码 —— 用户为此付出的
 * 是「点开应用后要多等一会儿」，而多数会话里他根本不看文件。
 *
 * 语言包此前已经拆成按需加载了（见 CodeEditor 里的 `loadLanguage`），
 * 这里拆的是内核本身。
 *
 * ## 加载态与失败处理
 *
 * 拆包引入的新失败模式（chunk 取不到 → lazy reject → 整棵树被卸载）
 * 由 `ChunkBoundary` 兜住；加载态由 `ChunkLoading` 给出。
 * 两者与终端面板共用（见 `lib/chunk-boundary.tsx`）——
 * 这类「机制」重复到第三份就该抽出来了。
 */
const LazyCodeEditor = lazy(async () => {
  const module = await import('./CodeEditor.js')
  return { default: module.CodeEditor }
})

export function EditorSlot(props: CodeEditorProps): React.ReactElement {
  return (
    <ChunkBoundary what="编辑器" bytesHint="文件内容本身没有被动过，重新加载界面即可恢复。">
      <Suspense fallback={<ChunkLoading label="编辑器" />}>
        <LazyCodeEditor {...props} />
      </Suspense>
    </ChunkBoundary>
  )
}
