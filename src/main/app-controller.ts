import { app, shell } from 'electron'
import { isAbsolute, join, parse } from 'node:path'
import type { AppSettings, BillingNetworkState, DesktopSnapshot, DshStatus, SettingsView, UpdateSecretInput, UpdateState, WindowAction, OpenMainAction } from '../shared/contracts'
import { SettingsStore } from './config/settings-store'
import { DshProcessManager } from './dsh/process-manager'
import { DshRuntimeManager } from './dsh/runtime-manager'
import { AppLogger } from './logger'
import { NotificationService } from './notifications'
import { applyLaunchAtLogin } from './platform/auto-launch'
import { BillingNetworkMonitor } from './platform/billing-network'
import { RegistryService } from './platform/registry'
import { verifyAuthenticode } from './platform/signature'
import { TrayController } from './tray/tray-controller'
import { AppUpdateManager } from './update/app-updater'
import { DshUpdateManager } from './update/dsh-updater'
import { errorMessage } from './utils'
import { AuxiliaryWindows } from './windows/auxiliary-windows'
import { MainWindowController } from './windows/main-window'

export class AppController {
  private quitting = false
  private previousPhase: DshStatus['phase'] = 'idle'
  private previousNetworkCost: BillingNetworkState['cost'] = 'unknown'
  private networkTimer: NodeJS.Timeout | null = null
  private updateTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly logger: AppLogger,
    private readonly store: SettingsStore,
    private readonly runtime: DshRuntimeManager,
    private readonly processManager: DshProcessManager,
    private readonly appUpdates: AppUpdateManager,
    private readonly dshUpdates: DshUpdateManager,
    private readonly network: BillingNetworkMonitor,
    private readonly registry: RegistryService,
    private readonly mainWindow: MainWindowController,
    private readonly auxiliary: AuxiliaryWindows,
    private readonly notifications: NotificationService,
    private readonly tray: TrayController
  ) {}

  get isQuitting(): boolean {
    return this.quitting
  }

  shouldCloseToTray(): boolean {
    return !this.quitting && this.store.value.closeToTray
  }

  shouldMinimizeToTray(): boolean {
    return !this.quitting && this.store.value.minimizeToTray
  }

  async start(showWindow: boolean): Promise<void> {
    const settings = this.store.value
    applyLaunchAtLogin(settings.launchAtLogin)
    await this.registry.ensureRegistered().catch((error: unknown) => {
      this.logger.stderr(`Registry integration failed: ${errorMessage(error)}`)
    })
    await this.verifySelfSignature()
    this.mainWindow.create(showWindow)
    this.tray.create()
    this.processManager.onStatus((status) => { this.handleDshStatus(status) })
    this.appUpdates.onState(() => { void this.refresh() })
    await this.refresh(true)
    void this.processManager.start().catch((error: unknown) => {
      this.notifications.alert({
        kind: 'danger',
        title: 'DeepSeek Harness 启动失败',
        message: errorMessage(error),
        actionLabel: '打开设置',
        action: 'open-settings'
      })
      void this.refresh()
    })
    this.networkTimer = setInterval(() => { void this.checkNetwork(false) }, 5 * 60_000)
    this.updateTimer = setTimeout(() => { void this.checkUpdates() }, 15_000)
  }

  snapshot(): Promise<DesktopSnapshot> {
    return this.createSnapshot()
  }

  settingsView(): SettingsView {
    const settings = this.store.value
    const secrets = this.store.secretValue
    return {
      settings,
      secrets: {
        hasDeepseekApiKey: secrets.deepseekApiKey !== '',
        deepseekBaseUrl: secrets.deepseekBaseUrl,
        hasGatewayApiKey: secrets.gatewayApiKey !== '',
        gatewayBaseUrl: secrets.gatewayBaseUrl,
        gatewayModel: secrets.gatewayModel,
        extraEnvironment: secrets.extraEnvironment
      },
      runtime: this.processManager.status.runtime
    }
  }

  async patchSettings(patch: Partial<AppSettings>): Promise<SettingsView> {
    const previous = this.store.value
    const next = await this.store.patch(patch)
    this.processManager.updateSettings(next)
    if (previous.launchAtLogin !== next.launchAtLogin) applyLaunchAtLogin(next.launchAtLogin)
    if (previous.updates.appFeedUrl !== next.updates.appFeedUrl) this.appUpdates.configure(next.updates.appFeedUrl)
    const dshChanged = JSON.stringify(previous.dsh) !== JSON.stringify(next.dsh)
    await this.refresh()
    if (dshChanged && (this.processManager.status.phase === 'running' || this.processManager.status.phase === 'degraded')) {
      void this.processManager.restart('settings changed').catch((error: unknown) => {
        this.logger.stderr(`Restart after settings change failed: ${errorMessage(error)}`)
      })
    }
    return this.settingsView()
  }

  async updateSecrets(input: UpdateSecretInput): Promise<SettingsView> {
    await this.store.patchSecrets({
      ...(input.deepseekApiKey === undefined ? {} : { deepseekApiKey: input.deepseekApiKey }),
      ...(input.deepseekBaseUrl === undefined ? {} : { deepseekBaseUrl: input.deepseekBaseUrl }),
      ...(input.gatewayApiKey === undefined ? {} : { gatewayApiKey: input.gatewayApiKey }),
      ...(input.gatewayBaseUrl === undefined ? {} : { gatewayBaseUrl: input.gatewayBaseUrl }),
      ...(input.gatewayModel === undefined ? {} : { gatewayModel: input.gatewayModel }),
      ...(input.extraEnvironment === undefined ? {} : { extraEnvironment: input.extraEnvironment }),
      ...(input.clearDeepseekApiKey === true ? { clearDeepseekApiKey: true } : {}),
      ...(input.clearGatewayApiKey === true ? { clearGatewayApiKey: true } : {})
    })
    if (this.processManager.status.phase === 'running' || this.processManager.status.phase === 'degraded') {
      void this.processManager.restart('credentials changed').catch((error: unknown) => {
        this.logger.stderr(`Restart after credential change failed: ${errorMessage(error)}`)
      })
    }
    return this.settingsView()
  }

  isTrustedWebContents(webContentsId: number): boolean {
    return this.mainWindow.trustedWebContentsIds.includes(webContentsId) || this.auxiliary.windowIds.includes(webContentsId)
  }

  async startDsh(): Promise<DshStatus> {
    return this.processManager.start()
  }

  async stopDsh(): Promise<DshStatus> {
    return this.processManager.stop()
  }

  async restartDsh(): Promise<DshStatus> {
    return this.processManager.restart()
  }

  async openDshExternal(): Promise<void> {
    const url = this.processManager.status.url
    if (url === null) throw new Error('DeepSeek Harness is not running')
    const parsed = new URL(url)
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') throw new Error('refusing to open a non-loopback URL')
    await shell.openExternal(url)
  }

  async checkUpdates(): Promise<UpdateState> {
    const [application, dsh] = await Promise.all([
      this.appUpdates.check(),
      this.dshUpdates.check(this.store.value)
    ])
    await this.refresh()
    if (application.phase === 'available' || dsh.phase === 'available') {
      const version = dsh.phase === 'available' ? dsh.version : application.version
      this.notifications.alert({
        kind: 'info',
        title: '发现可用更新',
        message: `新版本 ${version ?? ''} 已可用`,
        detail: dsh.phase === 'available' ? 'DeepSeek Harness 运行时更新将在服务重启后生效。' : '应用更新下载后可重启安装。',
        actionLabel: '打开设置',
        action: 'open-settings'
      })
    }
    return application
  }

  async installAppUpdate(): Promise<UpdateState> {
    const state = await this.appUpdates.install()
    await this.refresh()
    return state
  }

  async checkDshUpdates(): Promise<UpdateState> {
    const state = await this.dshUpdates.check(this.store.value)
    await this.refresh()
    return state
  }

  async installDshUpdate(): Promise<UpdateState> {
    const state = await this.dshUpdates.install(this.store.value)
    await this.refresh()
    return state
  }

  async checkNetwork(force = true): Promise<BillingNetworkState> {
    const network = await this.network.check(force)
    if (network.cost === 'metered' && this.previousNetworkCost !== 'metered' && this.store.value.notifications.onMeteredNetwork) {
      this.notifications.alert({
        kind: 'warning',
        title: '当前为计费网络',
        message: 'DeepSeek Harness 可能产生持续流量。',
        ...(network.interfaceName === null ? {} : { detail: `网络：${network.interfaceName}` }),
        actionLabel: '打开设置',
        action: 'open-settings'
      })
    }
    this.previousNetworkCost = network.cost
    await this.refresh()
    return network
  }

  async openLogs(): Promise<void> {
    await shell.openPath(join(app.getPath('userData'), 'logs'))
  }

  async trashItem(path: string): Promise<void> {
    if (!isAbsolute(path)) throw new Error('only absolute paths can be moved to the recycle bin')
    if (path === parse(path).root) throw new Error('refusing to move a drive root to the recycle bin')
    await shell.trashItem(path)
  }

  performWindowAction(webContentsId: number, action: WindowAction): void {
    if (this.mainWindow.trustedWebContentsIds.includes(webContentsId)) {
      this.mainWindow.performWindowAction(action)
      return
    }
    this.auxiliary.performWindowAction(webContentsId, action)
  }

  showMain(): void {
    this.mainWindow.show()
  }

  toggleMain(): void {
    this.mainWindow.toggle()
  }

  showSettings(): void {
    this.auxiliary.showSettings()
  }

  closeAlert(): void {
    this.auxiliary.closeAlert()
  }

  async runOpenAction(action: OpenMainAction): Promise<void> {
    switch (action) {
      case 'open-main': this.showMain(); return
      case 'restart-dsh': await this.restartDsh(); this.showMain(); return
      case 'open-settings': this.showSettings(); return
      case 'check-updates': await this.checkUpdates(); this.showSettings(); return
    }
  }

  async quit(): Promise<void> {
    if (this.quitting) return
    this.quitting = true
    if (this.networkTimer !== null) clearInterval(this.networkTimer)
    if (this.updateTimer !== null) clearTimeout(this.updateTimer)
    this.tray.destroy()
    this.mainWindow.destroy()
    await this.processManager.dispose()
    app.quit()
  }

  private async verifySelfSignature(): Promise<void> {
    const thumbprint = this.store.value.security.windowsPublisherThumbprint
    if (thumbprint === '') return
    const result = await verifyAuthenticode(process.execPath, thumbprint)
    this.logger.system(`Application signature check: ${result.status} — ${result.message}`)
    if (result.status === 'invalid') {
      this.notifications.alert({
        kind: 'danger',
        title: '应用签名校验失败',
        message: result.message,
        detail: '请停止运行并从可信发行渠道重新安装应用。',
        actionLabel: '打开设置',
        action: 'open-settings'
      })
    }
  }

  private handleDshStatus(status: DshStatus): void {
    const previous = this.previousPhase
    this.previousPhase = status.phase
    if (status.phase === 'running' && previous !== 'running' && this.store.value.notifications.onStart) {
      this.notifications.bubble('DeepSeek Harness 已就绪', `本地服务运行在 ${status.url ?? '127.0.0.1'}`)
    }
    if ((status.phase === 'crashed' || status.phase === 'error') && previous !== 'crashed' && previous !== 'error') {
      if (this.store.value.notifications.onCrash) {
        this.notifications.alert({
          kind: 'danger',
          title: 'DeepSeek Harness 服务异常',
          message: status.message,
          detail: status.phase === 'crashed' ? '守护进程将按策略尝试自动恢复。' : '请检查设置或运行日志。',
          actionLabel: '重启服务',
          action: 'restart-dsh'
        })
      }
    }
    void this.refresh()
  }

  private async createSnapshot(): Promise<DesktopSnapshot> {
    const network = await this.network.check(false)
    return {
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      installPath: process.execPath,
      userDataPath: app.getPath('userData'),
      dsh: this.processManager.status,
      update: this.appUpdates.value,
      dshUpdate: this.dshUpdates.value,
      network,
      logs: this.logger.snapshot().slice(-200)
    }
  }

  private async refresh(forceNetwork = false): Promise<void> {
    if (forceNetwork) await this.network.check(false)
    const snapshot = await this.createSnapshot()
    this.mainWindow.update(snapshot)
    this.tray.update(snapshot.dsh, snapshot.update, snapshot.network)
  }
}

