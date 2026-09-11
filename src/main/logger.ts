import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { LogEntry } from '../shared/contracts'

export class AppLogger {
  private readonly entries: LogEntry[] = []
  private readonly file: string | null

  constructor(userDataPath: string | null = null) {
    this.file = userDataPath === null ? null : join(userDataPath, 'logs', 'desktop.log')
  }

  snapshot(): LogEntry[] {
    return structuredClone(this.entries)
  }

  system(message: string): void {
    this.write('system', message)
  }

  stdout(message: string): void {
    this.write('stdout', message)
  }

  stderr(message: string): void {
    this.write('stderr', message)
  }

  private write(stream: LogEntry['stream'], message: string): void {
    const normalized = message.replace(/\r?\n$/u, '')
    if (normalized === '') return
    const entry: LogEntry = { at: new Date().toISOString(), stream, message: normalized }
    this.entries.push(entry)
    if (this.entries.length > 800) this.entries.splice(0, this.entries.length - 800)
    if (this.file !== null) {
      void mkdir(dirname(this.file), { recursive: true })
        .then(() => appendFile(this.file as string, `${entry.at} [${stream}] ${normalized}\n`, 'utf8'))
        .catch(() => undefined)
    }
  }
}
