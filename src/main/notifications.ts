import { Notification } from 'electron'
import { AppLogger } from './logger.js'
import type { AlertPayload } from '../shared/contracts.js'
import { AuxiliaryWindows } from './windows/auxiliary-windows.js'

export class NotificationService {
  constructor(
    private readonly windows: AuxiliaryWindows,
    private readonly logger: AppLogger,
    private readonly openMain: () => void
  ) {}

  bubble(title: string, body: string): void {
    if (!Notification.isSupported()) return
    const notification = new Notification({ title, body, silent: false })
    notification.on('click', this.openMain)
    notification.show()
  }

  alert(payload: AlertPayload): void {
    this.windows.showAlert(payload)
    this.logger.system(`Alert [${payload.kind}] ${payload.title}: ${payload.message}`)
  }
}

