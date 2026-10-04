/**
 * Bounded shell-tool startup: turns an unbounded "command running" stall into one
 * actionable error.
 *
 * ## The failure this exists for
 *
 * Minimal mode's shell tool is `@deepseek-ai/dsh-tool-pwsh-persistent`, which runs
 * commands over a persistent PTY session. That session must first reach
 * *readiness*: `dsh-terminal-bash` installs a PowerShell `prompt` function that
 * emits an OSC `133;D;` marker, and accepts only `waitReason === 'stdin_read'` as
 * evidence that the shell is up.
 *
 * On Windows under the ACL sandbox's `read-only` mode, pwsh starts in
 * ConstrainedLanguage, where that bootstrap's `[Console]::Write` fails with
 * "Cannot create type. Only core types are supported in this language mode." The
 * marker is then never emitted. Because the Windows process inspector reports
 * `isStdinWaiting() === false`, the marker is the *only* path to `stdin_read`; the
 * startup loop ignores the `inferred_idle` fallback and re-sends forever. The tool
 * call therefore produces nothing until the backend's own 300s deadline.
 *
 * ## What this plugin does
 *
 * It wraps `tools/execute` for the configured shell tool names and bounds a call
 * **until that Agent's shell has booted once**, but only for a tool that must
 * complete a boot handshake ({@link isBootHandshake}) — minimal mode's persistent
 * shell tool. Before the first successful boot no command can be running, so a call
 * that has not returned by `bootTimeoutMs` is stalled in startup. The wrapper aborts
 * it (which unblocks the pending PTY spawn) and returns a structured failure naming
 * the likely cause.
 *
 * The one-shot shell tool used by Standard / PTC / Creator mode accepts its own
 * per-command budget and runs a real command on every call, so its first call may
 * legitimately be slow; it is never bounded.
 *
 * After the first successful boot the bound is dropped for that Agent, so
 * long-running commands keep their configured budget. A bounded call that fails
 * does not mark the shell booted, so a retry is bounded again instead of silently
 * reverting to the 300s stall.
 *
 * @module @local/dsh-shell-boot-timeout
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'shell-boot-timeout'

/**
 * Injected service. Only the tool registry is needed: the wrapper observes the
 * existing `tools/execute` waterfall, so it registers no tool, changes no preset,
 * and needs no `terminals` provider (minimal mode's `terminals` lives inside the
 * preset's isolated realm, where a host-plane row could not reach it anyway).
 */
export const inject = ['tools']

/** Error code for the bounded-startup failure. */
const BOOT_TIMEOUT = 'SHELL_BOOT_TIMEOUT'

/**
 * Failure text names the cause so neither the model nor the user retries blindly.
 * @param toolName - the shell tool that stalled.
 * @param ms - the elapsed budget.
 * @returns the model-facing explanation.
 */
function bootTimeoutMessage(toolName, ms) {
  return (
    `the shell behind the \`${toolName}\` tool never reported readiness within ${ms}ms, so no command was run. ` +
    'The persistent shell could not finish starting. On Windows this usually means the shell bootstrapped in ' +
    'PowerShell ConstrainedLanguage — which happens when the session runs under the ACL sandbox `read-only` mode — ' +
    "so the backend's readiness marker could never be installed. " +
    'Switch the permission preset to `workspace-write` (or `danger-full-access`) and try again, ' +
    'or use a mode whose shell tool does not require a boot handshake (Standard / PTC / Creator mode).'
  )
}

/**
 * Build the structured failure result the tool registry returns unchanged, mirroring
 * the shape `@deepseek-ai/dsh-tool-call-timeout-policy` publishes.
 * @param message - model-facing explanation.
 * @returns the `isError` tool result.
 */
function bootTimeoutResult(message) {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
    error: { message, info: { name: 'ShellBootTimeoutError', code: BOOT_TIMEOUT } },
  }
}

/**
 * Parse a leading `major.minor.patch` run out of a version string.
 * Dependency-free on purpose: this bundle stays import-free so it cannot fail to
 * resolve a package the profile happens to absent.
 * @param value - a semver-ish string such as `0.2.0-rc.2`.
 * @returns the numeric triple, or undefined when unparsable.
 */
function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? '').trim())
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * Compare two version triples.
 * @param a - left triple.
 * @param b - right triple.
 * @returns negative, zero, or positive like a comparator.
 */
