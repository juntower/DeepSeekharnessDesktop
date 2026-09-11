import { net } from 'electron'
import semver from 'semver'
import type { AppSettings, UpdateState } from '../../shared/contracts'
import { AppLogger } from '../logger'
import { errorMessage } from '../utils'
import { DshProcessManager } from '../dsh/process-manager'
import { DshRuntimeManager } from '../dsh/runtime-manager'

interface RegistryDocument {
  'dist-tags'?: Record<string, unknown>
  versions?: Record<string, { dist?: { integrity?: unknown } }>
}

export class DshUpdateManager {
  private state: UpdateState = {
    phase: 'idle',
    version: null,
    percent: null,
    message: 'DeepSeek Harness update check has not run yet'
  }

  constructor(
    private readonly runtime: DshRuntimeManager,
    private readonly processManager: DshProcessManager,
    private readonly logger: AppLogger
  ) {}

  get value(): UpdateState {
    return structuredClone(this.state)
  }

  async check(settings: AppSettings): Promise<UpdateState> {
    try {
      this.state = { phase: 'checking', version: null, percent: null, message: 'Checking DeepSeek Harness releases…' }
      // Read the installed manifest instead of the running process: on the very first launch the
      // runtime is still downloading, and treating that as version 0.0.0 produced a bogus
      // "update available" alert plus an Install button that raced the first install.
      const current = await this.runtime.installedVersion()
      if (current === null) {
        this.state = {
          phase: 'idle',
          version: null,
          percent: null,
          message: 'DeepSeek Harness is still being installed; update checks resume afterwards'
        }
        return this.value
      }
      const response = await net.fetch('https://registry.npmjs.org/@deepseek-ai%2Fdsh', {
        headers: { accept: 'application/vnd.npm.install-v1+json' }
      })
      if (!response.ok) throw new Error(`npm registry returned HTTP ${String(response.status)}`)
      const document = await response.json() as RegistryDocument
      const target = settings.dsh.pinnedVersion ?? document['dist-tags']?.[settings.dsh.channel]
      if (typeof target !== 'string' || !semver.valid(target)) throw new Error('registry did not return a valid dsh version')
      const pinned = settings.dsh.pinnedVersion !== null
      const available = pinned ? target !== current : semver.valid(current) !== null && semver.gt(target, current)
      this.state = {
        phase: available ? 'available' : 'current',
        version: available ? target : current,
        percent: null,
        message: available
          ? `DeepSeek Harness ${target} is available`
          : pinned
            ? `Pinned DeepSeek Harness ${current} is active`
            : `DeepSeek Harness ${current} is up to date`
      }
    } catch (error) {
      this.logger.stderr(`DSH update check: ${errorMessage(error)}`)
      this.state = { phase: 'error', version: null, percent: null, message: errorMessage(error) }
    }
    return this.value
  }

  async install(settings: AppSettings): Promise<UpdateState> {
    const target = this.state.version
    if (target === null || this.state.phase !== 'available') return this.value
    try {
      const before = await this.runtime.installedVersion()
      this.state = { phase: 'downloading', version: target, percent: 0, message: `Installing DeepSeek Harness ${target}…` }
      await this.runtime.install(settings, target)
      const after = await this.runtime.installedVersion()
      if (after === before) {
        // The requested build is already on disk (the queued first-launch install finished while
        // this request waited), so there is nothing to swap in and no reason to restart the service.
        this.state = { phase: 'current', version: after, percent: null, message: `DeepSeek Harness ${after} is already installed` }
        return this.value
      }
      this.state = { phase: 'downloaded', version: target, percent: 100, message: `DeepSeek Harness ${target} installed; restarting service…` }
      await this.processManager.restart(`updated runtime to ${target}`)
      this.state = { phase: 'current', version: target, percent: null, message: `DeepSeek Harness ${target} is active` }
    } catch (error) {
      this.logger.stderr(`DSH update install: ${errorMessage(error)}`)
      this.state = { phase: 'error', version: target, percent: null, message: errorMessage(error) }
    }
    return this.value
  }
}
