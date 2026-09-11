import { app } from 'electron'

export function applyLaunchAtLogin(enabled: boolean): void {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
    args: enabled ? ['--hidden'] : []
  })
}

export function launchAtLoginEnabled(): boolean {
  return app.getLoginItemSettings({ path: process.execPath, args: ['--hidden'] }).openAtLogin
}
