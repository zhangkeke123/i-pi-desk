export type UpdateMode = 'disabled' | 'notify' | 'in-app'

export type UpdatePhase = 'disabled' | 'idle' | 'checking' | 'downloading' | 'ready' | 'notify' | 'error'

export interface UpdateStatus {
  mode: UpdateMode
  phase: UpdatePhase
  currentVersion: string
  latestVersion?: string
  message?: string
  url?: string
}
