import { Menu, Tray, nativeImage } from 'electron'
import { join } from 'node:path'
import type { BillingNetworkState, DshStatus, UpdateState } from '../../shared/contracts'

export interface TrayActions {
  toggleMain(): void
  startDsh(): void
  stopDsh(): void
  restartDsh(): void
  checkUpdates(): void
  showSettings(): void
  quit(): void
}

export class TrayController {
  private tray: Tray | null = null
  private animationTimer: NodeJS.Timeout | null = null
  private animationFrame = 0
  private status: DshStatus | null = null
  private updateState: UpdateState | null = null
  private network: BillingNetworkState | null = null

  constructor(
    private readonly assetPath: string,
    private readonly actions: TrayActions
  ) {}

  create(): void {
    this.tray = new Tray(this.image('tray-idle.png'))
    this.tray.setToolTip('DeepSeek Harness Desktop')
    this.tray.on('click', () => { this.actions.toggleMain() })
    this.tray.on('double-click', () => { this.actions.toggleMain() })
    this.rebuildMenu()
  }

  update(status: DshStatus, update: UpdateState, network: BillingNetworkState): void {
    this.status = structuredClone(status)
    this.updateState = structuredClone(update)
    this.network = structuredClone(network)
    this.applyAnimation()
    this.rebuildMenu()
  }

  destroy(): void {
    if (this.animationTimer !== null) clearInterval(this.animationTimer)
    this.animationTimer = null
    this.tray?.destroy()
    this.tray = null
  }

  private applyAnimation(): void {
    const animated = this.status?.phase === 'installing'
      || this.status?.phase === 'starting'
      || this.status?.phase === 'restarting'
      || this.status?.phase === 'stopping'
    if (animated && this.animationTimer === null) {
      this.animationTimer = setInterval(() => {
        this.animationFrame = (this.animationFrame + 1) % 3
        this.tray?.setImage(this.image(`tray-busy-${String(this.animationFrame + 1)}.png`))
      }, 420)
      return
    }
    if (!animated && this.animationTimer !== null) {
      clearInterval(this.animationTimer)
      this.animationTimer = null
    }
    if (!animated) this.tray?.setImage(this.image(this.iconForStatus()))
  }

  private iconForStatus(): string {
    switch (this.status?.phase) {
      case 'running': return 'tray-running.png'
      case 'degraded':
      case 'crashed':
      case 'restarting': return 'tray-warning.png'
      case 'error': return 'tray-error.png'
      default: return 'tray-idle.png'
    }
  }

  private image(name: string) {
    const image = nativeImage.createFromPath(join(this.assetPath, name))
    return image.isEmpty() ? nativeImage.createEmpty() : image
  }

  private rebuildMenu(): void {
    if (this.tray === null) return
    const status = this.status
    const running = status?.phase === 'running' || status?.phase === 'degraded'
    const phaseLabel: Record<string, string> = {
      idle: '未启动',
      installing: '正在安装运行时',
      starting: '正在启动',
      running: '运行中',
      degraded: '运行异常',
      restarting: '正在重启',
      stopping: '正在停止',
      stopped: '已停止',
      crashed: '已崩溃',
      error: '错误'
    }
    const statusLine = status === null
      ? '服务状态：初始化中'
      : `服务状态：${phaseLabel[status.phase] ?? status.phase}${status.port === null ? '' : ` · ${String(status.port)}`}`
    const networkLine = this.network?.cost === 'metered'
      ? `计费网络：是${this.network.interfaceName === null ? '' : ` · ${this.network.interfaceName}`}`
      : this.network?.cost === 'unrestricted'
        ? '计费网络：否'
        : '计费网络：未知'
    const versionLine = status?.runtime === null || status?.runtime === undefined
      ? 'Harness：未安装'
      : `Harness：${status.runtime.version}`
    const updateLine = this.updateState?.phase === 'available' && this.updateState.version !== null
      ? `发现更新：${this.updateState.version}`
      : '检查更新…'

    const menu = Menu.buildFromTemplate([
      { label: '打开 DeepSeek Harness', click: () => { this.actions.toggleMain() } },
      { type: 'separator' },
      { label: statusLine, enabled: false },
      { label: versionLine, enabled: false },
      { label: networkLine, enabled: false },
      { type: 'separator' },
      running
        ? { label: '重启服务', click: () => { this.actions.restartDsh() } }
        : { label: '启动服务', enabled: status?.phase !== 'installing' && status?.phase !== 'starting', click: () => { this.actions.startDsh() } },
      { label: '停止服务', enabled: running || status?.phase === 'starting', click: () => { this.actions.stopDsh() } },
      { type: 'separator' },
      { label: updateLine, click: () => { this.actions.checkUpdates() } },
      { label: '设置…', click: () => { this.actions.showSettings() } },
      { type: 'separator' },
      { label: '退出', click: () => { this.actions.quit() } }
    ])
    this.tray.setContextMenu(menu)
    this.tray.setToolTip(`DeepSeek Harness Desktop\n${statusLine}\n${networkLine}`)
  }
}
