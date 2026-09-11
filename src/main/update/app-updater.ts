import { app } from 'electron'
import electronUpdater from 'electron-updater'
import type { ProgressInfo } from 'electron-updater'
import type { UpdateState } from '../../shared/contracts'
import { AppLogger } from '../logger'
import { errorMessage } from '../utils'

// electron-updater ships CommonJS with lazy getters, so a named ESM import fails while the
// main process is being loaded. Destructure the default (module.exports) binding instead.
const { autoUpdater } = electronUpdater

type StateListener = (state: UpdateState) => void

const INITIAL: UpdateState = {
  phase: 'idle',
  version: null,
  percent: null,
  message: 'Update check has not run yet'
}

export class AppUpdateManager {
  private state: UpdateState = structuredClone(INITIAL)
  private readonly listeners = new Set<StateListener>()

  constructor(private feedUrl: string, private readonly logger: AppLogger) {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('checking-for-update', () => { this.setState({ phase: 'checking', message: 'Checking for application updates…' }) })
    autoUpdater.on('update-available', (info) => {
      this.setState({ phase: 'available', version: info.version, percent: null, message: `Version ${info.version} is available` })
    })
    autoUpdater.on('update-not-available', () => {
      this.setState({ phase: 'current', version: app.getVersion(), percent: null, message: 'This application is up to date' })
    })
    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      this.setState({ phase: 'downloading', percent: Math.round(progress.percent), message: `Downloading update… ${String(Math.round(progress.percent))}%` })
    })
    autoUpdater.on('update-downloaded', (info) => {
      this.setState({ phase: 'downloaded', version: info.version, percent: 100, message: `Version ${info.version} is ready to install` })
    })
    autoUpdater.on('error', (error) => {
      this.logger.stderr(`Application updater: ${error.message}`)
      this.setState({ phase: 'error', percent: null, message: error.message })
    })
  }

  get value(): UpdateState {
    return structuredClone(this.state)
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  configure(feedUrl: string): void {
    this.feedUrl = feedUrl.trim()
  }

  async check(): Promise<UpdateState> {
    if (!app.isPackaged || this.feedUrl === '' || this.feedUrl.includes('example.invalid')) {
      this.setState({
        phase: 'disabled',
        version: null,
        percent: null,
        message: 'Application updates are disabled until a release feed URL is configured'
      })
      return this.value
    }
    try {
      autoUpdater.setFeedURL({ provider: 'generic', url: this.feedUrl })
      this.setState({ phase: 'checking', message: 'Checking for application updates…' })
      await autoUpdater.checkForUpdates()
    } catch (error) {
      this.setState({ phase: 'error', percent: null, message: errorMessage(error) })
    }
    return this.value
  }

  async install(): Promise<UpdateState> {
    if (this.state.phase === 'disabled') return this.value
    try {
      if (this.state.phase !== 'downloaded') {
        this.setState({ phase: 'downloading', percent: 0, message: 'Downloading application update…' })
        await autoUpdater.downloadUpdate()
      }
      setImmediate(() => { autoUpdater.quitAndInstall(false, true) })
    } catch (error) {
      this.setState({ phase: 'error', percent: null, message: errorMessage(error) })
    }
    return this.value
  }

  private setState(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener(this.value)
  }
}
