import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { safeStorage } from 'electron'
import type { AppSettings, SecretSettings } from '../../shared/contracts'

const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  launchAtLogin: true,
  startMinimized: false,
  closeToTray: true,
  minimizeToTray: true,
  dsh: {
    managed: true,
    channel: 'latest',
    pinnedVersion: null,
    preferredPort: 3080,
    autoInstall: true,
    autoRestart: true,
    maxRestarts: 5,
    restartWindowMinutes: 10,
    healthIntervalSeconds: 15,
    startupTimeoutSeconds: 90,
    gracefulStopSeconds: 8,
    extraArgs: []
  },
  notifications: {
    onStart: true,
    onCrash: true,
    onMeteredNetwork: true,
    onUpdate: true
  },
  updates: {
    appFeedUrl: '',
    dshAutoCheck: true
  },
  security: {
    windowsPublisherThumbprint: ''
  }
}

const DEFAULT_SECRETS: SecretSettings = {
  deepseekApiKey: '',
  deepseekBaseUrl: '',
  gatewayApiKey: '',
  gatewayBaseUrl: '',
  gatewayModel: '',
  extraEnvironment: {}
}

interface StoredSecrets {
  version: 1
  encrypted: boolean
  payload: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function numberValue(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, item]) => key.trim() !== '' && typeof item === 'string')
      .map(([key, item]) => [key.trim(), item as string])
  )
}

function normalizeSettings(value: unknown): AppSettings {
  if (!isRecord(value)) return structuredClone(DEFAULT_SETTINGS)
  const dsh = isRecord(value.dsh) ? value.dsh : {}
  const notifications = isRecord(value.notifications) ? value.notifications : {}
  const updates = isRecord(value.updates) ? value.updates : {}
  const security = isRecord(value.security) ? value.security : {}
  const channel = dsh.channel === 'next' || dsh.channel === 'alpha' ? dsh.channel : 'latest'
  const pinnedVersion = typeof dsh.pinnedVersion === 'string' && dsh.pinnedVersion.trim() !== ''
    ? dsh.pinnedVersion.trim()
    : null

  return {
    version: 1,
    launchAtLogin: booleanValue(value.launchAtLogin, DEFAULT_SETTINGS.launchAtLogin),
    startMinimized: booleanValue(value.startMinimized, DEFAULT_SETTINGS.startMinimized),
    closeToTray: booleanValue(value.closeToTray, DEFAULT_SETTINGS.closeToTray),
    minimizeToTray: booleanValue(value.minimizeToTray, DEFAULT_SETTINGS.minimizeToTray),
    dsh: {
      managed: booleanValue(dsh.managed, DEFAULT_SETTINGS.dsh.managed),
      channel,
      pinnedVersion,
      preferredPort: numberValue(dsh.preferredPort, DEFAULT_SETTINGS.dsh.preferredPort, 1024, 65535),
      autoInstall: booleanValue(dsh.autoInstall, DEFAULT_SETTINGS.dsh.autoInstall),
      autoRestart: booleanValue(dsh.autoRestart, DEFAULT_SETTINGS.dsh.autoRestart),
      maxRestarts: numberValue(dsh.maxRestarts, DEFAULT_SETTINGS.dsh.maxRestarts, 0, 100),
      restartWindowMinutes: numberValue(dsh.restartWindowMinutes, DEFAULT_SETTINGS.dsh.restartWindowMinutes, 1, 1440),
      healthIntervalSeconds: numberValue(dsh.healthIntervalSeconds, DEFAULT_SETTINGS.dsh.healthIntervalSeconds, 5, 600),
      startupTimeoutSeconds: numberValue(dsh.startupTimeoutSeconds, DEFAULT_SETTINGS.dsh.startupTimeoutSeconds, 10, 600),
      gracefulStopSeconds: numberValue(dsh.gracefulStopSeconds, DEFAULT_SETTINGS.dsh.gracefulStopSeconds, 1, 60),
      extraArgs: Array.isArray(dsh.extraArgs)
        ? dsh.extraArgs.filter((item): item is string => typeof item === 'string').slice(0, 64)
        : []
    },
    notifications: {
      onStart: booleanValue(notifications.onStart, DEFAULT_SETTINGS.notifications.onStart),
      onCrash: booleanValue(notifications.onCrash, DEFAULT_SETTINGS.notifications.onCrash),
      onMeteredNetwork: booleanValue(notifications.onMeteredNetwork, DEFAULT_SETTINGS.notifications.onMeteredNetwork),
      onUpdate: booleanValue(notifications.onUpdate, DEFAULT_SETTINGS.notifications.onUpdate)
    },
    updates: {
      appFeedUrl: stringValue(updates.appFeedUrl, DEFAULT_SETTINGS.updates.appFeedUrl).trim(),
      dshAutoCheck: booleanValue(updates.dshAutoCheck, DEFAULT_SETTINGS.updates.dshAutoCheck)
    },
    security: {
      windowsPublisherThumbprint: stringValue(
        security.windowsPublisherThumbprint,
        DEFAULT_SETTINGS.security.windowsPublisherThumbprint
      ).replace(/\s+/gu, '').toUpperCase()
    }
  }
}

