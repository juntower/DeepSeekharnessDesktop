import { createServer } from 'node:http'
import type { Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { errorMessage, findAvailablePort, probeHttp, sleep } from './utils'

const servers: Server[] = []

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('could not determine the listening port'))
        return
      }
      servers.push(server)
      resolve(address.port)
    })
  })
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => { resolve() })
  })))
})

describe('findAvailablePort', () => {
  it('returns the preferred port when it is free', async () => {
    const probe = createServer()
    const port = await listen(probe)
    await new Promise<void>((resolve) => { probe.close(() => { resolve() }) })
    servers.splice(servers.indexOf(probe), 1)

    expect(await findAvailablePort(port)).toBe(port)
  })

  it('falls back to an ephemeral port when the preferred port is taken', async () => {
    const port = await listen(createServer())

    const fallback = await findAvailablePort(port)

    expect(fallback).not.toBe(port)
    expect(fallback).toBeGreaterThan(0)
  })
})

describe('probeHttp', () => {
  it('treats the 401 of an unauthorised bare origin as reachable', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(401, { 'content-type': 'text/plain' })
      response.end('unauthorised')
    })
    const port = await listen(server)

    const probe = await probeHttp('http://127.0.0.1:' + String(port) + '/', 1_500)

    expect(probe.ok).toBe(true)
    expect(probe.status).toBe(401)
  })

  it('reports a failure when nothing is listening', async () => {
    const probe = createServer()
    const port = await listen(probe)
    await new Promise<void>((resolve) => { probe.close(() => { resolve() }) })
    servers.splice(servers.indexOf(probe), 1)

    const result = await probeHttp('http://127.0.0.1:' + String(port) + '/', 1_000)

    expect(result.ok).toBe(false)
    expect(result.status).toBeNull()
  })
})

describe('sleep', () => {
  it('resolves after the requested delay', async () => {
    const started = Date.now()
    await sleep(30)
    expect(Date.now() - started).toBeGreaterThanOrEqual(20)
  })

  it('rejects when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(sleep(1_000, controller.signal)).rejects.toThrow('cancelled')
  })
})

describe('errorMessage', () => {
  it('unwraps errors and stringifies anything else', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage('plain')).toBe('plain')
  })
})