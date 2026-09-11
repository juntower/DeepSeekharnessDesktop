import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface SignatureVerification {
  status: 'valid' | 'invalid' | 'unverified' | 'unsupported'
  signerThumbprint: string | null
  signerSubject: string | null
  message: string
}

export async function sha256File(path: string): Promise<string> {
  const contents = await readFile(path)
  return createHash('sha256').update(contents).digest('hex')
}

export function verifySRI(contents: Buffer, integrity: string): boolean {
  for (const item of integrity.split(/\s+/u)) {
    const separator = item.indexOf('-')
    if (separator <= 0) continue
    const algorithm = item.slice(0, separator)
    const expected = item.slice(separator + 1)
    const actual = createHash(algorithm).update(contents).digest('base64')
    if (actual === expected) return true
  }
  return false
}

export async function verifyAuthenticode(
  path: string,
  expectedThumbprint: string
): Promise<SignatureVerification> {
  if (process.platform !== 'win32') {
    return { status: 'unsupported', signerThumbprint: null, signerSubject: null, message: 'Authenticode is only available on Windows' }
  }
  if (expectedThumbprint.trim() === '') {
    return { status: 'unverified', signerThumbprint: null, signerSubject: null, message: 'No trusted publisher thumbprint is configured' }
  }
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$signature = Get-AuthenticodeSignature -LiteralPath '${path.replace(/'/gu, "''")}'`,
    '[pscustomobject]@{',
    '  status = $signature.Status.ToString()',
    '  thumbprint = if ($null -eq $signature.SignerCertificate) { $null } else { $signature.SignerCertificate.Thumbprint }',
    '  subject = if ($null -eq $signature.SignerCertificate) { $null } else { $signature.SignerCertificate.Subject }',
    '  message = $signature.StatusMessage',
    '} | ConvertTo-Json -Compress'
  ].join('\n')
  try {
    const powershell = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    const { stdout } = await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15_000
    })
    const parsed = JSON.parse(stdout.trim()) as {
      status?: unknown
      thumbprint?: unknown
      subject?: unknown
      message?: unknown
    }
    const thumbprint = typeof parsed.thumbprint === 'string' ? parsed.thumbprint.replace(/\s+/gu, '').toUpperCase() : null
    const valid = parsed.status === 'Valid' && thumbprint === expectedThumbprint.trim().toUpperCase()
    return {
      status: valid ? 'valid' : 'invalid',
      signerThumbprint: thumbprint,
      signerSubject: typeof parsed.subject === 'string' ? parsed.subject : null,
      message: valid ? 'Authenticode signature matches the configured publisher' : String(parsed.message ?? 'signature mismatch')
    }
  } catch (error) {
    return {
      status: 'invalid',
      signerThumbprint: null,
      signerSubject: null,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}
