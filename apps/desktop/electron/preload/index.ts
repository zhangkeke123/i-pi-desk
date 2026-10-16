import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC,
  type AgentEventNotification,
  type AppInfo,
  type AppSettings,
  type ApprovalDecision,
  type ControlPlaneLoginInput,
  type ControlPlaneQuota,
  type ControlPlaneStatus,
  type ControlPlaneSyncResult,
  type DeskApi,
  type FileCreateInput,
  type FileMutationResult,
  type FilePreview,
  type FileRemoveInput,
  type FileMoveInput,
  type FileRenameInput,
  type FileWriteInput,
  type FileWriteResult,
  type FsEntry,
  type FsSearchResult,
  type GitDiffResult,
  type GitRepoInfo,
  type GitStatusResult,
  type InstalledSkill,
  type PluginView,
  type PromptRequest,
  type PromptResponse,
  type ProviderConfig,
  type ProviderVerifyResult,
  type ProviderView,
  type Result,
  type RuntimeStatus,
  type Session,
  type SessionEvent,
  type SessionInspectResult,
  type ScheduledTask,
  type SessionSnapshot,
  type SettingsView,
  type TerminalCreateOptions,
  type TerminalDataEvent,
  type TerminalExitEvent,
  type TerminalSession,
  type Unsubscribe,
  type UpdateStatus,
  type Workspace,
  type WorkspaceFacts,
  type WorkspaceEvent
} from '@i-pi-desk/shared'

/**
 * 渲染层唯一的对外出口。
 *
 * 红线：**绝不把 `ipcRenderer` 直接暴露出去**。
 * 一旦暴露，渲染层就能往任意通道发消息，等于绕过了这里的方法白名单，
 * contextIsolation 也就白做了。
 */

function invoke<T>(channel: string, ...args: unknown[]): Promise<Result<T>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<Result<T>>
}

