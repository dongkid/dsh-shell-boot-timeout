/**
 * Offline unit harness for the shell-boot-timeout wrapper.
 *
 * Runs the real plugin entry against a fake Cordis context, so the timeout,
 * pass-through, discriminator, and retry-safety paths are proven without booting
 * DSH.
 *
 * Run: node tests/offline.test.mjs
 */
import { apply, inject, name } from '../index.js'

/** Tool shapes as `defineTool` normalizes them (parameters are a JSON Schema). */
const PERSISTENT_PWSH = {
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
}
const ONE_SHOT_PWSH = {
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      description: { type: 'string' },
      timeoutMs: { type: 'number' },
      workdir: { type: 'string' },
    },
    required: ['command', 'description'],
  },
}

const listeners = []
const warnings = []
const definitions = new Map()
const ctx = {
  logger: { warn: (message) => warnings.push(String(message)) },
  on(event, handler) { if (event === 'tools/execute') listeners.push(handler) },
  tools: { get: (toolName) => definitions.get(toolName) },
}
apply(ctx, {
  bootTimeoutMs: 300,
  toolNames: ['pwsh', 'bash'],
  verifiedDshVersion: '0.2.0',
})

const waterfall = listeners[0]
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let failures = 0

function check(label, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  (${detail})`}`)
}

/** Register which shape the fake registry reports for `pwsh`, then dispatch. */
async function dispatch({ toolName = 'pwsh', agent, next, shape = PERSISTENT_PWSH, signal }) {
  definitions.set(toolName, shape)
  return waterfall({ name: toolName, agent, signal: signal ?? new AbortController().signal }, next)
}

console.log(`plugin: name=${name} inject=${JSON.stringify(inject)} listeners=${listeners.length}\n`)

// 1. A persistent-shell boot handshake that stalls must fail fast and structured.
{
  const started = Date.now()
  const result = await dispatch({ agent: { id: 's1' }, next: () => new Promise(() => {}) })
  check(
    'stalling persistent handshake -> structured SHELL_BOOT_TIMEOUT',
    result?.isError === true && result.error?.info?.code === 'SHELL_BOOT_TIMEOUT',
    `${Date.now() - started}ms`,
  )
}

// 2. REGRESSION GUARD: the one-shot tool's FIRST call must never be bounded, even
// when it is slow. This is the mode that already worked.
{
  const value = { isError: false, value: 'slow-first-command-ok', content: [] }
  const started = Date.now()
  const result = await dispatch({
    agent: { id: 's2' },
    shape: ONE_SHOT_PWSH,
    next: async () => { await sleep(600); return value },
  })
  const elapsed = Date.now() - started
  check('one-shot first call is NOT bounded (600ms > 300ms budget)', result === value, `${elapsed}ms`)
}

// 3. An unrecognized/unreadable schema is not bounded: fail safe, never invent a
// failure in a mode that works.
{
  const value = { isError: false, value: 'unknown-shape-ok', content: [] }
  const result = await dispatch({
    agent: { id: 's3' },
    shape: { parameters: { type: 'object', properties: {} } },
    next: async () => { await sleep(500); return value },
  })
  check('unrecognized schema -> not bounded', result === value)
}

// 4. A healthy persistent handshake passes through by identity and releases the Agent.
// The Agent object is reused across calls, matching production: the registry hands
// the same Agent instance to every call from one session, and the shipped timeout
// policy and `ctx.terminals` owner maps all key on that identity.
{
  const agent = { id: 's4' }
  const value = { isError: false, value: 'ok', content: [] }
  const first = await dispatch({ agent, next: async () => value })
  check('healthy persistent handshake -> returned untouched', first === value)

  const slow = { isError: false, value: 'slow-later-call', content: [] }
  const started = Date.now()
  const later = await dispatch({ agent, next: async () => { await sleep(500); return slow } })
  const elapsed = Date.now() - started
  check('after a successful boot, a slow later call is unbounded', later === slow, `${elapsed}ms`)
}

// 5. Non-shell tools are never touched.
{
  const value = { isError: false, value: 'read-ok', content: [] }
  const result = await dispatch({
    toolName: 'read',
    agent: { id: 's5' },
    shape: PERSISTENT_PWSH,
    next: async () => value,
  })
  check('non-shell tool (read) -> untouched', result === value)
}

// 6. An already-aborted upstream short-circuits to next().
{
  const controller = new AbortController()
  controller.abort(new Error('user cancelled'))
  const value = { isError: true, error: { message: 'aborted' }, content: [] }
  const result = await dispatch({ agent: { id: 's6' }, signal: controller.signal, next: async () => value })
  check('already-aborted upstream -> short-circuits', result === value)
}

// 7. A genuine failure propagates instead of being masked as a timeout.
{
  const boom = new Error('real spawn failure')
  try {
    await dispatch({ agent: { id: 's7' }, next: async () => { throw boom } })
    check('failing handshake -> original error propagates', false, 'no throw')
  } catch (error) {
    check('failing handshake -> original error propagates', error === boom, String(error.message))
  }
}

// 8. CRITICAL: a bounded failure must not release the Agent, or the retry reverts
// to the backend's 300s stall — the exact bug this plugin exists to remove.
{
  const agent = { id: 's8' }
  const first = await dispatch({ agent, next: () => new Promise(() => {}) })
  const started = Date.now()
  const second = await dispatch({ agent, next: () => new Promise(() => {}) })
  const elapsed = Date.now() - started
  check(
    'retry after a bounded failure is bounded again',
    first?.error?.info?.code === 'SHELL_BOOT_TIMEOUT' && second?.error?.info?.code === 'SHELL_BOOT_TIMEOUT' && elapsed < 1000,
    `${elapsed}ms`,
  )
}

// 9. An `isError` result keeps the Agent bounded on purpose: the tool reports a
// nonzero command exit as a NORMAL result, so `isError` means the tool failed and
// the shell may still be unbootable.
{
  const agent = { id: 's9' }
  await dispatch({
    agent,
    next: async () => ({ isError: true, error: { message: 'no PTY backend registered' }, content: [] }),
  })
  const started = Date.now()
  const result = await dispatch({ agent, next: () => new Promise(() => {}) })
  const elapsed = Date.now() - started
  check('an isError result keeps the Agent bounded', result?.error?.info?.code === 'SHELL_BOOT_TIMEOUT' && elapsed < 1000, `${elapsed}ms`)
}

// 10. exec.signal is restored, so caller cancellation is never detached.
{
  const original = new AbortController().signal
  definitions.set('pwsh', PERSISTENT_PWSH)
  const received = { name: 'pwsh', agent: { id: 's10' }, signal: original }
  await waterfall(received, async () => ({ isError: false, value: 1, content: [] }))
  check('exec.signal restored after dispatch', received.signal === original)
}

// 11. Invalid configuration fails loudly at activation, not silently.
{
  let threw = false
  try {
    apply({ logger: { warn() {} }, on() {}, tools: { get: () => undefined } }, { bootTimeoutMs: -1 })
  } catch {
    threw = true
  }
  check('invalid bootTimeoutMs throws at activation', threw)
}

console.log(`\ntimeout warnings: ${warnings.filter((w) => w.includes('did not reach readiness')).length}`)
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
