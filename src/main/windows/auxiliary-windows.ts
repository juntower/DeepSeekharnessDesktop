import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AlertPayload, WindowAction } from '../../shared/contracts'

const currentDirectory = fileURLToPath(new URL('.', import.meta.url))

function rendererTarget(page: string): string {
  const development = process.env.ELECTRON_RENDERER_URL
  if (development !== undefined && development !== '') return `${development}/${page}/index.html`
  return join(currentDirectory, '..', 'renderer', page, 'index.html')
}

export class AuxiliaryWindows {
  private alert: BrowserWindow | null = null
  private settings: BrowserWindow | null = null

  constructor(private readonly preloadPath: string) {}

  showAlert(payload: AlertPayload): void {
    if (this.alert !== null && !this.alert.isDestroyed()) {
      this.alert.destroy()
      this.alert = null
    }
    const display = screen.getPrimaryDisplay()
    const width = 390
    const height = payload.detail === undefined ? 184 : 214
    const x = display.workArea.x + display.workArea.width - width - 18
    const y = display.workArea.y + display.workArea.height - height - 18
    const window = new BrowserWindow({
      width,
      height,
      x,
      y,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      show: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#111512',
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    this.alert = window
    window.on('closed', () => { if (this.alert === window) this.alert = null })
    const payloadValue = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    const target = rendererTarget('alert')
    if (/^https?:/u.test(target)) void window.loadURL(`${target}?payload=${payloadValue}`)
    else void window.loadFile(target, { query: { payload: payloadValue } })
    window.once('ready-to-show', () => { window.showInactive() })
  }

  showSettings(): void {
    if (this.settings !== null && !this.settings.isDestroyed()) {
      this.settings.show()
      this.settings.focus()
      return
    }
    const window = new BrowserWindow({
      width: 920,
      height: 720,
      minWidth: 760,
      minHeight: 620,
      frame: false,
      show: false,
      backgroundColor: '#0f1211',
      title: 'DeepSeek Harness Desktop Settings',
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    this.settings = window
    window.on('closed', () => { if (this.settings === window) this.settings = null })
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/u.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    const target = rendererTarget('settings')
    if (/^https?:/u.test(target)) void window.loadURL(target)
    else void window.loadFile(target)
    window.once('ready-to-show', () => { window.show() })
  }

  closeAlert(): void {
    if (this.alert !== null && !this.alert.isDestroyed()) this.alert.close()
    this.alert = null
  }

  performWindowAction(webContentsId: number, action: WindowAction): void {
    const target = [this.alert, this.settings].find((window) => (
      window !== null && !window.isDestroyed() && window.webContents.id === webContentsId
    ))
    if (target === null || target === undefined) return
    switch (action) {
      case 'minimize': target.minimize(); return
      case 'maximize': target.isMaximized() ? target.unmaximize() : target.maximize(); return
      case 'close': target.close(); return
      case 'close-to-tray': target.hide(); return
    }
  }
  get windowIds(): number[] {
    return [this.alert?.webContents.id, this.settings?.webContents.id]
      .filter((id): id is number => typeof id === 'number')
  }
}
