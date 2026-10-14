import { IPC, type ScheduledTask } from '@i-pi-desk/shared'
import { listScheduledTasks, saveScheduledTasks } from '../store/scheduled-tasks.js'
import { arg, handle } from './wrap.js'

export function registerScheduledTasksIpc(): void {
  handle<ScheduledTask[]>(IPC.invoke.scheduledTasksList, () => listScheduledTasks())

  handle<ScheduledTask[]>(IPC.invoke.scheduledTasksSave, (_event, ...args) => {
    const tasks = arg<ScheduledTask[]>(args, 0)
    if (!Array.isArray(tasks)) return saveScheduledTasks([])
    return saveScheduledTasks(tasks)
  })
}
