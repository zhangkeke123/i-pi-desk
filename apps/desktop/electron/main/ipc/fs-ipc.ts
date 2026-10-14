import { shell } from 'electron'
import {
  IPC,
  type FileCreateInput,
  type FileMutationResult,
  type FileMoveInput,
  type FilePreview,
  type FileRemoveInput,
  type FileRenameInput,
  type FileWriteInput,
  type FileWriteResult,
  type FsEntry,
  type FsSearchResult
} from '@i-pi-desk/shared'
import { getWorkspace } from '../store/workspaces.js'
import {
  createFileInWorkspace,
  listDirectory,
  moveInWorkspace,
  readFilePreview,
  removeInWorkspace,
  renameInWorkspace,
  writeFileInWorkspace
} from '../store/workspace-fs.js'
import { searchInWorkspace } from '../store/fs-search.js'
import { arg, handle, requireString } from './wrap.js'

/**
 * 工作区文件读取的 IPC。
 *
 * 关键设计：**入参是 workspaceId，不是根路径**。
 * 如果让渲染层传根路径，那么一个被 XSS 或恶意插件影响的渲染层就能把根改成 `C:\`，
 * 于是「只在工作区内读文件」这条约束就形同虚设。
 * 根路径必须由主进程从自己的存储里查出来 —— 与上游「sidecar 可以申请路径，
 * 但永远不能自己决定项目根目录」是同一个思路。
 */

function workspaceRoot(workspaceId: string): string {
  const workspace = getWorkspace(workspaceId)
  if (!workspace) {
    throw Object.assign(new Error(`工作区不存在: ${workspaceId}`), { code: 'WORKSPACE_NOT_FOUND' })
  }
  return workspace.path
}

export function registerFsIpc(): void {
  handle<FsEntry[]>(IPC.invoke.fsList, (_event, ...args) => {
    const workspaceId = requireString(args[0], 'workspaceId')
    const relativePath = typeof args[1] === 'string' ? (args[1] as string) : ''
    return listDirectory(workspaceRoot(workspaceId), relativePath).entries
  })

  handle<FilePreview>(IPC.invoke.fsRead, (_event, ...args) => {
    const workspaceId = requireString(args[0], 'workspaceId')
    const relativePath = requireString(args[1], 'relativePath')
    return readFilePreview(workspaceRoot(workspaceId), relativePath)
  })

  handle<FileWriteResult>(IPC.invoke.fsWrite, (_event, ...args) => {
    const input = arg<FileWriteInput>(args, 0)
    const workspaceId = requireString(input?.workspaceId, 'workspaceId')
    const relativePath = requireString(input?.path, 'path')
    const text = typeof input?.text === 'string' ? input.text : ''
    // expectedRevision 允许显式 null（新建）；undefined 视为调用方漏传并拒绝 ——
    // 「忘了传」与「明确表示新建」必须区分开，否则一次笔误就变成无保护覆盖。
    if (input?.expectedRevision === undefined) {
      throw Object.assign(new Error('缺少 expectedRevision（新建请显式传 null）'), { code: 'BAD_REQUEST' })
    }
    return writeFileInWorkspace(workspaceRoot(workspaceId), relativePath, text, input.expectedRevision)
  })

  handle<FileMutationResult>(IPC.invoke.fsCreate, (_event, ...args) => {
    const input = arg<FileCreateInput>(args, 0)
    const workspaceId = requireString(input?.workspaceId, 'workspaceId')
    const relativePath = requireString(input?.path, 'path')
    return createFileInWorkspace(workspaceRoot(workspaceId), relativePath, input?.text ?? '')
  })

  handle<FileMutationResult>(IPC.invoke.fsRename, (_event, ...args) => {
    const input = arg<FileRenameInput>(args, 0)
    const workspaceId = requireString(input?.workspaceId, 'workspaceId')
    const relativePath = requireString(input?.path, 'path')
    const newName = requireString(input?.newName, 'newName')
    return renameInWorkspace(workspaceRoot(workspaceId), relativePath, newName)
  })

  handle<FileMutationResult>(IPC.invoke.fsMove, (_event, ...args) => {
    const input = arg<FileMoveInput>(args, 0)
    const workspaceId = requireString(input?.workspaceId, 'workspaceId')
    const relativePath = requireString(input?.path, 'path')
    // 目标目录允许是空字符串（= 工作区根目录），所以这里不 requireString。
    const targetDir = typeof input?.targetDir === 'string' ? input.targetDir : ''
    return moveInWorkspace(workspaceRoot(workspaceId), relativePath, targetDir)
  })

  handle<FileMutationResult>(IPC.invoke.fsRemove, async (_event, ...args) => {
    const input = arg<FileRemoveInput>(args, 0)
    const workspaceId = requireString(input?.workspaceId, 'workspaceId')
    const relativePath = requireString(input?.path, 'path')
    // 删除走**系统回收站**而不是 rm（见 DeskApi 上的说明）：
    // 编辑器里的误删应当可恢复。`shell.trashItem` 是 Electron 提供的唯一正规途径。
    return removeInWorkspace(workspaceRoot(workspaceId), relativePath, (absolute) => shell.trashItem(absolute))
  })

  handle<FsSearchResult>(IPC.invoke.fsSearch, (_event, ...args) => {
    const input = arg<{ workspaceId?: string; query?: string; maxHits?: number }>(args, 0)
    const workspaceId = requireString(input?.workspaceId, 'workspaceId')
    const query = typeof input?.query === 'string' ? input.query : ''
    const maxHits = typeof input?.maxHits === 'number' && Number.isFinite(input.maxHits) ? input.maxHits : undefined
    return searchInWorkspace(workspaceRoot(workspaceId), query, maxHits)
  })
}