/** 订阅主进程推送，返回取消订阅函数。 */
function subscribe<T>(channel: string, callback: (payload: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const desk: DeskApi = {
  app: {
    info: () => invoke<AppInfo>(IPC.invoke.appInfo),
    setEditorDirty: (dirty: boolean) => invoke<{ dirty: boolean }>(IPC.invoke.editorDirty, { dirty }),
    confirmQuit: () => invoke<{ closing: boolean }>(IPC.invoke.quitConfirmed),
    updateStatus: () => invoke<UpdateStatus>(IPC.invoke.updateStatus),
    updateCheck: () => invoke<UpdateStatus>(IPC.invoke.updateCheck),
    updateInstall: () => invoke<UpdateStatus>(IPC.invoke.updateInstall),
    updateOpen: () => invoke<UpdateStatus>(IPC.invoke.updateOpen)
  },
  workspace: {
    list: () => invoke<Workspace[]>(IPC.invoke.workspaceList),
    open: (path) => invoke<Workspace>(IPC.invoke.workspaceOpen, path),
    remove: (id) => invoke<{ id: string }>(IPC.invoke.workspaceRemove, id),
    facts: (path: string) => invoke<WorkspaceFacts>(IPC.invoke.workspaceFacts, path),
    setColor: (input) => invoke<Workspace>(IPC.invoke.workspaceSetColor, input)
  },
  session: {
    list: () => invoke<Session[]>(IPC.invoke.sessionList),
    create: (input) => invoke<Session>(IPC.invoke.sessionCreate, input),
    load: (sessionId) => invoke<SessionSnapshot>(IPC.invoke.sessionLoad, sessionId),
    rename: (input) => invoke<Session>(IPC.invoke.sessionRename, input),
    duplicate: (sessionId) => invoke<Session>(IPC.invoke.sessionDuplicate, sessionId),
    setPinned: (input) => invoke<Session>(IPC.invoke.sessionSetPinned, input),
    patch: (input) => invoke<Session>(IPC.invoke.sessionPatch, input),
    remove: (sessionId) => invoke<{ id: string }>(IPC.invoke.sessionDelete, sessionId)
  },
  agent: {
    prompt: (input: PromptRequest) => invoke<PromptResponse>(IPC.invoke.agentPrompt, input),
    abort: (sessionId) => invoke<{ aborted: true }>(IPC.invoke.agentAbort, sessionId),
    resolveApproval: (input: { sessionId: string; approvalId: string; decision: ApprovalDecision }) =>
      invoke<{ resolved: true }>(IPC.invoke.agentResolveApproval, input),
    inspect: (sessionId: string) => invoke<SessionInspectResult>(IPC.invoke.agentInspect, sessionId),
    status: () => invoke<RuntimeStatus>(IPC.invoke.agentStatus)
  },
  skills: {
    list: () => invoke<InstalledSkill[]>(IPC.invoke.skillsList),
    install: (input: { name: string; content: string }) =>
      invoke<InstalledSkill>(IPC.invoke.skillsInstall, input),
    remove: (name: string) => invoke<{ name: string }>(IPC.invoke.skillsRemove, name),
    openDir: () => invoke<{ path: string }>(IPC.invoke.skillsOpenDir)
  },
  mcp: {
    list: (workspaceId) => invoke(IPC.invoke.mcpList, workspaceId),
    save: (input) => invoke(IPC.invoke.mcpSave, input),
    remove: (input) => invoke(IPC.invoke.mcpRemove, input),
    setEnabled: (input) => invoke(IPC.invoke.mcpSetEnabled, input),
    openDir: () => invoke(IPC.invoke.mcpOpenDir),
    syncRuntime: (workspaceId) => invoke(IPC.invoke.mcpSyncRuntime, workspaceId)
  },
  subagents: {
    list: () => invoke(IPC.invoke.subagentsList),
    save: (input) => invoke(IPC.invoke.subagentsSave, input),
    remove: (id) => invoke(IPC.invoke.subagentsRemove, id),
    setEnabled: (input) => invoke(IPC.invoke.subagentsSetEnabled, input)
  },
  provider: {
    list: () => invoke<ProviderView[]>(IPC.invoke.providerList),
    save: (input: { provider: ProviderConfig; apiKey?: string }) =>
      invoke<ProviderView>(IPC.invoke.providerSave, input),
    remove: (providerId) => invoke<{ id: string }>(IPC.invoke.providerDelete, providerId),
    verify: (input: { provider: ProviderConfig; apiKey?: string }) =>
      invoke<ProviderVerifyResult>(IPC.invoke.providerVerify, input)
  },
  settings: {
    get: () => invoke<SettingsView>(IPC.invoke.settingsGet),
    set: (patch: Partial<AppSettings>) => invoke<AppSettings>(IPC.invoke.settingsSet, patch)
  },
  scheduledTasks: {
    list: () => invoke<ScheduledTask[]>(IPC.invoke.scheduledTasksList),
    save: (tasks: ScheduledTask[]) => invoke<ScheduledTask[]>(IPC.invoke.scheduledTasksSave, tasks)
  },
  fs: {
    list: (workspaceId: string, relativePath?: string) =>
      invoke<FsEntry[]>(IPC.invoke.fsList, workspaceId, relativePath ?? ''),
    read: (workspaceId: string, relativePath: string) =>
      invoke<FilePreview>(IPC.invoke.fsRead, workspaceId, relativePath),
    write: (input: FileWriteInput) => invoke<FileWriteResult>(IPC.invoke.fsWrite, input),
    create: (input: FileCreateInput) => invoke<FileMutationResult>(IPC.invoke.fsCreate, input),
    rename: (input: FileRenameInput) => invoke<FileMutationResult>(IPC.invoke.fsRename, input),
    move: (input: FileMoveInput) => invoke<FileMutationResult>(IPC.invoke.fsMove, input),
    remove: (input: FileRemoveInput) => invoke<FileMutationResult>(IPC.invoke.fsRemove, input),
    search: (input: { workspaceId: string; query: string; maxHits?: number }) =>
      invoke<FsSearchResult>(IPC.invoke.fsSearch, input)
  },
  git: {
    discover: (workspaceId: string) => invoke<GitRepoInfo[]>(IPC.invoke.gitDiscover, workspaceId),
    status: (input: { workspaceId: string; repoRelativePath: string }) =>
      invoke<GitStatusResult>(IPC.invoke.gitStatus, input),
    diff: (input: { workspaceId: string; repoRelativePath: string; filePath: string; staged?: boolean }) =>
      invoke<GitDiffResult>(IPC.invoke.gitDiff, input)
  },
  terminal: {
    create: (options?: TerminalCreateOptions) => invoke<TerminalSession>(IPC.invoke.terminalCreate, options ?? {}),
    write: (id: string, data: string) => invoke<{ id: string }>(IPC.invoke.terminalWrite, id, data),
    resize: (id: string, cols: number, rows: number) =>
      invoke<{ id: string }>(IPC.invoke.terminalResize, id, cols, rows),
    dispose: (id: string) => invoke<{ id: string }>(IPC.invoke.terminalDispose, id),
    list: () => invoke<string[]>(IPC.invoke.terminalList),
    probe: () => invoke<{ available: boolean; message?: string }>(IPC.invoke.terminalProbe)
  },
  events: {
    onAgent: (cb) => subscribe<AgentEventNotification>(IPC.event.agent, cb),
    onSession: (cb) => subscribe<SessionEvent>(IPC.event.session, cb),
    onWorkspace: (cb) => subscribe<WorkspaceEvent>(IPC.event.workspace, cb),
    onRuntimeStatus: (cb) => subscribe<RuntimeStatus>(IPC.event.runtimeStatus, cb),
    onTerminalData: (cb) => subscribe<TerminalDataEvent>(IPC.event.terminalData, cb),
    onTerminalExit: (cb) => subscribe<TerminalExitEvent>(IPC.event.terminalExit, cb),
    // 主进程想关窗但有未保存改动时，请渲染层问一句。
    onCloseRequested: (cb) => subscribe<undefined>(IPC.event.closeRequested, () => cb()),
    onUpdate: (cb) => subscribe<UpdateStatus>(IPC.event.update, cb)
  },
  plugins: {
    list: () => invoke<PluginView[]>(IPC.invoke.pluginsList),
    install: () => invoke<PluginView | null>(IPC.invoke.pluginsInstall),
    remove: (id: string) => invoke<{ id: string }>(IPC.invoke.pluginsRemove, id),
    setEnabled: (id: string, enabled: boolean) => invoke<PluginView>(IPC.invoke.pluginsSetEnabled, id, enabled),
    openDir: () => invoke<{ path: string }>(IPC.invoke.pluginsOpenDir)
  },
  controlPlane: {
    status: () => invoke<ControlPlaneStatus>(IPC.invoke.cpStatus),
    login: (input: ControlPlaneLoginInput) => invoke<ControlPlaneStatus>(IPC.invoke.cpLogin, input),
    logout: () => invoke<ControlPlaneStatus>(IPC.invoke.cpLogout),
    sync: () => invoke<ControlPlaneSyncResult>(IPC.invoke.cpSync),
    quota: () => invoke<ControlPlaneQuota>(IPC.invoke.cpQuota),
    flushAudit: () => invoke<{ sent: number; pending: number }>(IPC.invoke.cpFlushAudit)
  },
  dialog: {
    pickDirectory: () => invoke<string | null>(IPC.invoke.dialogPickDirectory)
  }
}

contextBridge.exposeInMainWorld('desk', desk)
