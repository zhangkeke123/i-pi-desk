import {
  IPC,
  type GitDiffResult,
  type GitRepoInfo,
  type GitStatusResult
} from '@i-pi-desk/shared'
import { getWorkspace } from '../store/workspaces.js'
import { discoverGitRepos } from '../store/git-repos.js'
import { gitDiffInWorkspace, gitStatusInWorkspace } from '../store/git-ops.js'
import { arg, handle, requireString } from './wrap.js'

function workspaceRoot(workspaceId: string): string {
  const workspace = getWorkspace(workspaceId)
  if (!workspace) {
    throw Object.assign(new Error(`工作区不存在: ${workspaceId}`), { code: 'WORKSPACE_NOT_FOUND' })
  }
  return workspace.path
}

/** 仓库相对路径允许空字符串（工作区根即 Git 根）。 */
function repoRelativePathFrom(input: { repoRelativePath?: unknown } | undefined): string {
  return typeof input?.repoRelativePath === 'string' ? input.repoRelativePath.replace(/\\/g, '/') : ''
}

export function registerGitIpc(): void {
  handle<GitRepoInfo[]>(IPC.invoke.gitDiscover, (_event, ...args) => {
    const workspaceId = requireString(args[0], 'workspaceId')
    return discoverGitRepos(workspaceRoot(workspaceId))
  })

  handle<GitStatusResult>(IPC.invoke.gitStatus, (_event, ...args) => {
    const input = arg<{ workspaceId?: string; repoRelativePath?: string }>(args, 0)
    const workspaceId = requireString(input?.workspaceId, 'workspaceId')
    const repoRelativePath = repoRelativePathFrom(input)
    return gitStatusInWorkspace(workspaceRoot(workspaceId), repoRelativePath)
  })

  handle<GitDiffResult>(IPC.invoke.gitDiff, (_event, ...args) => {
    const input = arg<{
      workspaceId?: string
      repoRelativePath?: string
      filePath?: string
      staged?: boolean
    }>(args, 0)
    const workspaceId = requireString(input?.workspaceId, 'workspaceId')
    const repoRelativePath = repoRelativePathFrom(input)
    const filePath = requireString(input?.filePath, 'filePath')
    const staged = input?.staged === true
    return gitDiffInWorkspace(workspaceRoot(workspaceId), repoRelativePath, filePath, staged)
  })
}