function mergeSettings(current: AppSettings, patch: Partial<AppSettings>): AppSettings {
  return normalizeSettings({
    ...current,
    ...patch,
    dsh: { ...current.dsh, ...(patch.dsh ?? {}) },
    notifications: { ...current.notifications, ...(patch.notifications ?? {}) },
    updates: { ...current.updates, ...(patch.updates ?? {}) },
    security: { ...current.security, ...(patch.security ?? {}) }
  })
}

export class SettingsStore {
  private settings: AppSettings = structuredClone(DEFAULT_SETTINGS)
  private secrets: SecretSettings = structuredClone(DEFAULT_SECRETS)

  constructor(
    private readonly settingsFile = join(process.env.APPDATA ?? process.cwd(), 'DeepSeek Harness Desktop', 'settings.json'),
    private readonly secretsFile = join(process.env.APPDATA ?? process.cwd(), 'DeepSeek Harness Desktop', 'secrets.json')
  ) {}

  get value(): AppSettings {
    return structuredClone(this.settings)
  }

  get secretValue(): SecretSettings {
    return structuredClone(this.secrets)
  }

  async load(): Promise<void> {
    await mkdir(dirname(this.settingsFile), { recursive: true })
    try {
      this.settings = normalizeSettings(JSON.parse(await readFile(this.settingsFile, 'utf8')))
    } catch {
      this.settings = structuredClone(DEFAULT_SETTINGS)
    }
    await this.loadSecrets()
  }

  async patch(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.settings = mergeSettings(this.settings, patch)
    await this.writeJson(this.settingsFile, this.settings)
    return this.value
  }

  async patchSecrets(patch: Partial<SecretSettings> & {
    clearDeepseekApiKey?: boolean
    clearGatewayApiKey?: boolean
  }): Promise<SecretSettings> {
    const next = { ...this.secrets, ...patch }
    if (patch.clearDeepseekApiKey === true) next.deepseekApiKey = ''
    if (patch.clearGatewayApiKey === true) next.gatewayApiKey = ''
    delete (next as Partial<SecretSettings> & { clearDeepseekApiKey?: boolean }).clearDeepseekApiKey
    delete (next as Partial<SecretSettings> & { clearGatewayApiKey?: boolean }).clearGatewayApiKey
    this.secrets = {
      deepseekApiKey: next.deepseekApiKey.trim(),
      deepseekBaseUrl: next.deepseekBaseUrl.trim(),
      gatewayApiKey: next.gatewayApiKey.trim(),
      gatewayBaseUrl: next.gatewayBaseUrl.trim(),
      gatewayModel: next.gatewayModel.trim(),
      extraEnvironment: stringRecord(next.extraEnvironment)
    }
    await this.writeSecrets()
    return this.secretValue
  }

  private async loadSecrets(): Promise<void> {
    try {
      const stored = JSON.parse(await readFile(this.secretsFile, 'utf8')) as Partial<StoredSecrets>
      if (typeof stored.payload !== 'string') return
      const json = stored.encrypted === true
        ? safeStorage.decryptString(Buffer.from(stored.payload, 'base64'))
        : Buffer.from(stored.payload, 'base64').toString('utf8')
      const parsed = JSON.parse(json) as Partial<SecretSettings>
      this.secrets = {
        ...DEFAULT_SECRETS,
        ...parsed,
        extraEnvironment: stringRecord(parsed.extraEnvironment)
      }
    } catch {
      this.secrets = structuredClone(DEFAULT_SECRETS)
    }
  }

  private async writeSecrets(): Promise<void> {
    const json = JSON.stringify(this.secrets)
    const encrypted = safeStorage.isEncryptionAvailable()
    const stored: StoredSecrets = encrypted
      ? { version: 1, encrypted: true, payload: safeStorage.encryptString(json).toString('base64') }
      : { version: 1, encrypted: false, payload: Buffer.from(json, 'utf8').toString('base64') }
    await this.writeJson(this.secretsFile, stored)
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
  }
}

export { DEFAULT_SETTINGS }
