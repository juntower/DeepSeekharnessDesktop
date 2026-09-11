import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { EventEmitter, once } from 'node:events'
import type { AppSettings, DshStatus, SecretSettings } from '../../shared/contracts'
import { AppLogger } from '../logger'
import { findAvailablePort, probeHttp, sleep, errorMessage } from '../utils'
import { DshRuntimeManager } from './runtime-manager'

type StatusListener = (status: DshStatus) => void
type DshChild = ChildProcessByStdio<null, Readable, Readable>

const INITIAL_STATUS: DshStatus = {
  phase: 'idle',
  port: null,
  url: null,
  pid: null,
  startedAt: null,
  lastHealthyAt: null,
  restartsInWindow: 0,
  consecutiveHealthFailures: 0,
  message: 'DeepSeek Harness has not been started',
  runtime: null
}

function processIsAlive(child: DshChild): boolean {
  return child.exitCode === null && child.signalCode === null
}

export class DshProcessManager extends EventEmitter {
  private child: DshChild | null = null
  private statusValue: DshStatus = structuredClone(INITIAL_STATUS)
  private stopping = false
  private disposed = false
  private generation = 0
  private healthTimer: NodeJS.Timeout | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private restartTimestamps: number[] = []
  private authUrl: string | null = null

  constructor(
    private settings: AppSettings,
    private readonly runtime: DshRuntimeManager,
    private readonly logger: AppLogger,
    private readonly userDataPath: string,
    private readonly getSecrets: () => SecretSettings
  ) {
    super()
  }

  get status(): DshStatus {
    return structuredClone(this.statusValue)
  }

  updateSettings(settings: AppSettings): void {
    this.settings = settings
  }

  onStatus(listener: StatusListener): () => void {
    this.on('status', listener)
    return () => { this.off('status', listener) }
  }

  async start(): Promise<DshStatus> {
    if (this.disposed) throw new Error('process manager is disposed')
    if (this.statusValue.phase === 'running') return this.status
    if (this.statusValue.phase === 'starting' || this.statusValue.phase === 'installing') return this.status
    this.stopping = false
    this.clearRestartTimer()
    const generation = ++this.generation
    this.setStatus({ phase: 'installing', message: 'Preparing the DeepSeek Harness runtime…' })

    try {
      const runtime = await this.runtime.ensureRuntime(this.settings)
      if (generation !== this.generation) return this.status
      const port = await findAvailablePort(this.settings.dsh.preferredPort)
      if (generation !== this.generation) return this.status
      this.authUrl = null
      const child = spawn(runtime.node, [
        // @deepseek-ai/cordis-plugin-hmr refuses to initialise without internals exposed, and
        // `dsh web` loads that plugin unconditionally.
        '--expose-internals',
        runtime.entry,
        'web',
        '--no-open',
        '--port',
        String(port),
        ...this.settings.dsh.extraArgs
      ], {
        cwd: runtime.projectDir,
        env: this.runtime.buildEnvironment(runtime.node, this.getSecrets(), this.userDataPath),
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'] as const
      })
      this.child = child
      this.consumeStream(child, 'stdout', generation)
      this.consumeStream(child, 'stderr', generation)
      child.once('error', (error) => {
        if (this.child === child) this.handleExit(child, null, `spawn error: ${error.message}`)
      })
      child.once('exit', (code, signal) => {
        if (this.child === child) this.handleExit(child, code, signal)
      })
      this.setStatus({
        phase: 'starting',
        port,
        url: `http://127.0.0.1:${String(port)}/`,
        pid: child.pid ?? null,
        startedAt: new Date().toISOString(),
        message: `Starting DeepSeek Harness on port ${String(port)}…`,
        runtime
      })
      await this.waitUntilHealthy(child, port, generation)
      return this.status
    } catch (error) {
      if (generation !== this.generation) {
        // A newer stop/restart superseded this attempt while it was still starting (for example an
        // update swapped the runtime mid-boot). The newer attempt owns the status from here on, so
        // this is expected bookkeeping rather than a failure worth reporting to the user.
        this.logger.system(`DeepSeek Harness start attempt was superseded: ${errorMessage(error)}`)
        return this.status
      }
      const failedChild = this.child
      if (failedChild !== null) {
        if (processIsAlive(failedChild)) {
          this.stopping = true
          await this.terminate(failedChild).catch((terminationError: unknown) => {
            this.logger.stderr(`Failed to clean up startup process: ${errorMessage(terminationError)}`)
          })
          this.stopping = false
        }
        if (!processIsAlive(failedChild) && this.child === failedChild) this.child = null
      }
      this.setStatus({
        phase: 'error',
        pid: failedChild !== null && processIsAlive(failedChild) ? failedChild.pid ?? null : null,
        message: errorMessage(error),
        consecutiveHealthFailures: 0
      })
      throw error
    }
  }

