import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ROOT_KEY = 'HKCU\\Software\\DeepSeekHarnessDesktop'
const PROTOCOL_KEY = 'HKCU\\Software\\Classes\\deepseek-harness'

async function registry(args: string[]): Promise<string> {
  if (process.platform !== 'win32') return ''
  const { stdout } = await execFileAsync('reg.exe', args, { windowsHide: true, encoding: 'utf8', timeout: 8_000 })
  return stdout
}

export class RegistryService {
  constructor(private readonly executablePath: string) {}

  async ensureRegistered(): Promise<void> {
    if (process.platform !== 'win32') return
    await registry(['ADD', ROOT_KEY, '/v', 'InstallPath', '/t', 'REG_SZ', '/d', this.executablePath, '/f'])
    await registry(['ADD', ROOT_KEY, '/v', 'Version', '/t', 'REG_SZ', '/d', '1', '/f'])
    await registry(['ADD', PROTOCOL_KEY, '/ve', '/t', 'REG_SZ', '/d', 'URL:DeepSeek Harness Protocol', '/f'])
    await registry(['ADD', PROTOCOL_KEY, '/v', 'URL Protocol', '/t', 'REG_SZ', '/d', '', '/f'])
    await registry(['ADD', `${PROTOCOL_KEY}\\shell\\open\\command`, '/ve', '/t', 'REG_SZ', '/d', `"${this.executablePath}" "%1"`, '/f'])
  }

  async installPath(): Promise<string | null> {
    if (process.platform !== 'win32') return null
    try {
      const output = await registry(['QUERY', ROOT_KEY, '/v', 'InstallPath'])
      const line = output.split(/\r?\n/u).find((item) => item.includes('InstallPath'))
      const match = line?.match(/REG_SZ\s+(.+)$/u)
      return match?.[1]?.trim() ?? null
    } catch {
      return null
    }
  }

  async unregisterProtocol(): Promise<void> {
    if (process.platform !== 'win32') return
    await registry(['DELETE', PROTOCOL_KEY, '/f']).catch(() => '')
  }
}
