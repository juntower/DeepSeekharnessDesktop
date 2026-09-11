import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type BillingNetworkState,
  type DesktopApi,
  type DesktopSnapshot,
  type DshStatus,
  type OpenMainAction,
  type SettingsView,
  type UpdateSecretInput,
  type UpdateState,
  type WindowAction,
  type AppSettings
} from '../shared/contracts'

const api: DesktopApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC.snapshot) as Promise<DesktopSnapshot>,
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet) as Promise<SettingsView>,
  patchSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke(IPC.settingsPatch, patch) as Promise<SettingsView>,
  updateSecrets: (input: UpdateSecretInput) => ipcRenderer.invoke(IPC.settingsSecrets, input) as Promise<SettingsView>,
  startDsh: () => ipcRenderer.invoke(IPC.dshStart) as Promise<DshStatus>,
  stopDsh: () => ipcRenderer.invoke(IPC.dshStop) as Promise<DshStatus>,
  restartDsh: () => ipcRenderer.invoke(IPC.dshRestart) as Promise<DshStatus>,
  openDshExternal: () => ipcRenderer.invoke(IPC.dshOpenExternal) as Promise<void>,
  checkUpdates: () => ipcRenderer.invoke(IPC.updateCheck) as Promise<UpdateState>,
  installUpdate: () => ipcRenderer.invoke(IPC.updateInstall) as Promise<UpdateState>,
  checkDshUpdates: () => ipcRenderer.invoke(IPC.dshUpdateCheck) as Promise<UpdateState>,
  installDshUpdate: () => ipcRenderer.invoke(IPC.dshUpdateInstall) as Promise<UpdateState>,
  checkNetwork: () => ipcRenderer.invoke(IPC.networkCheck) as Promise<BillingNetworkState>,
  trashItem: (path: string) => ipcRenderer.invoke(IPC.trashItem, path) as Promise<void>,
  openLogs: () => ipcRenderer.invoke(IPC.openLogs) as Promise<void>,
  windowAction: (action: WindowAction) => ipcRenderer.invoke(IPC.windowAction, action) as Promise<void>,
  showSettings: () => ipcRenderer.invoke(IPC.showSettings) as Promise<void>,
  openMain: (action?: OpenMainAction) => ipcRenderer.invoke(IPC.openMain, action) as Promise<void>,
  closeAlert: () => ipcRenderer.invoke(IPC.alertClose) as Promise<void>,
  runAlertAction: (action: NonNullable<OpenMainAction>) => ipcRenderer.invoke(IPC.alertAction, action) as Promise<void>,
  onSnapshot: (listener: (snapshot: DesktopSnapshot) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, snapshot: DesktopSnapshot): void => { listener(snapshot) }
    ipcRenderer.on(IPC.stateChanged, wrapped)
    return () => { ipcRenderer.removeListener(IPC.stateChanged, wrapped) }
  }
}

contextBridge.exposeInMainWorld('desktop', api)