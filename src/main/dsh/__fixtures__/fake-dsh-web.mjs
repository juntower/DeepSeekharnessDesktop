// Minimal stand-in for `dsh web`: prints the tokenised loopback address the real CLI prints and
// answers HTTP on it, so the supervisor's readiness handshake can be tested end to end.
import { createServer } from 'node:http'

const calls = process.argv.slice(2)
const portIndex = calls.indexOf('--port')
const requestedPort = Number(portIndex === -1 ? '0' : calls[portIndex + 1])
const token = process.env.FAKE_DSH_TOKEN ?? 'test-token'

// Used by the crash-handling test: fail the way a broken runtime would.
const exitCode = process.env.FAKE_DSH_EXIT_CODE
if (exitCode !== undefined && exitCode !== '') {
  process.stdout.write('dsh web: starting up\n')
  process.exit(Number(exitCode))
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (url.searchParams.get('token') === token) {
    response.writeHead(303, { location: '/' })
    response.end()
    return
  }
  response.writeHead(401, { 'content-type': 'text/plain' })
  response.end('unauthorised')
})

server.listen(requestedPort, '127.0.0.1', () => {
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : requestedPort
  const announce = () => {
    process.stdout.write('dsh web: http://127.0.0.1:' + String(port) + '/?token=' + token + '\n')
  }
  const delay = Number(process.env.FAKE_DSH_DELAY_MS ?? '0')
  if (Number.isFinite(delay) && delay > 0) setTimeout(announce, delay)
  else announce()
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => { server.close(() => { process.exit(0) }) })
}