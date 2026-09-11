import { spawn } from 'node:child_process'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { AppSettings, DshRuntimeInfo, SecretSettings } from '../../shared/contracts'
import { AppLogger } from '../logger'
import { errorMessage } from '../utils'

interface RuntimeManifest {
  version: string
  channel: AppSettings['dsh']['channel']
  requestedVersion: string
  entry: string
  projectDir: string
  node: string
  installedAt: string
}

interface ResolvedCommand {
  command: string
  argsPrefix: string[]
  env: NodeJS.ProcessEnv
}

function safeVersion(value: string): string {
  return value.replace(/[^0-9A-Za-z._-]/gu, '_')
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

export class DshRuntimeManager {
  private readonly root: string
  private cached: RuntimeManifest | null = null
  private installChain: Promise<unknown> = Promise.resolve()

  constructor(
    userDataPath: string,
    private readonly resourcesPath: string,
    private readonly development: boolean,
    private readonly logger: AppLogger
  ) {
    this.root = join(userDataPath, 'runtime', 'dsh')
  }

  async ensureRuntime(settings: AppSettings, force = false): Promise<DshRuntimeInfo> {
    if (!settings.dsh.managed) return this.externalRuntime()
    if (!force && this.cached !== null && await exists(this.cached.entry)) {
      return this.toInfo(this.cached)
    }
    const manifest = await this.readManifest()
    if (!force && manifest !== null && this.matchesSettings(manifest, settings) && await exists(manifest.entry)) {
      this.cached = manifest
      return this.toInfo(manifest)
    }
    const requestedVersion = settings.dsh.pinnedVersion ?? settings.dsh.channel
    if (!settings.dsh.autoInstall) {
      throw new Error(`DeepSeek Harness ${requestedVersion} is not installed and automatic installation is disabled`)
    }
    return this.install(settings, requestedVersion)
  }

  /**
   * Installs a requested version one at a time. npm install takes minutes, and the first boot
   * races the scheduled update check, so overlapping requests are queued instead of duplicated and
   * a request the current manifest already satisfies returns immediately.
   */
  install(settings: AppSettings, requestedVersion: string): Promise<DshRuntimeInfo> {
    const run = this.installChain.then(
      () => this.performInstall(settings, requestedVersion),
      () => this.performInstall(settings, requestedVersion)
    )
    this.installChain = run.then(() => undefined, () => undefined)
    return run
  }

  /** Version of the runtime currently on disk, or null when no usable copy is installed yet. */
  async installedVersion(): Promise<string | null> {
    if (this.cached !== null && await exists(this.cached.entry)) return this.cached.version
    const manifest = await this.readManifest()
    if (manifest === null || !await exists(manifest.entry)) return null
    this.cached = manifest
    return manifest.version
  }

  private async performInstall(settings: AppSettings, requestedVersion: string): Promise<DshRuntimeInfo> {
    const existing = await this.readManifest()
    if (existing !== null && existing.version === requestedVersion && await exists(existing.entry)) {
      this.cached = existing
      this.logger.system(`DeepSeek Harness ${existing.version} is already installed; skipping download`)
      return this.toInfo(existing)
    }
    const node = this.resolveNode()
    const npm = await this.resolveNpm(node)
    const versionDirectory = safeVersion(requestedVersion)
    const finalDir = join(this.root, 'versions', versionDirectory)
    const stagingDir = join(this.root, `.staging-${safeVersion(requestedVersion)}-${String(process.pid)}-${String(Date.now())}`)
    await mkdir(stagingDir, { recursive: true })
    this.logger.system(`Installing @deepseek-ai/dsh@${requestedVersion} into ${stagingDir}`)

    try {
      await this.runCommand(npm.command, [
        ...npm.argsPrefix,
        'install',
        '--prefix',
        stagingDir,
        '--omit=dev',
        '--no-audit',
        '--no-fund',
        `@deepseek-ai/dsh@${requestedVersion}`
      ], stagingDir, npm.env)

      const packageDir = join(stagingDir, 'node_modules', '@deepseek-ai', 'dsh')
      const packageJson = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as { version?: unknown }
      if (typeof packageJson.version !== 'string' || packageJson.version === '') {
        throw new Error('installed @deepseek-ai/dsh package has no version')
      }
      const entry = join(packageDir, 'lib', 'bin.js')
      if (!await exists(entry)) throw new Error(`installed package entry does not exist: ${entry}`)

      await rm(finalDir, { recursive: true, force: true })
      await mkdir(dirname(finalDir), { recursive: true })
      await rename(stagingDir, finalDir)
      const manifest: RuntimeManifest = {
        version: packageJson.version,
        channel: settings.dsh.channel,
        requestedVersion,
        entry: join(finalDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
        projectDir: finalDir,
        node,
        installedAt: new Date().toISOString()
      }
      await writeJson(join(this.root, 'current.json'), manifest)
      this.cached = manifest
      this.logger.system(`DeepSeek Harness ${manifest.version} installed`)
      return this.toInfo(manifest)
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
      throw new Error(`failed to install DeepSeek Harness: ${errorMessage(error)}`)
    }
  }

  buildEnvironment(node: string, secrets: SecretSettings, userDataPath: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = Object.fromEntries(
      Object.entries(process.env).filter(([name, value]) => (
        value !== undefined && name !== 'NODE_OPTIONS' && !name.startsWith('DSH_DESKTOP_')
      ))
    )
    env.ELECTRON_RUN_AS_NODE = basename(node).toLowerCase().startsWith('electron') ? '1' : undefined
    env.DSH_HOME = join(userDataPath, 'dsh-home')
    if (secrets.deepseekApiKey !== '') env.DEEPSEEK_API_KEY = secrets.deepseekApiKey
    if (secrets.deepseekBaseUrl !== '') env.DEEPSEEK_BASE_URL = secrets.deepseekBaseUrl
    if (secrets.gatewayApiKey !== '') env.AI_GATEWAY_API_KEY = secrets.gatewayApiKey
    if (secrets.gatewayBaseUrl !== '') env.AI_GATEWAY_BASE_URL = secrets.gatewayBaseUrl
    if (secrets.gatewayModel !== '') env.AI_GATEWAY_MODEL = secrets.gatewayModel
    for (const [name, value] of Object.entries(secrets.extraEnvironment)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) env[name] = value
    }
    return env
  }

  private matchesSettings(manifest: RuntimeManifest, settings: AppSettings): boolean {
    if (manifest.channel !== settings.dsh.channel) return false
    if (settings.dsh.pinnedVersion !== null) return manifest.version === settings.dsh.pinnedVersion
    return true
  }

  private async externalRuntime(): Promise<DshRuntimeInfo> {
    const entry = process.env.DSH_DESKTOP_DSH_ENTRY
    if (entry === undefined || entry === '') {
      throw new Error('managed runtime is disabled but DSH_DESKTOP_DSH_ENTRY is not configured')
    }
    const projectDir = process.env.DSH_DESKTOP_DSH_PROJECT_DIR ?? dirname(dirname(dirname(entry)))
    const node = this.resolveNode()
    return {
      version: process.env.DSH_DESKTOP_DSH_VERSION ?? 'external',
      channel: 'external',
      entry,
      node,
      projectDir,
      installedAt: new Date().toISOString()
    }
  }

  private async readManifest(): Promise<RuntimeManifest | null> {
    try {
      return JSON.parse(await readFile(join(this.root, 'current.json'), 'utf8')) as RuntimeManifest
    } catch {
      return null
    }
  }

  private resolveNode(): string {
    const configured = process.env.DSH_DESKTOP_NODE_BINARY
    if (configured !== undefined && configured !== '') return configured
    const bundled = join(this.resourcesPath, 'runtime', 'node', process.platform === 'win32' ? 'node.exe' : 'node')
    if (this.development && process.platform === 'win32') return process.execPath
    return bundled
  }

  private async resolveNpm(node: string): Promise<ResolvedCommand> {
    const configured = process.env.DSH_DESKTOP_NPM_CLI
    const development = process.env.npm_execpath
    const npmCli = configured !== undefined && configured !== ''
      ? configured
      : this.development && development !== undefined && development !== ''
        ? development
        : await this.locateBundledNpm()
    return {
      command: node,
      argsPrefix: [npmCli],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: basename(node).toLowerCase().startsWith('electron') ? '1' : undefined
      }
    }
  }

  private async locateBundledNpm(): Promise<string> {
    const npmRoot = join(this.resourcesPath, 'runtime', 'npm')
    const candidates = [
      join(npmRoot, 'bin', 'npm-cli.js'),
      join(npmRoot, 'npm', 'bin', 'npm-cli.js'),
      join(npmRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    ]
    for (const candidate of candidates) {
      if (await exists(candidate)) return candidate
    }
    throw new Error(`bundled npm CLI is missing; checked ${candidates.join(', ')}`)
  }

  private runCommand(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const consume = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
        const text = chunk.toString('utf8')
        if (stream === 'stdout') this.logger.stdout(text)
        else this.logger.stderr(text)
      }
      child.stdout?.on('data', (chunk: Buffer) => { consume('stdout', chunk) })
      child.stderr?.on('data', (chunk: Buffer) => { consume('stderr', chunk) })
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        if (code === 0) resolve()
        else reject(new Error(`command exited with ${code === null ? signal ?? 'unknown signal' : String(code)}`))
      })
    })
  }

  private toInfo(manifest: RuntimeManifest): DshRuntimeInfo {
    return {
      version: manifest.version,
      channel: manifest.channel,
      entry: manifest.entry,
      node: manifest.node,
      projectDir: manifest.projectDir,
      installedAt: manifest.installedAt
    }
  }
}
