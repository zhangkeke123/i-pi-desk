/**
 * 渲染层 ↔ 主进程 的 IPC 通道常量。
 *
 * 命名规则：`desk:<domain>/<action>`。
 * 约定：
 *  - `invoke` 类通道一律返回 `Result<T>` 信封（见 ./result.ts），主进程不抛异常穿过 IPC。
 *  - `event` 类通道是主进程 → 渲染层的单向推送，渲染层只订阅。
 *
 * 本文件只放常量，不 import 任何 Electron / Node 实现，保证渲染层可以安全引用。
 */

export const IPC = {
  invoke: {
    appInfo: 'desk:app/info',

    workspaceOpen: 'desk:workspace/open',
    workspaceList: 'desk:workspace/list',
    workspaceRemove: 'desk:workspace/remove',
    workspaceCurrent: 'desk:workspace/current',
    workspaceFacts: 'desk:workspace/facts',

    sessionCreate: 'desk:session/create',
    sessionList: 'desk:session/list',
    sessionLoad: 'desk:session/load',
    sessionRename: 'desk:session/rename',
    sessionDuplicate: 'desk:session/duplicate',

    sessionSetPinned: 'desk:session/set-pinned',
    sessionPatch: 'desk:session/patch',
    sessionDelete: 'desk:session/delete',
    workspaceSetColor: 'desk:workspace/set-color',

    agentPrompt: 'desk:agent/prompt',
    agentAbort: 'desk:agent/abort',
    agentResolveApproval: 'desk:agent/resolveApproval',
    agentInspect: 'desk:agent/inspect',
    agentStatus: 'desk:agent/status',

    skillsList: 'desk:skills/list',
    skillsInstall: 'desk:skills/install',
    skillsRemove: 'desk:skills/remove',
    skillsOpenDir: 'desk:skills/openDir',

    mcpList: 'desk:mcp/list',
    mcpSave: 'desk:mcp/save',
    mcpRemove: 'desk:mcp/remove',
    mcpSetEnabled: 'desk:mcp/setEnabled',
    mcpOpenDir: 'desk:mcp/openDir',
    mcpSyncRuntime: 'desk:mcp/syncRuntime',

    subagentsList: 'desk:subagents/list',
    subagentsSave: 'desk:subagents/save',
    subagentsRemove: 'desk:subagents/remove',
    subagentsSetEnabled: 'desk:subagents/setEnabled',

    pluginsList: 'desk:plugins/list',
    pluginsInstall: 'desk:plugins/install',
    pluginsRemove: 'desk:plugins/remove',
    pluginsSetEnabled: 'desk:plugins/setEnabled',
    pluginsOpenDir: 'desk:plugins/openDir',

    cpStatus: 'desk:controlPlane/status',
    cpLogin: 'desk:controlPlane/login',
    cpLogout: 'desk:controlPlane/logout',
    cpSync: 'desk:controlPlane/sync',
    cpQuota: 'desk:controlPlane/quota',
    cpFlushAudit: 'desk:controlPlane/flushAudit',

    providerList: 'desk:provider/list',
    providerSave: 'desk:provider/save',
    providerDelete: 'desk:provider/delete',
    providerVerify: 'desk:provider/verify',

    settingsGet: 'desk:settings/get',
    settingsSet: 'desk:settings/set',

    scheduledTasksList: 'desk:scheduledTasks/list',
    scheduledTasksSave: 'desk:scheduledTasks/save',

    fsList: 'desk:fs/list',
    fsRead: 'desk:fs/read',
    fsWrite: 'desk:fs/write',
    fsCreate: 'desk:fs/create',
    fsRename: 'desk:fs/rename',
  /** 跨目录移动（名字不变，只换父目录）。 */
  fsMove: 'desk:fs/move',
    fsRemove: 'desk:fs/remove',
    fsSearch: 'desk:fs/search',

    gitDiscover: 'desk:git/discover',
    gitStatus: 'desk:git/status',
    gitDiff: 'desk:git/diff',

    terminalCreate: 'desk:terminal/create',
    terminalWrite: 'desk:terminal/write',
    terminalResize: 'desk:terminal/resize',
    terminalDispose: 'desk:terminal/dispose',
    terminalList: 'desk:terminal/list',
    terminalProbe: 'desk:terminal/probe',

    dialogPickDirectory: 'desk:dialog/pickDirectory',

    /**
     * 渲染层告诉主进程「编辑器里现在有没有未保存的改动」。
     *
     * 关窗拦截必须在**主进程**做（`close` 事件只有它拿得到），而「有没有未保存」
     * 只有渲染层知道 —— 所以要把这一个布尔值同步上去。用 invoke 而不是 send：
     * 渲染层需要知道主进程已经收到了，否则「按了退出、窗口没关」会看起来像卡死。
     */
    editorDirty: 'desk:editor/dirty',
    /** 用户在「不保存并退出」上确认过：这一次关窗不再拦截。 */
    quitConfirmed: 'desk:app/quitConfirmed',

    updateStatus: 'desk:update/status',
    updateCheck: 'desk:update/check',
    updateInstall: 'desk:update/install',
    updateOpen: 'desk:update/open'
  },
  event: {
    agent: 'desk:event/agent',
    session: 'desk:event/session',
    workspace: 'desk:event/workspace',
    runtimeStatus: 'desk:event/runtimeStatus',
    terminalData: 'desk:event/terminalData',
    terminalExit: 'desk:event/terminalExit',
    /** 主进程想关窗、但有未保存的改动：请渲染层问一句。 */
    closeRequested: 'desk:event/closeRequested',
    update: 'desk:event/update'
  }
} as const

export type IpcInvokeChannel = (typeof IPC.invoke)[keyof typeof IPC.invoke]
export type IpcEventChannel = (typeof IPC.event)[keyof typeof IPC.event]
