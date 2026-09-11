import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { BillingNetworkState, NetworkCost } from '../../shared/contracts'

const execFileAsync = promisify(execFile)

const WINDOWS_NETWORK_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  [Windows.Networking.Connectivity.NetworkInformation, Windows.Networking.Connectivity, ContentType=WindowsRuntime] | Out-Null
  $profile = [Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile()
  if ($null -eq $profile) {
    [pscustomobject]@{ cost = 'unknown'; interfaceName = $null } | ConvertTo-Json -Compress
    exit 0
  }
  $cost = $profile.GetConnectionCost()
  [pscustomobject]@{
    cost = $cost.NetworkCostType.ToString()
    interfaceName = $profile.ProfileName
  } | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{ cost = 'unknown'; interfaceName = $null } | ConvertTo-Json -Compress
}
`.trim()

function normalizeCost(value: unknown): NetworkCost {
  if (value === 'Unrestricted') return 'unrestricted'
  if (value === 'Fixed' || value === 'Variable' || value === 'OverLimit') return 'metered'
  if (value === 'metered' || value === 'unrestricted') return value
  return 'unknown'
}

export class BillingNetworkMonitor {
  private cached: BillingNetworkState | null = null

  async check(force = false): Promise<BillingNetworkState> {
    if (!force && this.cached !== null && Date.now() - Date.parse(this.cached.checkedAt) < 60_000) {
      return structuredClone(this.cached)
    }
    if (process.platform !== 'win32') {
      this.cached = { cost: 'unknown', checkedAt: new Date().toISOString(), interfaceName: null }
      return structuredClone(this.cached)
    }
    try {
      const powershell = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
      const { stdout } = await execFileAsync(powershell, [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        WINDOWS_NETWORK_SCRIPT
      ], { windowsHide: true, timeout: 8_000, encoding: 'utf8' })
      const parsed = JSON.parse(stdout.trim()) as { cost?: unknown; interfaceName?: unknown }
      this.cached = {
        cost: normalizeCost(parsed.cost),
        interfaceName: typeof parsed.interfaceName === 'string' && parsed.interfaceName !== '' ? parsed.interfaceName : null,
        checkedAt: new Date().toISOString()
      }
    } catch {
      this.cached = { cost: 'unknown', checkedAt: new Date().toISOString(), interfaceName: null }
    }
    return structuredClone(this.cached)
  }
}
