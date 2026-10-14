import { IPC, type SubagentDefinition, type SubagentSaveInput } from '@i-pi-desk/shared'
import {
  listSubagents,
  removeSubagent,
  saveSubagent,
  setSubagentEnabled,
  syncSubagentsRuntime
} from '../store/subagents.js'
import { arg, handle, requireString } from './wrap.js'

export function registerSubagentsIpc(): void {
  handle<SubagentDefinition[]>(IPC.invoke.subagentsList, () => {
    syncSubagentsRuntime()
    return listSubagents()
  })

  handle<SubagentDefinition>(IPC.invoke.subagentsSave, (_event, ...args) => {
    const input = arg<SubagentSaveInput>(args, 0)
    if (!input) throw Object.assign(new Error('缺少子智能体配置'), { code: 'SUBAGENT_INVALID' })
    const saved = saveSubagent(input)
    syncSubagentsRuntime()
    return saved
  })

  handle<{ id: string }>(IPC.invoke.subagentsRemove, (_event, ...args) => {
    const id = requireString(args[0], 'id')
    const result = removeSubagent(id)
    syncSubagentsRuntime()
    return result
  })

  handle<SubagentDefinition>(IPC.invoke.subagentsSetEnabled, (_event, ...args) => {
    const input = arg<{ id: string; enabled: boolean }>(args, 0)
    if (!input) throw Object.assign(new Error('缺少参数'), { code: 'SUBAGENT_INVALID' })
    const updated = setSubagentEnabled(input.id, input.enabled === true)
    syncSubagentsRuntime()
    return updated
  })
}
