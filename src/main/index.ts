import { app, dialog } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppController } from './app-controller'
import { SettingsStore } from './config/settings-store'
import { DshProcessManager } from './dsh/process-manager'
import { DshRuntimeManager } from './dsh/runtime-manager'
import { registerIpc } from './ipc/register'
import { AppLogger } from './logger'
import { NotificationService } from './notifications'
import { BillingNetworkMonitor } from './platform/billing-network'
import { RegistryService } from './platform/registry'
import { TrayController } from './tray/tray-controller'
import { AppUpdateManager } from './update/app-updater'
import { DshUpdateManager } from './update/dsh-updater'
import { AuxiliaryWindows } from './windows/auxiliary-windows'
import { MainWindowController } from './windows/main-window'

const PROTOCOL = 'deepseek-harness'
const currentDirectory = fileURLToPath(new URL('.', import.meta.url))
const appRoot = app.getAppPath()

/**
 * Surface a failure that happened before the logger and windows exist. Without this the process
 * would keep running with no tray icon, no window and no visible reason.
 */
function reportFatal(stage: string, reason: unknown): void {
  const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
  console.error(`[${stage}] ${detail}`)
  try {
    dialog.showErrorBox('DeepSeek Harness Desktop 启动失败', `${stage}\n\n${detail}`)
  } catch {
    // The dialog is best effort: never let reporting become the failure.
  }
}

process.on('uncaughtException', (error) => { reportFatal('uncaughtException', error) })
process.on('unhandledRejection', (reason) => { reportFatal('unhandledRejection', reason) })

function resolvePreloadPath(): string {
  const candidates = [
    join(currentDirectory, '..', 'preload', 'index.mjs'),
    join(currentDirectory, '..', 'preload', 'index.js'),
    join(currentDirectory, '..', 'preload', 'index.cjs')
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found === undefined) throw new Error(`preload script is missing; checked ${candidates.join(', ')}`)
  return found
}

function registerProtocol(): void {
  if (process.defaultApp && process.argv[1] !== undefined) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [process.argv[1]])
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL)
  }
}

function protocolFromArguments(args: string[]): string | null {
  return args.find((argument) => argument.toLowerCase().startsWith(`${PROTOCOL}://`)) ?? null
}

let controller: AppController | null = null
let pendingProtocol: string | null = protocolFromArguments(process.argv)
let quitting = false

function handleProtocol(url: string): void {
  if (controller === null) {
    pendingProtocol = url
    return
  }
  let action = 'open'
  try {
    const parsed = new URL(url)
    action = (parsed.hostname || parsed.pathname.replace(/^\/+/u, '') || 'open').toLowerCase()
  } catch {
    action = 'open'
  }
  if (action === 'settings') {
    controller.showSettings()
    return
  }
  if (action === 'restart') {
    void controller.restartDsh().finally(() => { controller?.showMain() })
    return
  }
  if (action === 'start') {
    void controller.startDsh().finally(() => { controller?.showMain() })
    return
  }
  controller.showMain()
}

async function boot(): Promise<void> {
  const userData = app.getPath('userData')
  const settings = new SettingsStore(join(userData, 'settings.json'), join(userData, 'secrets.json'))
  await settings.load()

  const logger = new AppLogger(userData)
  const runtimeRoot = app.isPackaged ? process.resourcesPath : join(appRoot, 'build')
  const assetPath = app.isPackaged ? join(process.resourcesPath, 'assets') : join(appRoot, 'resources')
  const preloadPath = resolvePreloadPath()
  const runtime = new DshRuntimeManager(userData, runtimeRoot, !app.isPackaged, logger)
  const processManager = new DshProcessManager(settings.value, runtime, logger, userData, () => settings.secretValue)
  const applicationUpdates = new AppUpdateManager(settings.value.updates.appFeedUrl, logger)
  const dshUpdates = new DshUpdateManager(runtime, processManager, logger)
  const network = new BillingNetworkMonitor()
  const registry = new RegistryService(process.execPath)
  const auxiliary = new AuxiliaryWindows(preloadPath)

  const mainWindow = new MainWindowController({
    preloadPath,
    closeToTray: () => controller?.shouldCloseToTray() ?? true,
    minimizeToTray: () => controller?.shouldMinimizeToTray() ?? true,
    isQuitting: () => controller?.isQuitting ?? quitting,
    requestQuit: () => { void controller?.quit() }
  })

  const notifications = new NotificationService(auxiliary, logger, () => { controller?.showMain() })
  const tray = new TrayController(assetPath, {
    toggleMain: () => { controller?.toggleMain() },
    startDsh: () => { void controller?.startDsh().catch((error: unknown) => { logger.stderr(String(error)) }) },
    stopDsh: () => { void controller?.stopDsh().catch((error: unknown) => { logger.stderr(String(error)) }) },
    restartDsh: () => { void controller?.restartDsh().catch((error: unknown) => { logger.stderr(String(error)) }) },
    checkUpdates: () => { void controller?.checkUpdates().catch((error: unknown) => { logger.stderr(String(error)) }) },
    showSettings: () => { controller?.showSettings() },
    quit: () => { void controller?.quit() }
  })

  controller = new AppController(
    logger,
    settings,
    runtime,
    processManager,
    applicationUpdates,
    dshUpdates,
    network,
    registry,
    mainWindow,
    auxiliary,
    notifications,
    tray
  )
  registerIpc(controller)

  const hidden = process.argv.includes('--hidden') || process.argv.includes('--background')
  const showWindow = !hidden && !settings.value.startMinimized
  await controller.start(showWindow)

  if (pendingProtocol !== null) {
    handleProtocol(pendingProtocol)
    pendingProtocol = null
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.setAppUserModelId('ai.deepseek.harness.desktop')

  app.on('second-instance', (_event, argv) => {
    const protocol = protocolFromArguments(argv)
    if (protocol !== null) handleProtocol(protocol)
    else controller?.showMain()
  })

  app.on('window-all-closed', () => {
    // Tray-resident by design. Explicit tray Exit performs disposal and quits.
  })

  app.on('before-quit', (event) => {
    if (quitting || controller === null || controller.isQuitting) return
    event.preventDefault()
    quitting = true
    void controller.quit()
  })

  app.on('activate', () => { controller?.showMain() })

  app.whenReady().then(async () => {
    registerProtocol()
    try {
      await boot()
    } catch (error) {
      reportFatal('boot', error)
      app.exit(1)
    }
  }).catch((error: unknown) => {
    reportFatal('whenReady', error)
    app.exit(1)
  })
}