  async stop(): Promise<DshStatus> {
    this.clearTimers()
    this.generation += 1
    this.stopping = true
    const child = this.child
    if (child === null) {
      this.setStatus({ phase: 'stopped', pid: null, port: null, url: null, message: 'DeepSeek Harness is stopped' })
      return this.status
    }
    this.setStatus({ phase: 'stopping', message: 'Stopping DeepSeek Harness…' })
    await this.terminate(child)
    if (this.child === child) this.child = null
    this.setStatus({
      phase: 'stopped',
      pid: null,
      port: null,
      url: null,
      startedAt: null,
      message: 'DeepSeek Harness is stopped'
    })
    return this.status
  }

  async restart(reason = 'manual restart'): Promise<DshStatus> {
    this.logger.system(`Restarting DeepSeek Harness: ${reason}`)
    await this.stop()
    this.stopping = false
    return this.start()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.stop()
    this.removeAllListeners()
  }

  private async waitUntilHealthy(
    child: DshChild,
    port: number,
    generation: number
  ): Promise<void> {
    const deadline = Date.now() + this.settings.dsh.startupTimeoutSeconds * 1_000
    const origin = `http://127.0.0.1:${String(port)}/`
    const tokenDeadline = Date.now() + Math.min(this.settings.dsh.startupTimeoutSeconds * 1_000, 20_000)
    let warnedAboutMissingToken = false
    while (Date.now() < deadline) {
      if (generation !== this.generation || this.child !== child || !processIsAlive(child)) {
        throw new Error('DeepSeek Harness exited before becoming healthy')
      }
      // The bare loopback origin answers 401 until the tokenised URL has been visited once, so the
      // authenticated address printed by the CLI is the one that decides readiness.
      const authenticated = this.authUrl
      const fallback = authenticated === null && Date.now() > tokenDeadline
      const probe = await probeHttp(authenticated ?? origin, 1_500)
      if (probe.ok && (authenticated !== null || fallback)) {
        if (fallback && !warnedAboutMissingToken) {
          warnedAboutMissingToken = true
          this.logger.stderr('DeepSeek Harness did not print an authenticated Web URL; continuing with the bare origin')
        }
        const now = new Date().toISOString()
        this.setStatus({
          phase: 'running',
          lastHealthyAt: now,
          consecutiveHealthFailures: 0,
          message: `DeepSeek Harness is ready on port ${String(port)}`
        })
        this.logger.system(`DeepSeek Harness health check passed: ${probe.message}`)
        this.startHealthMonitor(child, port, generation)
        return
      }
      await sleep(600).catch(() => undefined)
    }
    throw new Error(`DeepSeek Harness did not become healthy within ${String(this.settings.dsh.startupTimeoutSeconds)} seconds`)
  }

  private startHealthMonitor(
    child: DshChild,
    port: number,
    generation: number
  ): void {
    if (this.healthTimer !== null) clearInterval(this.healthTimer)
    const interval = this.settings.dsh.healthIntervalSeconds * 1_000
    this.healthTimer = setInterval(() => {
      void (async () => {
        if (generation !== this.generation || this.child !== child || !processIsAlive(child)) return
        const probe = await probeHttp(this.authUrl ?? `http://127.0.0.1:${String(port)}/`, 2_500)
        if (generation !== this.generation || this.child !== child) return
        if (probe.ok) {
          this.setStatus({
            phase: 'running',
            lastHealthyAt: new Date().toISOString(),
            consecutiveHealthFailures: 0,
            message: `DeepSeek Harness is ready on port ${String(port)}`
          })
          return
        }
        const failures = this.statusValue.consecutiveHealthFailures + 1
        this.setStatus({
          phase: failures >= 3 ? 'degraded' : 'running',
          consecutiveHealthFailures: failures,
          message: `Health check failed (${String(failures)}/3): ${probe.message}`
        })
        if (failures >= 3 && this.settings.dsh.autoRestart) {
          this.logger.stderr('DeepSeek Harness health checks failed three times; restarting the process')
          await this.restart('health check failure')
        }
      })().catch((error: unknown) => { this.logger.stderr(errorMessage(error)) })
    }, interval)
  }

