import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  ChevronRight,
  FilePlus,
  FileText,
  FolderInput,
  Folder,
  FolderOpen,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  X
} from 'lucide-react'
import type { FilePreview, FsEntry } from '@i-pi-desk/shared'
import { useAppStore } from '../../stores/app-store.js'
import { call, getDesk, IpcError } from '../../lib/desk.js'
import { EditorSlot } from './EditorSlot.js'

/**
 * 工作区文件面板。
 *
 * 上游 PI-Desktop 至今没有内置编辑器（刻意不引 Monaco）。文件树 + 预览是投入产出比最高的一步：
 * 它让「agent 改了哪个文件」这件事从「靠猜」变成「点开看」，而且不需要引入编辑器组件。
 *
 * 文件系统状态刻意留在**组件本地**而不是全局 store：
 * 它是纯视图状态（展开了哪些目录、正在看哪个文件），没有跨组件共享的需求，
 * 塞进全局 store 只会让 store 变胖、并给「多处同时改」留下隐患。
 */

export function WorkspacePanel({
  onClose,
  /** 嵌进右侧检查器时去掉重复的外壳头（tab 栏已经表达「文件」）。 */
  embedded = false
}: {
  onClose: () => void
  embedded?: boolean
}): React.ReactElement {
  const workspace = useAppStore((s) => s.currentWorkspace)

  /** 已加载的目录内容：path → entries。未展开的目录不在这个表里。 */
  const [dirs, setDirs] = useState<Record<string, FsEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<FilePreview | null>(null)

  const loadDir = useCallback(
    async (path: string) => {
      if (!workspace) return
      setLoading((prev) => new Set(prev).add(path))
      setError(null)
      try {
        const entries = await call(getDesk().fs.list(workspace.id, path))
        setDirs((prev) => ({ ...prev, [path]: entries }))
      } catch (err) {
        setError(err instanceof IpcError ? err.message : String(err))
      } finally {
        setLoading((prev) => {
          const next = new Set(prev)
          next.delete(path)
          return next
        })
      }
    },
    [workspace]
  )

  /**
   * 编辑器里有没有未保存的改动。
   *
   * 放在 store 里（见 `app-store.ts` 的说明）：切文件、切工作区、关窗口**三处**
   * 都要按它做决定，各自执一份必然会漂移 ——
   * 上一轮「同一件事四个入口三种行为」就是这么来的。
   */
  const editorDirty = useAppStore((s) => s.editorDirty)
  const setEditorDirty = useAppStore((s) => s.setEditorDirty)

  // 换工作区就把整棵树重置：沿用旧目录内容会导致「展开了的路径在新工作区里不存在」。
  useEffect(() => {
    setDirs({})
    setExpanded(new Set())
    setPreview(null)
    setError(null)
    /**
     * 预览被重置了，脏标记必须跟着归零 ——
     * 否则那个标记会一直挂着，导致**关窗口永远弹「有未保存的改动」**。
     * （切换工作区本身的确认在侧栏做，见 Sidebar 的 `pendingWorkspace`。）
     */
    setEditorDirty(false)
    if (workspace) void loadDir('')
  }, [workspace?.id, loadDir, workspace, setEditorDirty])

  const toggle = (entry: FsEntry): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(entry.path)) next.delete(entry.path)
      else {
        next.add(entry.path)
        // 首次展开才去拉内容；已加载过的目录直接复用，避免反复打 IPC。
        if (!dirs[entry.path]) void loadDir(entry.path)
      }
      return next
    })
  }

  /**
   * 编辑器里有没有未保存的改动。
   *
   * 放在 store 里（见 `app-store.ts` 的说明）：切文件、切工作区、关窗口**三处**
   * 都要按它做决定，各自执一份必然会漂移 ——
   * 上一轮「同一件事四个入口三种行为」就是这么来的。
   *
   * 这两个值在最上面（第 70 行附近）就读了：下面那个重置预览的 effect 要用到
   * `setEditorDirty`，放在后面会踩到「块级变量在声明前使用」。
   */
  const [pendingOpen, setPendingOpen] = useState<FsEntry | null>(null)

  /**
   * 用来强制重挂载预览弹窗的令牌。
   *
   * 为什么不是 `key={preview.path}`：那会在**路径改写**（改名 / 移动）时也重挂载，
   * 把用户正在编辑的内容一并重置掉。这里改成「只有在用户主动打开**另一个**文件时才 +1」，
   * 于是「换文件要重置状态」与「换路径不该丢编辑内容」两件事各归其位。
   */
  const [openToken, setOpenToken] = useState(0)

  const openFile = async (entry: FsEntry): Promise<void> => {
    if (!workspace) return
    // 已经开着同一个文件：不重挂载，也不丢掉正在编辑的内容。
    if (preview?.path === entry.path) return
    if (editorDirty && preview?.path !== entry.path) {
      setPendingOpen(entry)
      return
    }
    try {
      setOpenToken((token) => token + 1)
      setPreview(await call(getDesk().fs.read(workspace.id, entry.path)))
    } catch (err) {
      setError(err instanceof IpcError ? err.message : String(err))
    }
  }

  /** 确认放弃改动：关掉当前文件，再打开用户点的那个。 */
  const confirmDiscardAndOpen = async (entry: FsEntry): Promise<void> => {
    setPendingOpen(null)
    setEditorDirty(false)
    setPreview(null)
    if (workspace) {
      try {
        setOpenToken((token) => token + 1)
        setPreview(await call(getDesk().fs.read(workspace.id, entry.path)))
      } catch (err) {
        setError(err instanceof IpcError ? err.message : String(err))
      }
    }
  }

  const refresh = (): void => {
    setDirs({})
    setExpanded(new Set())
    void loadDir('')
  }

  // ───────────────────────────── 新建 / 重命名 / 删除 ─────────────────────────────

  /** 正在新建文件的目录路径（与正在重命名的条目互斥）。 */
  const [creating, setCreating] = useState<{ dirPath: string; name: string } | null>(null)
  const [editing, setEditing] = useState<{ path: string; name: string } | null>(null)
  /** 待确认删除的路径。删除是不可逆的（进回收站也是），所以要二次确认。 */
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)

  const parentOf = (path: string): string => {
    const index = path.lastIndexOf('/')
    return index === -1 ? '' : path.slice(0, index)
  }

  const startCreate = (dirPath: string): void => {
    setEditing(null)
    setConfirmRemove(null)
    setCreating({ dirPath, name: '' })
    // 展开目标目录并确保内容已加载 —— 否则输入框渲染在一个没有子节点的目录里，看不见。
    if (dirPath) {
      setExpanded((prev) => new Set(prev).add(dirPath))
      if (!dirs[dirPath]) void loadDir(dirPath)
    }
  }

  const commitCreate = async (): Promise<void> => {
    const draft = creating
    if (!workspace || !draft) return
    const name = draft.name.trim()
    if (name.length === 0) {
      setCreating(null)
      return
    }
    const target = draft.dirPath ? `${draft.dirPath}/${name}` : name
    try {
      await call(getDesk().fs.create({ workspaceId: workspace.id, path: target }))
      setCreating(null)
      setError(null)
      await loadDir(draft.dirPath)
      // 建完直接打开：新建文件的下一步几乎一定是写点东西。
      await openFile({ path: target } as FsEntry)
    } catch (err) {
      // 失败时**留在输入态**：收起输入框会让人以为建成功了。
      setError(err instanceof IpcError ? err.message : String(err))
    }
  }

  /**
   * 把预览里指向 `from`（或它下面某个文件）的路径改写成 `to` 下的新路径。
   *
   * ## 为什么是「改写」而不是「关掉」
   *
   * 原来三个操作（改名 / 移动 / 删除）都只按**精确相等**判断，于是
   * **重命名一个目录**（里面正开着文件）会留下一个指向不存在路径的编辑器：
   * 标题还写着旧路径、按保存报 `NOT_FOUND`。用户只能把内容复制出来再关掉。
   *
   * 而改名/移动**不改变 mtime 与 size**（实测确认），也就是说
   * `revision`（`mtime:size`）在新路径上依然有效 —— 所以完全可以**接着编辑并保存成功**。
   * 这比「关掉并让用户重来」好得多，也不会丢掉未保存的内容。
   */
  const remapPreview = (from: string, to: string): void => {
    setPreview((prev) => {
      if (!prev) return prev
      if (prev.path === from) return { ...prev, path: to }
      if (prev.path.startsWith(`${from}/`)) return { ...prev, path: `${to}${prev.path.slice(from.length)}` }
      return prev
    })
  }

  /** 预览里的文件是否就在这个路径之下（含它本身）。 */
  const previewInside = (path: string): boolean =>
    preview !== null && (preview.path === path || preview.path.startsWith(`${path}/`))

  const commitRename = async (): Promise<void> => {
    const draft = editing
    if (!workspace || !draft) return
    const name = draft.name.trim()
    const currentName = draft.path.split('/').pop() ?? ''
    if (name.length === 0 || name === currentName) {
      setEditing(null)
      return
    }
    try {
      const result = await call(getDesk().fs.rename({ workspaceId: workspace.id, path: draft.path, newName: name }))
      setEditing(null)
      setError(null)
      // 改名后路径变了：把预览里的路径跟着改写，而不是关掉它。
      remapPreview(draft.path, result.path)
      await loadDir(parentOf(draft.path))
    } catch (err) {
      setError(err instanceof IpcError ? err.message : String(err))
    }
  }

  const commitRemove = async (path: string): Promise<void> => {
    if (!workspace) return
    try {
      await call(getDesk().fs.remove({ workspaceId: workspace.id, path }))
      setConfirmRemove(null)
      setError(null)
      // 删掉的是真没了：预览里如果是它（或它下面的文件），只能关掉。
      if (previewInside(path)) setPreview(null)
      // 被删的可能是目录：它的子目录缓存也要清掉，否则下次展开会看到已删除的内容。
      setDirs((prev) => {
        const next: Record<string, FsEntry[]> = {}
        for (const [key, value] of Object.entries(prev)) {
          if (key === path || key.startsWith(`${path}/`)) continue
          next[key] = value
        }
        return next
      })
      await loadDir(parentOf(path))
    } catch (err) {
      setError(err instanceof IpcError ? err.message : String(err))
    }
  }

  /**
   * 移动：一个「可点可按的目录选择器」，而不是拖拽。
   *
   * 拖拽在 Electron + CDP 下很难可靠地验证（合成 drag 事件与真实指针行为差异很大），
   * 而这里每一条都要能自动验 —— 一个验不了的破坏性操作不值得做。
   *
   * 选择器只列**目录**（移动的目标只能是目录），并允许一路往上级走。
   */
  const [moveSource, setMoveSource] = useState<FsEntry | null>(null)
  const [moveDir, setMoveDir] = useState('')
  const [moveEntries, setMoveEntries] = useState<FsEntry[]>([])

  const openMovePicker = (entry: FsEntry): void => {
    setCreating(null)
    setEditing(null)
    setConfirmRemove(null)
    setMoveSource(entry)
    // 默认从**它当前所在的目录**开始：多数移动是「挪到隔壁」。
    setMoveDir(parentOf(entry.path))
  }

  // 选择器打开的期间，每次切换目录都实时列一次（复用同一个 fs.list）。
  useEffect(() => {
    if (!moveSource || !workspace) return
    let cancelled = false
    void call(getDesk().fs.list(workspace.id, moveDir))
      .then((entries) => {
        if (!cancelled) setMoveEntries(entries.filter((item) => item.kind === 'directory'))
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof IpcError ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [moveSource, moveDir, workspace])

  const commitMove = async (): Promise<void> => {
    const source = moveSource
    if (!workspace || !source) return
    try {
      const result = await call(
        getDesk().fs.move({ workspaceId: workspace.id, path: source.path, targetDir: moveDir })
      )
      setMoveSource(null)
      setError(null)
      // 两边的目录缓存都要清掉：源位置少了一项、目标位置多了一项。
      setDirs((prev) => {
        const next = { ...prev }
        delete next[parentOf(source.path)]
        delete next[moveDir]
        return next
      })
      // 文件（或整个目录）换了位置：预览里的路径跟着改写，用户可以接着编辑与保存。
      remapPreview(source.path, result.path)
      /**
       * ⚠️ **两个受影响的目录都要重新加载。**
       *
       * 这里原先只删缓存、不重新加载 —— 于是**移动一个文件之后整棵文件树会变空**，
       * 而且不会自己恢复（要手动点「刷新」）。原因是 `delete` 掉的正是当前渲染用的
       * 那两个 key，删完就没人再去拉了。
       *
       * 为什么当初没被测出来：那条断言写的是「根目录下不再显示它」——
       * 而**树整个空了的时候，这句话恒真**。断言写成「X 不在了」时，
       * 一个把所有东西都弄没的 bug 反而会通过。（现在那一段也补了「树不是空的」与
       * 「在目标目录里找得到它」两条正向断言。）
       */
      await loadDir(parentOf(source.path))
      await loadDir(moveDir)
    } catch (err) {
      // 失败时**留在选择器里**：收起它会让人以为移成功了（与新建的处理一致）。
      setError(err instanceof IpcError ? err.message : String(err))
    }
  }

  /** 传给树节点的全部操作，打包成一个对象免得透传十几个 prop。 */
  const actions: TreeActions = {
    creating,
    editing,
    confirmRemove,
    onStartCreate: startCreate,
    onCreateDraft: (name) => setCreating((prev) => (prev ? { ...prev, name } : prev)),
    onCreateCommit: () => void commitCreate(),
    onCreateCancel: () => setCreating(null),
    onStartRename: (entry) => {
      setCreating(null)
      setConfirmRemove(null)
      setEditing({ path: entry.path, name: entry.name })
    },
    onEditDraft: (name) => setEditing((prev) => (prev ? { ...prev, name } : prev)),
    onRenameCommit: () => void commitRename(),
    onRenameCancel: () => setEditing(null),
    onStartRemove: (entry) => {
      setCreating(null)
      setEditing(null)
      setConfirmRemove(entry.path)
    },
    onRemoveConfirm: (path) => void commitRemove(path),
    onRemoveCancel: () => setConfirmRemove(null),
    onStartMove: openMovePicker
  }

  return (
    <aside
      className={`flex min-h-0 flex-1 flex-col bg-[var(--color-surface)] ${
        embedded ? '' : 'w-72 shrink-0 border-l border-[var(--color-border)]'
      }`}
    >
      {!embedded && (
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-3">
          <Folder size={13} className="shrink-0 text-[var(--color-accent)]" />
          <span className="truncate text-2xs font-medium uppercase tracking-wide text-[var(--color-muted)]">工作区文件</span>
          <span className="ml-auto" />
          <button
            type="button"
            onClick={() => startCreate('')}
            className="icon-btn h-6 w-6"
            title="在工作区根目录新建文件"
          >
            <FilePlus size={12} />
          </button>
          <button type="button" onClick={refresh} className="icon-btn h-6 w-6" title="刷新">
            <RefreshCw size={12} />
          </button>
          <button type="button" onClick={onClose} className="icon-btn h-6 w-6" title="收起面板">
            <X size={13} />
          </button>
        </header>
      )}
      {embedded && (
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-2">
          <button
            type="button"
            onClick={() => startCreate('')}
            className="icon-btn h-6 w-6"
            title="在工作区根目录新建文件"
          >
            <FilePlus size={12} />
          </button>
          <button type="button" onClick={refresh} className="icon-btn h-6 w-6" title="刷新">
            <RefreshCw size={12} />
          </button>
        </div>
      )}

      {/*
        移动选择器就地展开在树的上方，不弹窗：目标目录列表与树是同一套信息，
        遮住树只会让人更难确认「我要移到哪」。
      */}
      {moveSource && (
        <div className="border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2">
          <p className="mb-1.5 truncate text-2xs text-[var(--color-muted)]">
            移动「{moveSource.name}」到：
            <span className="text-[var(--color-ink)]">/{moveDir || '（根目录）'}</span>
          </p>

          <div className="mb-1.5 flex items-center gap-1">
            <button
              type="button"
              onClick={() => setMoveDir(parentOf(moveDir))}
              disabled={moveDir === ''}
              className="btn btn-outline h-6 px-2 text-2xs"
              title="移到上一级"
            >
              上一级
            </button>
            <button type="button" onClick={() => void commitMove()} className="btn btn-primary h-6 px-2 text-2xs" title="移到这里">
              移到这里
            </button>
            <button
              type="button"
              onClick={() => setMoveSource(null)}
              className="btn h-6 px-2 text-2xs"
              title="取消移动"
            >
              取消
            </button>
          </div>

          <div className="max-h-32 overflow-auto rounded border border-[var(--color-border)] bg-[var(--color-surface)]">
            {moveEntries.length === 0 ? (
              <p className="px-2 py-1.5 text-[11px] text-[var(--color-muted)]">这里没有子目录</p>
            ) : (
              moveEntries.map((dir) => (
                <button
                  key={dir.path}
                  type="button"
                  onClick={() => setMoveDir(dir.path)}
                  className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] hover:bg-[var(--color-surface-2)]"
                  title={`进入 ${dir.path}`}
                >
                  <Folder size={11} className="shrink-0 text-[var(--color-accent)]" />
                  <span className="truncate">{dir.name}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {error && (
        <p className="border-b border-[var(--color-border)] px-3 py-2 text-[11px] text-[var(--color-danger)]">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-auto py-1">
        {!workspace && (
          <p className="px-3 py-6 text-center text-xs text-[var(--color-muted)]">请先选择一个工作目录</p>
        )}

        {workspace && !dirs[''] && loading.has('') && (
          <p className="flex items-center justify-center gap-2 px-3 py-6 text-xs text-[var(--color-muted)]">
            <Loader2 size={12} className="animate-spin" />
            读取目录…
          </p>
        )}

        {creating?.dirPath === '' && (
          <NameInput
            value={creating.name}
            placeholder="新文件名（如 notes.md）"
            depth={0}
            onChange={actions.onCreateDraft}
            onCommit={actions.onCreateCommit}
            onCancel={actions.onCreateCancel}
          />
        )}

        <TreeNodes
          path=""
          depth={0}
          dirs={dirs}
          expanded={expanded}
          loading={loading}
          onToggle={toggle}
          onOpenFile={(entry) => void openFile(entry)}
          actions={actions}
        />
      </div>

      {preview && workspace && (
        /**
         * `key` 是**令牌**而不是 `preview.path` —— 这不是装饰，少了它就有一个
         * **会改坏文件**的缺陷。
         *
         * 这个弹窗内部用 `useState(preview.text)` 保存正在编辑的文本，而 `useState`
         * 只在挂载时取初值。换文件时组件实例若被复用：
         *
         *   - 编辑器里显示的仍是**上一个文件**的内容（标题却已经变了）；
         *   - `dirty = text !== preview.text` 立刻为真 → 界面显示「未保存」、
         *     「保存」按钮可点 —— 用户按下 Ctrl+S，**上一个文件的内容就被写进了这个文件**。
         *
         * 所以「用户主动打开另一个文件」时必须重挂载。用令牌而不是路径，是因为
         * **改名 / 移动只会改写路径、内容没变**：那时重挂载会白白丢掉用户的编辑内容
         * （见 `remapPreview`）。
         */
        <FilePreviewDialog
          key={openToken}
          preview={preview}
          workspaceId={workspace.id}
          onReloaded={setPreview}
          onClose={() => {
            setPreview(null)
            setEditorDirty(false)
            setPendingOpen(null)
          }}
          onDirtyChange={setEditorDirty}
          pendingSwitchTo={pendingOpen?.path}
          onConfirmSwitch={() => {
            if (pendingOpen) void confirmDiscardAndOpen(pendingOpen)
          }}
          onCancelSwitch={() => setPendingOpen(null)}
        />
      )}
    </aside>
  )
}

/** 树操作集合。打包成一个对象传，免得每层透传十几个 prop。 */
interface TreeActions {
  creating: { dirPath: string; name: string } | null
  editing: { path: string; name: string } | null
  confirmRemove: string | null
  onStartCreate: (dirPath: string) => void
  onCreateDraft: (name: string) => void
  onCreateCommit: () => void
  onCreateCancel: () => void
  onStartRename: (entry: FsEntry) => void
  onEditDraft: (name: string) => void
  onRenameCommit: () => void
  onRenameCancel: () => void
  onStartRemove: (entry: FsEntry) => void
  onRemoveConfirm: (path: string) => void
  onRemoveCancel: () => void
  onStartMove: (entry: FsEntry) => void
}

function TreeNodes({
  path,
  depth,
  dirs,
  expanded,
  loading,
  onToggle,
  onOpenFile,
  actions
}: {
  path: string
  depth: number
  dirs: Record<string, FsEntry[]>
  expanded: Set<string>
  loading: Set<string>
  onToggle: (entry: FsEntry) => void
  onOpenFile: (entry: FsEntry) => void
  actions: TreeActions
}): React.ReactElement | null {
  const entries = dirs[path]
  if (!entries) return null

  return (
    <>
      {entries.map((entry) => {
        const isDir = entry.kind === 'directory'
        const isOpen = expanded.has(entry.path)
        const isLoading = loading.has(entry.path)
        const isEditing = actions.editing?.path === entry.path
        const isConfirming = actions.confirmRemove === entry.path

        return (
          <div key={entry.path}>
            {isEditing ? (
              <NameInput
                value={actions.editing?.name ?? ''}
                depth={depth}
                onChange={actions.onEditDraft}
                onCommit={actions.onRenameCommit}
                onCancel={actions.onRenameCancel}
              />
            ) : (
              <div
                className="group flex items-center gap-1 rounded-[var(--radius-sm)] text-xs text-[var(--color-ink-soft)] transition-colors hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]"
                style={{ paddingLeft: `${depth * 12 + 4}px` }}
              >
                <button
                  type="button"
                  onClick={() => (isDir ? onToggle(entry) : onOpenFile(entry))}
                  className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
                  title={entry.path}
                >
                  {isDir ? (
                    <>
                      <ChevronRight
                        size={11}
                        className={`shrink-0 text-[var(--color-muted)] ${isOpen ? 'rotate-90' : ''} transition-transform`}
                      />
                      {isOpen ? (
                        <FolderOpen size={12} className="shrink-0 text-[var(--color-accent)]" />
                      ) : (
                        <Folder size={12} className="shrink-0 text-[var(--color-accent)]" />
                      )}
                    </>
                  ) : (
                    <>
                      <span className="w-[11px] shrink-0" />
                      <FileText size={12} className="shrink-0 text-[var(--color-muted)]" />
                    </>
                  )}
                  <span className="truncate">{entry.name}</span>
                  {isLoading && <Loader2 size={10} className="ml-auto shrink-0 animate-spin" />}
                </button>

                {/*
                  行内操作只在悬停时出现（用 group-hover）。常驻会让整棵树变得很长很吵，
                  而这三件事都不是高频到需要一直可见。目录多一个「在此新建文件」。
                */}
                <span className="hidden shrink-0 items-center pr-1 group-hover:flex">
                  {isDir && (
                    <RowAction title="在此新建文件" onClick={() => actions.onStartCreate(entry.path)}>
                      <FilePlus size={11} />
                    </RowAction>
                  )}
                  <RowAction title="重命名" onClick={() => actions.onStartRename(entry)}>
                    <Pencil size={11} />
                  </RowAction>
                  <RowAction title="移动到…" onClick={() => actions.onStartMove(entry)}>
                    <FolderInput size={11} />
                  </RowAction>
                  <RowAction title="删除" danger onClick={() => actions.onStartRemove(entry)}>
                    <Trash2 size={11} />
                  </RowAction>
                </span>
              </div>
            )}

            {/*
              删除确认就地展开在行下方，而不是弹窗：目标就在上一行，
              用户能直接确认「我删的是这个」，弹窗反而会遮住它。
            */}
            {isConfirming && (
              <div
                className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)] px-2 py-1 text-2xs text-[var(--color-danger)]"
                style={{ marginLeft: `${depth * 12 + 16}px` }}
              >
                <span className="truncate">删除「{entry.name}」？会移到系统回收站</span>
                <button
                  type="button"
                  onClick={() => actions.onRemoveConfirm(entry.path)}
                  className="btn h-5 shrink-0 border border-[var(--color-danger)]/50 px-1.5 text-2xs hover:bg-[var(--color-danger)]/20"
                >
                  删除
                </button>
                <button
                  type="button"
                  onClick={actions.onRemoveCancel}
                  className="shrink-0 text-2xs text-[var(--color-muted)] hover:text-[var(--color-ink)]"
                >
                  取消
                </button>
              </div>
            )}

            {isDir && isOpen && (
              <>
                {actions.creating?.dirPath === entry.path && (
                  <NameInput
                    value={actions.creating?.name ?? ''}
                    placeholder="新文件名"
                    depth={depth + 1}
                    onChange={actions.onCreateDraft}
                    onCommit={actions.onCreateCommit}
                    onCancel={actions.onCreateCancel}
                  />
                )}
                <TreeNodes
                  path={entry.path}
                  depth={depth + 1}
                  dirs={dirs}
                  expanded={expanded}
                  loading={loading}
                  onToggle={onToggle}
                  onOpenFile={onOpenFile}
                  actions={actions}
                />
              </>
            )}
          </div>
        )
      })}
    </>
  )
}

function RowAction({
  title,
  onClick,
  danger = false,
  children
}: {
  title: string
  onClick: () => void
  danger?: boolean
  children: React.ReactNode
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`grid h-5 w-5 place-items-center rounded hover:bg-[var(--color-surface)] ${
        danger ? 'hover:text-[var(--color-danger)]' : 'hover:text-[var(--color-ink)]'
      }`}
    >
      {children}
    </button>
  )
}

/**
 * 就地输入行（新建与重命名共用）。
 *
 * 自动聚焦 + 全选：用户点了「重命名」就是要改名，还要再点一次输入框是最容易
 * 让人放弃的那种摩擦（与会话栏里的处理一致）。
 */
function NameInput({
  value,
  placeholder,
  depth,
  onChange,
  onCommit,
  onCancel
}: {
  value: string
  placeholder?: string
  depth: number
  onChange: (value: string) => void
  onCommit: () => void
  onCancel: () => void
}): React.ReactElement {
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  return (
    <div className="px-1 py-0.5" style={{ paddingLeft: `${depth * 12 + 4}px` }}>
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        aria-label="文件名"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            onCommit()
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          }
        }}
        className="w-full rounded border border-[var(--color-accent)] bg-[var(--color-surface-2)] px-1.5 py-[3px] text-[12px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-muted)]"
      />
    </div>
  )
}

function FilePreviewDialog({
  preview,
  workspaceId,
  onReloaded,
  onClose,
  onDirtyChange,
  pendingSwitchTo,
  onConfirmSwitch,
  onCancelSwitch
}: {
  preview: FilePreview
  workspaceId: string
  onReloaded: (next: FilePreview) => void
  onClose: () => void
  /** 把「有未保存改动」上报给外层：切换文件也要经过这道闸门。 */
  onDirtyChange: (dirty: boolean) => void
  /** 用户点了另一个文件、但当前有未保存改动时，这里是那个文件的路径。 */
  pendingSwitchTo?: string
  onConfirmSwitch: () => void
  onCancelSwitch: () => void
}): React.ReactElement {
  const readOnly = Boolean(preview.readOnlyReason)

  const [text, setText] = useState(preview.text)
  /** 已保存内容对应的版本标记；保存成功后要用返回值更新它。 */
  const [revision, setRevision] = useState(preview.revision)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** STALE_WRITE 时置位：给出「重新加载」这条路，而不是让用户卡在无法保存的状态。 */
  const [stale, setStale] = useState(false)
  /** 有未保存改动时，第一次 Esc 只提示，第二次才真正关闭。 */
  const [confirmClose, setConfirmClose] = useState(false)

  const dirty = !readOnly && text !== preview.text

  const save = useCallback(async () => {
    if (readOnly || saving) return
    setSaving(true)
    setError(null)
    try {
      const result = await call(
        getDesk().fs.write({ workspaceId, path: preview.path, text, expectedRevision: revision })
      )
      setRevision(result.revision)
      setStale(false)
      // 让父组件里的 preview 也跟上，dirty 判定才会归零。
      onReloaded({ ...preview, text, bytes: result.bytes, truncated: false, revision: result.revision })
    } catch (err) {
      const ipcError = err instanceof IpcError ? err : null
      if (ipcError?.code === 'STALE_WRITE') setStale(true)
      setError(ipcError ? ipcError.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [onReloaded, preview, readOnly, revision, saving, text, workspaceId])

  const reload = useCallback(async () => {
    try {
      const next = await call(getDesk().fs.read(workspaceId, preview.path))
      setText(next.text)
      setRevision(next.revision)
      setStale(false)
      setError(null)
      onReloaded(next)
    } catch (err) {
      setError(err instanceof IpcError ? err.message : String(err))
    }
  }, [onReloaded, preview.path, workspaceId])

  /** 把脏状态上报给外层（切换文件的那道闸门要用它）。 */
  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])

  /**
   * 关闭前必须先过「有没有未保存改动」这道闸门。
   *
   * 之前只有 Esc 走了这道闸门，**X 按钮与底部的「关闭」按钮直接调 onClose** ——
   * 也就是说：同一次编辑，按 Esc 会问你，点 X 就直接丢。行为不一致本身就是 bug。
   */
  const requestClose = useCallback((): void => {
    if (dirty && !confirmClose) {
      setConfirmClose(true)
      return
    }
    onClose()
  }, [dirty, confirmClose, onClose])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // Ctrl/Cmd+S 保存：编辑器场景的标准快捷键，不做会显得很「网页」。
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void save()
        return
      }
      if (event.key !== 'Escape') return
      requestClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save, requestClose])

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-[var(--color-overlay)] p-6 backdrop-blur-[2px]"
      onMouseDown={requestClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-lg)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-3">
          <FileText size={13} className="shrink-0 text-[var(--color-accent)]" />
          <span className="truncate font-mono text-xs">{preview.path}</span>
          {dirty && <span className="chip chip-warn h-[18px] px-1.5 text-2xs">● 未保存</span>}
          <span className="ml-auto shrink-0 font-mono text-2xs tabular-nums text-[var(--color-muted)]">
            {formatBytes(utf8Bytes(text))}
            {preview.truncated ? ' · 已截断' : ''}
          </span>
          <button
            type="button"
            onClick={requestClose}
            className="icon-btn h-6 w-6 shrink-0"
            title="关闭（有未保存改动会先问）"
          >
            <X size={14} />
          </button>
        </header>

        {preview.readOnlyReason && (
          <p className="border-b border-[var(--color-border)] bg-[var(--color-warn)]/8 px-3 py-2 text-[11px] text-[var(--color-warn)]">
            {preview.readOnlyReason}
          </p>
        )}

        {error && (
          <div className="flex items-start gap-2 border-b border-[var(--color-border)] bg-[var(--color-danger)]/8 px-3 py-2 text-[11px] text-[var(--color-danger)]">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1">{error}</span>
            {stale && (
              <button
                type="button"
                onClick={() => void reload()}
                className="shrink-0 rounded border border-[var(--color-border)] px-2 py-0.5 text-[var(--color-ink)] hover:bg-[var(--color-surface-2)]"
              >
                重新加载（丢弃我的改动）
              </button>
            )}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          {preview.binary ? (
            <p className="px-4 py-8 text-center text-sm text-[var(--color-muted)]">
              这是二进制文件，不支持预览。
            </p>
          ) : (
            /**
             * CodeMirror 自带行号槽与横向滚动，所以这里不再手写「行号列 + pre/textarea」
             * 那一套。编辑器撑满容器，滚动交给它自己 —— 外面再套一层滚动会让
             * 行号跟着内容滑走（第一版手写时就踩过）。
             *
             * 用 `EditorSlot` 而不是直接渲染 `CodeEditor`：CodeMirror 内核按需加载，
             * 这里同时承担加载态与「加载失败怎么办」（见 EditorSlot 的说明）。
             */
            <EditorSlot
              value={text}
              path={preview.path}
              readOnly={readOnly}
              onChange={(next) => {
                setText(next)
                setConfirmClose(false)
              }}
              className="min-h-[240px]"
            />
          )}
        </div>

        <footer className="flex h-11 shrink-0 items-center gap-2 border-t border-[var(--color-border)] px-3">
          {/*
            两种确认共用一条底线：「先问，再丢」。区别只在丢了之后做什么 ——
            关闭，还是打开用户刚点的那另一个文件。
          */}
          {pendingSwitchTo ? (
            <>
              <span className="text-[11px] text-[var(--color-warn)]">
                有未保存的改动，打开「{pendingSwitchTo.split('/').pop()}」会丢弃它们
              </span>
              <button
                type="button"
                onClick={onConfirmSwitch}
                className="rounded-md border border-[var(--color-danger)]/50 px-2 py-1 text-[11px] text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10"
                title="丢弃改动并打开"
              >
                丢弃并打开
              </button>
              <button
                type="button"
                onClick={onCancelSwitch}
                className="rounded-md px-2 py-1 text-[11px] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
                title="继续编辑当前文件"
              >
                继续编辑
              </button>
            </>
          ) : confirmClose ? (
            <>
              <span className="text-[11px] text-[var(--color-warn)]">有未保存的改动</span>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-[var(--color-danger)]/50 px-2 py-1 text-[11px] text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10"
                title="丢弃改动并关闭"
              >
                丢弃并关闭
              </button>
              <button
                type="button"
                onClick={() => setConfirmClose(false)}
                className="rounded-md px-2 py-1 text-[11px] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
                title="继续编辑"
              >
                继续编辑
              </button>
            </>
          ) : (
            <>
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={!dirty || saving}
                  className="flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40"
                >
                  {saving && <Loader2 size={12} className="animate-spin" />}
                  保存
                </button>
              )}
              {!readOnly && (
                <span className="text-[10px] text-[var(--color-muted)]">
                  Ctrl+S 保存 · 保存前会校验文件是否被 agent 改过
                </span>
              )}
              <button
                type="button"
                onClick={requestClose}
                className="ml-auto rounded-md px-3 py-1.5 text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]"
                title="关闭"
              >
                关闭
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * UTF-8 字节数。
 *
 * 刻意不用 `Buffer.byteLength` —— 那是 Node 的 API，渲染层没有（我们没开 nodeIntegration，
 * 正是为了这个）。`TextEncoder` 是标准 Web API，语义等价。
 */
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}
