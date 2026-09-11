// Minimal stand-in for the bundled npm CLI: it only has to produce the on-disk layout of an
// installed @deepseek-ai/dsh package, so DshRuntimeManager can be exercised without a real
// (multi-minute, network dependent) npm install.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const calls = process.argv.slice(2)
const prefixIndex = calls.indexOf('--prefix')
const prefix = prefixIndex === -1 ? process.cwd() : calls[prefixIndex + 1]
const spec = calls.filter((item) => item.startsWith('@deepseek-ai/dsh@')).pop() ?? '@deepseek-ai/dsh@0.0.0'
const requested = spec.slice('@deepseek-ai/dsh@'.length)
const resolved = requested === 'latest' ? (process.env.FAKE_NPM_LATEST_VERSION ?? '1.0.0') : requested

// Every invocation is recorded so a test can prove that an install was not duplicated.
const counter = process.env.FAKE_NPM_COUNTER
if (counter !== undefined && counter !== '') appendFileSync(counter, requested + '\n', 'utf8')

const delay = Number(process.env.FAKE_NPM_DELAY_MS ?? '0')
if (Number.isFinite(delay) && delay > 0) {
  await new Promise((resolve) => setTimeout(resolve, delay))
}

const packageDir = join(prefix, 'node_modules', '@deepseek-ai', 'dsh')
mkdirSync(join(packageDir, 'lib'), { recursive: true })
writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: resolved }) + '\n', 'utf8')
writeFileSync(join(packageDir, 'lib', 'bin.js'), 'process.exit(0)\n', 'utf8')
process.stdout.write('added 519 packages in 3m\n')