  private handleExit(child: DshChild, code: number | null, signal: NodeJS.Signals | string | null): void {
    if (this.child !== child) return
    this.clearHealthTimer()
    this.child = null
    const intentional = this.stopping
    const detail = code === null ? String(signal ?? 'unknown') : `code ${String(code)}`
    this.logger.system(`DeepSeek Harness exited with ${detail}`)
    if (intentional) {
      this.setStatus({ phase: 'stopped', pid: null, message: 'DeepSeek Harness is stopped' })
      return
    }
    this.setStatus({
      phase: 'crashed',
      pid: null,
      consecutiveHealthFailures: 0,
      message: `DeepSeek Harness exited unexpectedly with ${detail}`
    })
    this.scheduleRestart()
  }

  private scheduleRestart(): void {
    if (!this.settings.dsh.autoRestart || this.disposed || this.stopping || this.restartTimer !== null) return
    const now = Date.now()
    const windowMilliseconds = this.settings.dsh.restartWindowMinutes * 60_000
    this.restartTimestamps = this.restartTimestamps.filter((timestamp) => now - timestamp < windowMilliseconds)
    if (this.restartTimestamps.length >= this.settings.dsh.maxRestarts) {
      this.setStatus({
        phase: 'error',
        message: `Crash loop stopped after ${String(this.settings.dsh.maxRestarts)} restarts in ${String(this.settings.dsh.restartWindowMinutes)} minutes`
      })
      return
    }
    this.restartTimestamps.push(now)
    const attempt = this.restartTimestamps.length
    const delay = Math.min(30_000, 1_000 * 2 ** (attempt - 1))
    this.setStatus({
      phase: 'restarting',
      restartsInWindow: this.restartTimestamps.length,
      message: `Restarting in ${String(Math.round(delay / 1_000))} seconds (attempt ${String(attempt)})…`
    })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.start().catch((error: unknown) => {
        this.logger.stderr(`Automatic restart failed: ${errorMessage(error)}`)
      })
    }, delay)
  }

  private async terminate(child: DshChild): Promise<void> {
    if (!processIsAlive(child)) return
    child.kill('SIGTERM')
    const exited = await Promise.race([
      once(child, 'exit').then(() => true),
      sleep(this.settings.dsh.gracefulStopSeconds * 1_000).then(() => false)
    ]).catch(() => false)
    if (exited || !processIsAlive(child)) return
    this.logger.stderr('DeepSeek Harness did not stop gracefully; terminating its process tree')
    if (process.platform === 'win32' && child.pid !== undefined) {
      await new Promise<void>((resolve) => {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          shell: false,
          stdio: 'ignore'
        })
        killer.once('error', () => { resolve() })
        killer.once('exit', () => { resolve() })
      })
    } else {
      child.kill('SIGKILL')
    }
  }

  private consumeStream(child: DshChild, stream: 'stdout' | 'stderr', generation: number): void {
    const readable = stream === 'stdout' ? child.stdout : child.stderr
    readable.setEncoding('utf8')
    let buffered = ''
    const emit = (line: string): void => {
      if (line.trim() === '') return
      if (stream === 'stdout') {
        this.logger.stdout(line)
        this.observeAuthenticatedUrl(line, child, generation)
        return
      }
      this.logger.stderr(line)
    }
    readable.on('data', (chunk: string) => {
      buffered += chunk
      const lines = buffered.split(/\r?\n/u)
      buffered = lines.pop() ?? ''
      for (const line of lines) emit(line)
    })
    readable.on('end', () => {
      if (buffered.trim() !== '') emit(buffered)
    })
  }

  /**
   * `dsh web` prints a one-time tokenised loopback address such as
   * `dsh web: http://127.0.0.1:3080/?token=…`. Visiting it authorises the persistent session, so
   * the embedded browser navigates there instead of the bare origin.
   */
  private observeAuthenticatedUrl(line: string, child: DshChild, generation: number): void {
    if (this.child !== child || generation !== this.generation) return
    const match = /(https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/\?token=[^\s"'`]+)/u.exec(line)
    const url = match?.[1]
    if (url === undefined || url === this.authUrl) return
    this.authUrl = url
    this.setStatus({ url, message: 'DeepSeek Harness Web UI is ready' })
  }

  private setStatus(patch: Partial<DshStatus>): void {
    this.statusValue = { ...this.statusValue, ...patch }
    this.emit('status', this.status)
  }

  private clearHealthTimer(): void {
    if (this.healthTimer !== null) clearInterval(this.healthTimer)
    this.healthTimer = null
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== null) clearTimeout(this.restartTimer)
    this.restartTimer = null
  }

  private clearTimers(): void {
    this.clearHealthTimer()
    this.clearRestartTimer()
  }
}
