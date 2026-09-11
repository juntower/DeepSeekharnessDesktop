import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  IPC,
  type AppSettings,
  type OpenMainAction,
  type UpdateSecretInput,
  type WindowAction
} from '../../shared/contracts'
import type { AppController } from '../app-controller'

const WINDOW_ACTIONS = new Set<WindowAction>(['minimize', 'maximize', 'close', 'close-to-tray'])
const OPEN_ACTIONS = new Set<OpenMainAction>(['open-main', 'restart-dsh', 'open-settings', 'check-updates'])

function assertRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected an object argument')
  }
  return value as Record<string, unknown>
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  return value
}

export function registerIpc(controller: AppController): void {
  const secured = <T extends unknown[]>(
    handler: (event: IpcMainInvokeEvent, ...args: T) => unknown
  ): ((event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
    return (event, ...args) => {
      if (!controller.isTrustedWebContents(event.sender.id)) {
        throw new Error('IPC request rejected: untrusted renderer')
      }
      return handler(event, ...(args as T))
    }
  }

  const register = <T extends unknown[]>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: T) => unknown
  ): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, secured(handler))
  }

  register(IPC.snapshot, () => controller.snapshot())
  register(IPC.settingsGet, () => controller.settingsView())
  register(IPC.settingsPatch, (_event, patch: Partial<AppSettings>) => {
    assertRecord(patch)
    return controller.patchSettings(patch)
  })
  register(IPC.settingsSecrets, (_event, input: UpdateSecretInput) => {
    assertRecord(input)
    return controller.updateSecrets(input)
  })
  register(IPC.dshStart, () => controller.startDsh())
  register(IPC.dshStop, () => controller.stopDsh())
  register(IPC.dshRestart, () => controller.restartDsh())
  register(IPC.dshOpenExternal, () => controller.openDshExternal())
  register(IPC.updateCheck, () => controller.checkUpdates())
  register(IPC.updateInstall, () => controller.installAppUpdate())
  register(IPC.dshUpdateCheck, () => controller.checkDshUpdates())
  register(IPC.dshUpdateInstall, () => controller.installDshUpdate())
  register(IPC.networkCheck, () => controller.checkNetwork(true))
  register(IPC.trashItem, (_event, path: string) => {
    const value = assertString(path, 'path')
    return controller.trashItem(value)
  })
  register(IPC.openLogs, () => controller.openLogs())
  register(IPC.windowAction, (event, action: WindowAction) => {
    if (!WINDOW_ACTIONS.has(action)) throw new Error('unknown window action')
    controller.performWindowAction(event.sender.id, action)
  })
  register(IPC.showSettings, () => controller.showSettings())
  register(IPC.openMain, (_event, action?: OpenMainAction) => {
    if (action !== undefined && !OPEN_ACTIONS.has(action)) throw new Error('unknown open action')
    return controller.runOpenAction(action ?? 'open-main')
  })
  register(IPC.alertClose, () => controller.closeAlert())
  register(IPC.alertAction, (_event, action: OpenMainAction) => {
    if (!OPEN_ACTIONS.has(action)) throw new Error('unknown alert action')
    return controller.runOpenAction(action)
  })
}