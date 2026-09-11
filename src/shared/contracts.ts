export type DshPhase =
  | 'idle'
  | 'installing'
  | 'starting'
  | 'running'
  | 'degraded'
  | 'restarting'
  | 'stopping'
  | 'stopped'
  | 'crashed'
  | 'error'

export type NetworkCost = 'unrestricted' | 'metered' | 'unknown'

export interface DshRuntimeInfo {
  version: string
  channel: string
  entry: string
  node: string
  projectDir: string
  installedAt: string
}

export interface DshStatus {
  phase: DshPhase
  port: number | null
  url: string | null
  pid: number | null
  startedAt: string | null
  lastHealthyAt: string | null
  restartsInWindow: number
  consecutiveHealthFailures: number
  message: string
  runtime: DshRuntimeInfo | null
}

export interface LogEntry {
  at: string
  stream: 'system' | 'stdout' | 'stderr'
  message: string
}

export interface UpdateState {
  phase: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'current' | 'disabled' | 'error'
  version: string | null
  percent: number | null
  message: string
}

export interface BillingNetworkState {
  cost: NetworkCost
  checkedAt: string
  interfaceName: string | null
}

export interface AppSettings {
  version: 1
  launchAtLogin: boolean
  startMinimized: boolean
  closeToTray: boolean
  minimizeToTray: boolean
  dsh: {
    managed: boolean
    channel: 'latest' | 'next' | 'alpha'
    pinnedVersion: string | null
    preferredPort: number
    autoInstall: boolean
    autoRestart: boolean
    maxRestarts: number
    restartWindowMinutes: number
    healthIntervalSeconds: number
    startupTimeoutSeconds: number
    gracefulStopSeconds: number
    extraArgs: string[]
  }
  notifications: {
    onStart: boolean
    onCrash: boolean
    onMeteredNetwork: boolean
    onUpdate: boolean
  }
  updates: {
    appFeedUrl: string
    dshAutoCheck: boolean
  }
  security: {
    windowsPublisherThumbprint: string
  }
}

export interface SecretSettings {
  deepseekApiKey: string
  deepseekBaseUrl: string
  gatewayApiKey: string
  gatewayBaseUrl: string
  gatewayModel: string
  extraEnvironment: Record<string, string>
}

export interface SettingsView {
  settings: AppSettings
  secrets: {
    hasDeepseekApiKey: boolean
    deepseekBaseUrl: string
    hasGatewayApiKey: boolean
    gatewayBaseUrl: string
    gatewayModel: string
    extraEnvironment: Record<string, string>
  }
  runtime: DshRuntimeInfo | null
}

export interface DesktopSnapshot {
  appVersion: string
  platform: string
  arch: string
  installPath: string
  userDataPath: string
  dsh: DshStatus
  update: UpdateState
  dshUpdate: UpdateState
  network: BillingNetworkState
  logs: LogEntry[]
}

export interface AlertPayload {
  kind: 'info' | 'warning' | 'danger' | 'success'
  title: string
  message: string
  detail?: string
  actionLabel?: string
  action?: 'open-main' | 'restart-dsh' | 'open-settings' | 'check-updates'
}

export interface UpdateSecretInput {
  deepseekApiKey?: string
  clearDeepseekApiKey?: boolean
  deepseekBaseUrl?: string
  gatewayApiKey?: string
  clearGatewayApiKey?: boolean
  gatewayBaseUrl?: string
  gatewayModel?: string
  extraEnvironment?: Record<string, string>
}

export const IPC = {
  snapshot: 'desktop:snapshot',
  settingsGet: 'desktop:settings:get',
  settingsPatch: 'desktop:settings:patch',
  settingsSecrets: 'desktop:settings:secrets',
  dshStart: 'desktop:dsh:start',
  dshStop: 'desktop:dsh:stop',
  dshRestart: 'desktop:dsh:restart',
  dshOpenExternal: 'desktop:dsh:open-external',
  updateCheck: 'desktop:update:check',
  updateInstall: 'desktop:update:install',
  dshUpdateCheck: 'desktop:dsh-update:check',
  dshUpdateInstall: 'desktop:dsh-update:install',
  networkCheck: 'desktop:network:check',
  trashItem: 'desktop:trash-item',
  openLogs: 'desktop:logs:open',
  windowAction: 'desktop:window:action',
  alertClose: 'desktop:alert:close',
  alertAction: 'desktop:alert:action',
  showSettings: 'desktop:show-settings',
  openMain: 'desktop:open-main',
  stateChanged: 'desktop:state-changed'
} as const

export type WindowAction = 'minimize' | 'maximize' | 'close' | 'close-to-tray'
export type OpenMainAction = 'open-main' | 'restart-dsh' | 'open-settings' | 'check-updates'

export interface DesktopApi {
  getSnapshot(): Promise<DesktopSnapshot>
  getSettings(): Promise<SettingsView>
  patchSettings(patch: Partial<AppSettings>): Promise<SettingsView>
  updateSecrets(input: UpdateSecretInput): Promise<SettingsView>
  startDsh(): Promise<DshStatus>
  stopDsh(): Promise<DshStatus>
  restartDsh(): Promise<DshStatus>
  openDshExternal(): Promise<void>
  checkUpdates(): Promise<UpdateState>
  installUpdate(): Promise<UpdateState>
  checkDshUpdates(): Promise<UpdateState>
  installDshUpdate(): Promise<UpdateState>
  checkNetwork(): Promise<BillingNetworkState>
  trashItem(path: string): Promise<void>
  openLogs(): Promise<void>
  windowAction(action: WindowAction): Promise<void>
  showSettings(): Promise<void>
  openMain(action?: OpenMainAction): Promise<void>
  closeAlert(): Promise<void>
  runAlertAction(action: NonNullable<AlertPayload['action']>): Promise<void>
  onSnapshot(listener: (snapshot: DesktopSnapshot) => void): () => void
}



