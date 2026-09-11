import { createServer } from 'node:net'
import { request } from 'node:http'

export function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

export function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    if (signal === undefined) return
    const abort = (): void => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

export async function findAvailablePort(preferred: number, host = '127.0.0.1'): Promise<number> {
  const available = async (port: number): Promise<boolean> => new Promise((resolve) => {
    const server = createServer()
    server.unref()
    server.once('error', () => { resolve(false) })
    server.listen(port, host, () => {
      server.close(() => { resolve(true) })
    })
  })

  if (await available(preferred)) return preferred
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, host, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('could not allocate a loopback port'))
        return
      }
      const port = address.port
      server.close((error) => {
        if (error) reject(error)
        else resolve(port)
      })
    })
  })
}

export interface HttpProbeResult {
  ok: boolean
  status: number | null
  message: string
}

export function probeHttp(url: string, timeoutMilliseconds = 2_500): Promise<HttpProbeResult> {
  return new Promise((resolve) => {
    const req = request(url, { method: 'GET', timeout: timeoutMilliseconds }, (response) => {
      response.resume()
      resolve({
        ok: response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 500,
        status: response.statusCode ?? null,
        message: `HTTP ${String(response.statusCode ?? 'unknown')}`
      })
    })
    req.once('timeout', () => {
      req.destroy(new Error(`health check timed out after ${String(timeoutMilliseconds)} ms`))
    })
    req.once('error', (error) => {
      resolve({ ok: false, status: null, message: error.message })
    })
    req.end()
  })
}