function compareVersion(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

/**
 * Resolve the running `@deepseek-ai/dsh` version, or undefined when unavailable.
 * @returns the version string, best effort.
 */
function runningDshVersion() {
  try {
    const require = process.getBuiltinModule('node:module').createRequire(import.meta.url)
    return require('@deepseek-ai/dsh/package.json').version
  } catch {
    return undefined
  }
}

/**
 * Whether this call is a shell *boot handshake* — the only kind of call that can
 * stall before any command runs, and therefore the only kind worth bounding.
 *
 * This is the discriminator that keeps the plugin from breaking modes that work:
 *
 *  - Minimal mode's shell tool is `@deepseek-ai/dsh-tool-pwsh-persistent`. Its
 *    schema accepts **only** `command`, because it runs over a persistent PTY and
 *    must complete a boot handshake first.
 *  - Standard / PTC / Creator mode's shell tool is `@deepseek-ai/dsh-tool-pwsh`.
 *    Its schema also accepts `timeoutMs` and `description`, because every call is a
 *    real `pwsh -Command` with a caller-controlled budget.
 *
 * A tool that accepts a per-command budget is already bounded, and its first call
 * may legitimately be slow (`npm install`, a test suite). Bounding it would kill
 * real work, so this returns false for it.
 *
 * `defineTool` normalizes `parameters` into a JSON Schema, so the check reads
 * `properties`. An unreadable or unrecognized schema returns false: refusing to
 * bound restores the previous behaviour instead of inventing a new failure in a
 * mode that works.
 *
 * @param ctx - plugin context carrying the tool registry.
 * @param exec - the allowed call about to dispatch.
 * @returns whether the call is a shell boot handshake.
 */
function isBootHandshake(ctx, exec) {
  const properties = ctx.tools?.get?.(exec.name, exec.agent)?.parameters?.properties
  if (properties === undefined || properties.command === undefined) return false
  return properties.timeoutMs === undefined && properties.description === undefined
}

/**
 * Register the bounded-startup wrapper.
 * @param ctx - plugin context carrying the tool registry.
 * @param config - shell tool names, the startup budget, and the verified floor.
 */
export function apply(ctx, config) {
  const toolNames = new Set(Array.isArray(config?.toolNames) ? config.toolNames : ['pwsh', 'bash'])
  const bootTimeoutMs = config?.bootTimeoutMs ?? 20000
  if (!Number.isSafeInteger(bootTimeoutMs) || bootTimeoutMs <= 0) {
    throw new Error('shell-boot-timeout: bootTimeoutMs must be a positive safe integer')
  }
  if (toolNames.size === 0) throw new Error('shell-boot-timeout: toolNames must name at least one tool')

  // Soft version guard: version drift must degrade to a log line, never to a failed
  // profile. `verifiedFloor` is the release this behaviour was reproduced against.
  const verifiedFloor = parseVersion(config?.verifiedDshVersion ?? '0.2.0-rc.2')
  if (verifiedFloor !== undefined) {
    const actual = runningDshVersion()
    const parsed = parseVersion(actual)
    if (parsed === undefined) {
      ctx.logger?.warn('shell-boot-timeout: could not determine the running @deepseek-ai/dsh version')
    } else if (parsed[0] !== verifiedFloor[0] || compareVersion(parsed, verifiedFloor) < 0) {
      ctx.logger?.warn(
        `shell-boot-timeout: @deepseek-ai/dsh ${actual} is outside the verified range ` +
          `(>= ${verifiedFloor.join('.')}, major ${verifiedFloor[0]}); the tools/execute wrapper may need updating`,
      )
    }
  }

  /** Agents whose shell has already booted successfully; their calls are never bounded. */
  const booted = new WeakSet()

  ctx.on('tools/execute', async (exec, next) => {
    if (!toolNames.has(exec.name)) return next()
    // Only a boot handshake can stall before any command runs. A tool that accepts
    // its own per-command budget runs a real command immediately, so its first call
    // is not a handshake and must keep that budget.
    if (!isBootHandshake(ctx, exec)) return next()
    const agent = exec.agent
    // Agentless calls have no per-Agent shell to reason about; leave them untouched.
    if (agent === undefined || booted.has(agent)) return next()

    const upstream = exec.signal
    if (upstream.aborted) return next()

    // Mirror the shipped timeout policy: replace only exec.signal, and restore it.
    // The registry re-fuses the original caller signal, so caller cancellation is
    // never detached.
    const controller = new AbortController()
    const forwardAbort = () => { controller.abort(upstream.reason) }
    upstream.addEventListener('abort', forwardAbort, { once: true })
    exec.signal = controller.signal

    let timer
    let timedOut = false
    const expired = new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut = true
        // Abort first: this unblocks the pending PTY spawn, so the abandoned call
        // stops working instead of running to the backend's own deadline.
        controller.abort(new Error(`${name}: shell startup exceeded ${bootTimeoutMs}ms`))
        resolve('expired')
      }, bootTimeoutMs)
    })

    try {
      const call = Promise.resolve().then(() => next())
      // Keep an abandoned rejection from surfacing as an unhandled rejection; the
      // race below still observes the failure when the call wins.
      call.catch(() => {})
      const outcome = await Promise.race([call, expired])
      if (outcome === 'expired') {
        const message = bootTimeoutMessage(exec.name, bootTimeoutMs)
        ctx.logger?.warn(`shell-boot-timeout: ${exec.name} did not reach readiness within ${bootTimeoutMs}ms`)
        return bootTimeoutResult(message)
      }
      // Returning a normal result proves the shell booted and produced output, so this
      // Agent is released from bounding. An `isError` result is NOT that proof: the
      // tool reports a nonzero command exit as a normal result, so `isError` means the
      // tool itself failed (no PTY backend, spawn failure) and the shell may still be
      // unbootable. Staying bounded there is what upholds "never spin": a retry is
      // bounded again instead of silently reverting to the backend's 300s stall.
      if (outcome?.isError !== true) booted.add(agent)
      return outcome
    } catch (error) {
      // A genuine failure propagates; the Agent stays unmarked, so a retry is
      // bounded again rather than silently reverting to the backend's 300s stall.
      if (timedOut) return bootTimeoutResult(bootTimeoutMessage(exec.name, bootTimeoutMs))
      throw error
    } finally {
      clearTimeout(timer)
      exec.signal = upstream
      upstream.removeEventListener('abort', forwardAbort)
    }
  })
}
