import { BaseWindow, WebContentsView, shell, type Session } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DesktopSnapshot, WindowAction } from '../../shared/contracts'

const currentDirectory = fileURLToPath(new URL('.', import.meta.url))
const SHELL_HEIGHT = 58

function rendererUrl(page: string): string {
  const development = process.env.ELECTRON_RENDERER_URL
  if (development !== undefined && development !== '') return `${development}/${page}/index.html`
  return join(currentDirectory, '..', 'renderer', page, 'index.html')
}

export interface MainWindowOptions {
  preloadPath: string
  closeToTray: () => boolean
  minimizeToTray: () => boolean
  isQuitting: () => boolean
  requestQuit: () => void
}

export class MainWindowController {
  private window: BaseWindow | null = null
  private shellView: WebContentsView | null = null
  private serviceView: WebContentsView | null = null
  private currentServiceUrl: string | null = null
  private latestSnapshot: DesktopSnapshot | null = null

  constructor(private readonly options: MainWindowOptions) {}

  get isOpen(): boolean {
    return this.window !== null && !this.window.isDestroyed()
  }

  get trustedWebContentsIds(): number[] {
    const id = this.shellView?.webContents.id
    return id === undefined ? [] : [id]
  }

  create(show: boolean): void {
    if (this.isOpen) {
      if (show) this.show()
      return
    }
    const window = new BaseWindow({
      width: 1320,
      height: 860,
      minWidth: 900,
      minHeight: 620,
      show: false,
      frame: false,
      backgroundColor: '#0d100f',
      title: 'DeepSeek Harness Desktop'
    })
    const shellView = new WebContentsView({
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    const serviceView = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: 'persist:dsh-web'
      }
    })
    window.contentView.addChildView(shellView)
    window.contentView.addChildView(serviceView)
    this.window = window
    this.shellView = shellView
    this.serviceView = serviceView
    this.configureServiceView(serviceView)
    const layout = (): void => {
      if (window.isDestroyed()) return
      const size = window.getContentSize()
      const width = size[0] ?? 0
      const height = size[1] ?? 0
      shellView.setBounds({ x: 0, y: 0, width, height: SHELL_HEIGHT })
      serviceView.setBounds({ x: 0, y: SHELL_HEIGHT, width, height: Math.max(0, height - SHELL_HEIGHT) })
    }
    layout()
    window.on('resize', layout)
    window.on('close', (event) => {
      if (this.options.closeToTray()) {
        event.preventDefault()
        this.hide()
        return
      }
      if (!this.options.isQuitting()) {
        event.preventDefault()
        this.options.requestQuit()
      }
    })
    window.on('closed', () => {
      this.window = null
      this.shellView = null
      this.serviceView = null
      this.currentServiceUrl = null
    })
    shellView.webContents.once('did-finish-load', () => {
      if (this.latestSnapshot !== null) this.sendSnapshot(this.latestSnapshot)
      if (show && !window.isDestroyed()) window.show()
    })
    void this.loadRenderer(shellView, 'shell')
    void this.loadServicePlaceholder('starting', '正在准备 DeepSeek Harness 运行时…')
  }

  show(): void {
    if (!this.isOpen) this.create(true)
    this.window?.show()
    this.window?.focus()
  }

  hide(): void {
    this.window?.hide()
  }

  toggle(): void {
    if (!this.isOpen) {
      this.create(true)
      return
    }
    if (this.window?.isVisible()) this.hide()
    else this.show()
  }

  focus(): void {
    if (!this.isOpen) {
      this.create(true)
      return
    }
    if (this.window?.isMinimized()) this.window.restore()
    this.window?.show()
    this.window?.focus()
  }

  performWindowAction(action: WindowAction): void {
    const window = this.window
    if (window === null || window.isDestroyed()) return
    switch (action) {
      case 'minimize':
        if (this.options.minimizeToTray()) this.hide()
        else window.minimize()
        return
      case 'maximize': window.isMaximized() ? window.unmaximize() : window.maximize(); return
      case 'close': window.close(); return
      case 'close-to-tray': this.hide(); return
    }
  }

  update(snapshot: DesktopSnapshot): void {
    this.latestSnapshot = structuredClone(snapshot)
    this.sendSnapshot(snapshot)
    if (snapshot.dsh.phase === 'running') {
      if (snapshot.dsh.url !== null && this.currentServiceUrl !== snapshot.dsh.url) {
        this.currentServiceUrl = snapshot.dsh.url
        void this.serviceView?.webContents.loadURL(snapshot.dsh.url)
      }
      return
    }
    if (snapshot.dsh.phase === 'degraded') return
    if (snapshot.dsh.phase === 'crashed' || snapshot.dsh.phase === 'error') {
      void this.loadServicePlaceholder('error', snapshot.dsh.message)
      return
    }
    if (snapshot.dsh.phase === 'installing' || snapshot.dsh.phase === 'starting' || snapshot.dsh.phase === 'restarting') {
      void this.loadServicePlaceholder(snapshot.dsh.phase, snapshot.dsh.message)
    }
  }

  destroy(): void {
    if (this.window !== null && !this.window.isDestroyed()) this.window.destroy()
    this.window = null
    this.shellView = null
    this.serviceView = null
  }

  private sendSnapshot(snapshot: DesktopSnapshot): void {
    if (this.shellView !== null && !this.shellView.webContents.isDestroyed()) {
      this.shellView.webContents.send('desktop:state-changed', snapshot)
    }
  }

  private async loadRenderer(view: WebContentsView, page: string): Promise<void> {
    const target = rendererUrl(page)
    if (/^https?:/u.test(target)) await view.webContents.loadURL(target)
    else await view.webContents.loadFile(target)
  }

  private async loadServicePlaceholder(phase: string, message: string): Promise<void> {
    const view = this.serviceView
    if (view === null || view.webContents.isDestroyed()) return
    const development = process.env.ELECTRON_RENDERER_URL
    const target = development !== undefined && development !== ''
      ? `${development}/service/index.html`
      : rendererUrl('service')
    const placeholderKey = `${target}?phase=${encodeURIComponent(phase)}&message=${encodeURIComponent(message)}`
    if (this.currentServiceUrl === placeholderKey) return
    this.currentServiceUrl = placeholderKey
    if (/^https?:/u.test(target)) {
      const url = new URL(target)
      url.searchParams.set('phase', phase)
      url.searchParams.set('message', message)
      await view.webContents.loadURL(url.toString()).catch(() => undefined)
    } else {
      await view.webContents.loadFile(target, { query: { phase, message } }).catch(() => undefined)
    }
  }

  private configureServiceView(view: WebContentsView): void {
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/u.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    view.webContents.on('will-navigate', (event, url) => {
      try {
        const target = new URL(url)
        if ((target.hostname === '127.0.0.1' || target.hostname === 'localhost') && target.protocol === 'http:') return
      } catch {
        // fall through
      }
      event.preventDefault()
      if (/^https?:/u.test(url)) void shell.openExternal(url)
    })
    view.webContents.on('did-fail-load', (_event, code, description, validatedURL) => {
      if (validatedURL.startsWith('http')) {
        void this.loadServicePlaceholder('error', `页面加载失败：${description} (${String(code)})`)
      }
    })
    const session = view.webContents.session as Session
    session.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(permission === 'clipboard-sanitized-write' || permission === 'notifications')
    })
  }
}
