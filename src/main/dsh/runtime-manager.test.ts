import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppSettings, SecretSettings } from '../../shared/contracts'
import { AppLogger } from '../logger'
import { DshRuntimeManager } from './runtime-manager'

const FAKE_NPM = fileURLToPath(new URL('./__fixtures__/fake-npm-cli.mjs', import.meta.url))

const MANAGED_ENV_KEYS = [
  'DSH_DESKTOP_NODE_BINARY',
  'DSH_DESKTOP_NPM_CLI',
  'FAKE_NPM_COUNTER',
  'FAKE_NPM_DELAY_MS',
  'FAKE_NPM_LATEST_VERSION'
] as const

function settingsFor(channel: AppSettings['dsh']['channel']): AppSettings {
  return {
    version: 1,
    launchAtLogin: false,
    startMinimized: false,
    closeToTray: true,
    minimizeToTray: true,
    dsh: {
      managed: true,
      channel,
      pinnedVersion: null,
      preferredPort: 3080,
      autoInstall: true,
      autoRestart: false,
      maxRestarts: 3,
      restartWindowMinutes: 10,
      healthIntervalSeconds: 5,
      startupTimeoutSeconds: 30,
      gracefulStopSeconds: 2,
      extraArgs: []
    },
    notifications: { onStart: false, onCrash: false, onMeteredNetwork: false, onUpdate: false },
    updates: { appFeedUrl: '', dshAutoCheck: false },
    security: { windowsPublisherThumbprint: '' }
  }
}

const SECRETS: SecretSettings = {
  deepseekApiKey: 'sk-secret',
  deepseekBaseUrl: 'https://api.example/v1',
  gatewayApiKey: 'gw-secret',
  gatewayBaseUrl: '',
  gatewayModel: '',
  extraEnvironment: { SAFE_NAME: 'value', 'BAD NAME': 'value', '1START': 'value' }
}

async function npmCallCount(counterFile: string): Promise<number> {
  try {
    const text = await readFile(counterFile, 'utf8')
    return text.split('\n').filter((line) => line.trim() !== '').length
  } catch {
    return 0
  }
}

describe('DshRuntimeManager', () => {
  let root = ''
  let counterFile = ''
  const savedEnv = new Map<string, string | undefined>()

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-runtime-'))
    counterFile = join(root, 'npm-calls.txt')
    for (const key of MANAGED_ENV_KEYS) {
      savedEnv.set(key, process.env[key])
      delete process.env[key]
    }
    process.env.DSH_DESKTOP_NODE_BINARY = process.execPath
    process.env.DSH_DESKTOP_NPM_CLI = FAKE_NPM
    process.env.FAKE_NPM_COUNTER = counterFile
    process.env.FAKE_NPM_DELAY_MS = '25'
    process.env.FAKE_NPM_LATEST_VERSION = '2.0.0'
  })

  afterEach(async () => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    savedEnv.clear()
    await rm(root, { recursive: true, force: true })
  })

  function createManager(): DshRuntimeManager {
    return new DshRuntimeManager(join(root, 'user-data'), root, false, new AppLogger(null))
  }

  it('reports no installed runtime before the first install', async () => {
    expect(await createManager().installedVersion()).toBeNull()
  })

  it('installs a channel and records a manifest other components can read', async () => {
    const runtime = createManager()
    const installed = await runtime.install(settingsFor('latest'), 'latest')

    expect(installed.version).toBe('2.0.0')
    expect(existsSync(installed.entry)).toBe(true)
    expect(await runtime.installedVersion()).toBe('2.0.0')
    expect(await npmCallCount(counterFile)).toBe(1)

    const manifest = JSON.parse(await readFile(join(root, 'user-data', 'runtime', 'dsh', 'current.json'), 'utf8')) as {
      version?: unknown
      requestedVersion?: unknown
      channel?: unknown
    }
    expect(manifest.version).toBe('2.0.0')
    expect(manifest.requestedVersion).toBe('latest')
    expect(manifest.channel).toBe('latest')
  })

  it('reuses the installed runtime for the same channel without downloading again', async () => {
    const runtime = createManager()
    await runtime.ensureRuntime(settingsFor('latest'))
    const again = await runtime.ensureRuntime(settingsFor('latest'))

    expect(again.version).toBe('2.0.0')
    expect(await npmCallCount(counterFile)).toBe(1)
  })

  it('does not re-download a concrete build that is already on disk', async () => {
    const runtime = createManager()
    await runtime.install(settingsFor('latest'), '1.5.0')
    const again = await runtime.install(settingsFor('latest'), '1.5.0')

    expect(again.version).toBe('1.5.0')
    expect(await npmCallCount(counterFile)).toBe(1)
  })

  it('installs a different build when the requested version changes', async () => {
    const runtime = createManager()
    await runtime.install(settingsFor('latest'), '1.0.0')
    const next = await runtime.install(settingsFor('latest'), '1.1.0')

    expect(next.version).toBe('1.1.0')
    expect(await runtime.installedVersion()).toBe('1.1.0')
    expect(await npmCallCount(counterFile)).toBe(2)
  })

  it('serves concurrent requests for one build from a single download', async () => {
    const runtime = createManager()
    const [first, second] = await Promise.all([
      runtime.install(settingsFor('latest'), '3.0.0'),
      runtime.install(settingsFor('latest'), '3.0.0')
    ])

    expect(first.version).toBe('3.0.0')
    expect(second.version).toBe('3.0.0')
    expect(await npmCallCount(counterFile)).toBe(1)
  })

  it('does not repeat the first-launch download when the update check targets that release', async () => {
    const runtime = createManager()
    const settings = settingsFor('latest')

    // Reproduces the packaged smoke-test log: the boot install resolves the `latest` tag to a
    // concrete version while the scheduled update check asks for that same concrete version.
    const boot = runtime.install(settings, 'latest')
    const update = runtime.install(settings, '2.0.0')
    const [fromBoot, fromUpdate] = await Promise.all([boot, update])

    expect(fromBoot.version).toBe('2.0.0')
    expect(fromUpdate.version).toBe('2.0.0')
    expect(await npmCallCount(counterFile)).toBe(1)
  })

  it('keeps secrets inside the child process environment only', () => {
    const runtime = createManager()
    const env = runtime.buildEnvironment(process.execPath, SECRETS, join(root, 'user-data'))

    expect(env.DEEPSEEK_API_KEY).toBe('sk-secret')
    expect(env.DEEPSEEK_BASE_URL).toBe('https://api.example/v1')
    expect(env.AI_GATEWAY_API_KEY).toBe('gw-secret')
    expect(env.AI_GATEWAY_BASE_URL).toBeUndefined()
    expect(env.AI_GATEWAY_MODEL).toBeUndefined()
    expect(env.DSH_HOME).toBe(join(root, 'user-data', 'dsh-home'))
    expect(env.SAFE_NAME).toBe('value')
    expect(env['BAD NAME']).toBeUndefined()
    expect(env['1START']).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.DSH_DESKTOP_NPM_CLI).toBeUndefined()
    expect(env.DSH_DESKTOP_NODE_BINARY).toBeUndefined()
  })
})