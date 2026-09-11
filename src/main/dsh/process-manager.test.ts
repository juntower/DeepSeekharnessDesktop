import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppSettings, DshRuntimeInfo, SecretSettings } from '../../shared/contracts'
import { AppLogger } from '../logger'
import { DshProcessManager } from './process-manager'
import type { DshRuntimeManager } from './runtime-manager'

const FAKE_WEB = fileURLToPath(new URL('./__fixtures__/fake-dsh-web.mjs', import.meta.url))

const SECRETS: SecretSettings = {
  deepseekApiKey: '',
  deepseekBaseUrl: '',
  gatewayApiKey: '',
  gatewayBaseUrl: '',
  gatewayModel: '',
  extraEnvironment: {}
}

function settingsFor(port: number, startupTimeoutSeconds = 30): AppSettings {
  return {
    version: 1,
    launchAtLogin: false,
    startMinimized: false,
    closeToTray: true,
    minimizeToTray: true,
    dsh: {
      managed: true,
      channel: 'latest',
      pinnedVersion: null,
      preferredPort: port,
      autoInstall: true,
      autoRestart: true,
      maxRestarts: 3,
      restartWindowMinutes: 10,
      healthIntervalSeconds: 5,
      startupTimeoutSeconds,
      gracefulStopSeconds: 3,
      extraArgs: []
    },
    notifications: { onStart: false, onCrash: false, onMeteredNetwork: false, onUpdate: false },
    updates: { appFeedUrl: '', dshAutoCheck: false },
    security: { windowsPublisherThumbprint: '' }
  }
}

function runtimeStub(): DshRuntimeManager {
  const info: DshRuntimeInfo = {
    version: '0.0.0-test',
    channel: 'test',
    entry: FAKE_WEB,
    node: process.execPath,
    projectDir: dirname(FAKE_WEB),
    installedAt: new Date().toISOString()
  }
  return {
    ensureRuntime: async () => info,
    installedVersion: async () => info.version,
    buildEnvironment: () => ({ ...process.env })
  } as unknown as DshRuntimeManager
}

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('could not reserve a loopback port'))
        return
      }
      const port = address.port
      server.close(() => { resolve(port) })
    })
  })
}

async function waitFor(check: () => boolean, timeoutMilliseconds = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('timed out waiting for the expected state')
}

describe('DshProcessManager', () => {
  let userData = ''
  const managers: DshProcessManager[] = []
  const savedDelay = process.env.FAKE_DSH_DELAY_MS
  const savedExitCode = process.env.FAKE_DSH_EXIT_CODE

  beforeEach(async () => {
    userData = await mkdtemp(join(tmpdir(), 'dsh-process-'))
    process.env.FAKE_DSH_TOKEN = 'test-token'
    delete process.env.FAKE_DSH_DELAY_MS
    delete process.env.FAKE_DSH_EXIT_CODE
  })

  afterEach(async () => {
    for (const manager of managers.splice(0)) {
      await manager.dispose().catch(() => undefined)
    }
    if (savedDelay === undefined) delete process.env.FAKE_DSH_DELAY_MS
    else process.env.FAKE_DSH_DELAY_MS = savedDelay
    if (savedExitCode === undefined) delete process.env.FAKE_DSH_EXIT_CODE
    else process.env.FAKE_DSH_EXIT_CODE = savedExitCode
    delete process.env.FAKE_DSH_TOKEN
    await rm(userData, { recursive: true, force: true })
  })

  it('reaches running once the tokenised address answers and stops cleanly', async () => {
    const port = await reservePort()
    const manager = new DshProcessManager(settingsFor(port), runtimeStub(), new AppLogger(null), userData, () => SECRETS)
    managers.push(manager)

    const status = await manager.start()

    expect(status.phase).toBe('running')
    expect(status.port).toBe(port)
    expect(status.url).toContain('?token=test-token')
    expect(status.pid).not.toBeNull()
    expect(status.runtime?.version).toBe('0.0.0-test')

    const stopped = await manager.stop()

    expect(stopped.phase).toBe('stopped')
    expect(stopped.pid).toBeNull()
    expect(stopped.url).toBeNull()
  })

  it('surfaces a runtime that exits before it ever becomes healthy', async () => {
    const port = await reservePort()
    process.env.FAKE_DSH_EXIT_CODE = '1'
    const manager = new DshProcessManager(settingsFor(port, 10), runtimeStub(), new AppLogger(null), userData, () => SECRETS)
    managers.push(manager)

    await expect(manager.start()).rejects.toThrow('exited before becoming healthy')

    expect(manager.status.phase).toBe('error')
  })

  it('treats a restart during startup as expected bookkeeping instead of a failure', async () => {
    const port = await reservePort()
    process.env.FAKE_DSH_DELAY_MS = '900'
    const manager = new DshProcessManager(settingsFor(port), runtimeStub(), new AppLogger(null), userData, () => SECRETS)
    managers.push(manager)

    const first = manager.start()
    await waitFor(() => manager.status.phase === 'starting')

    const restarted = manager.restart('supersede test')

    await expect(first).resolves.toBeDefined()
    const status = await restarted
    expect(status.phase).toBe('running')

    await manager.stop()
  })
})