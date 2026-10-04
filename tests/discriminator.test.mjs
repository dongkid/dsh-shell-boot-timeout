/**
 * Verify the plugin's boot-handshake discriminator against the REAL shipped tool
 * schemas.
 *
 * The plugin decides "is this a shell boot handshake?" by reading the normalized
 * JSON Schema `defineTool` produces, specifically which top-level parameter names
 * exist. This test reads those names from the shipped tools' own source, feeds them
 * through DSH's own `parameterSchemaSpecToJsonSchema`, and then runs the plugin's
 * real guard over the resulting schema.
 *
 * So the shapes under test are the tools' actual declared parameter names — not
 * hand-written fakes — and the schema normalization is DSH's, not ours.
 *
 * Run: node tests/discriminator.test.mjs
 */
import { readFileSync } from 'node:fs'
import { apply } from '../index.js'

const DSH_ROOT = 'C:/Users/dongkid/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/'
const { parameterSchemaSpecToJsonSchema } = await import('file:///' + DSH_ROOT + 'dsh-tools/lib/index.js')

/**
 * Read a tool's top-level parameter names out of its `defineTool({ parameters: {…} })`
 * literal. The literal contains build-time conditionals, so only the depth-1 keys
 * are read — which is exactly the set the plugin's discriminator consults.
 *
 * @param source - the tool module's source text.
 * @returns the declared parameter names, in declaration order.
 */
function declaredParameterNames(source) {
  const marker = 'parameters: {'
  const start = source.indexOf(marker)
  if (start < 0) throw new Error('parameters: { not found')
  const open = source.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let index = open; index < source.length; index += 1) {
    const character = source[index]
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) { end = index; break }
    }
  }
  if (end < 0) throw new Error('unbalanced parameters object')
  const body = source.slice(open + 1, end)
  const names = []
  let localDepth = 0
  for (const line of body.split('\n')) {
    if (localDepth === 0) {
      const match = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(line)
      if (match !== null) names.push(match[1])
    }
    for (const character of line) {
      if (character === '{' || character === '[' || character === '(') localDepth += 1
      else if (character === '}' || character === ']' || character === ')') localDepth -= 1
    }
  }
  return names
}

const oneShotNames = declaredParameterNames(readFileSync(DSH_ROOT + 'dsh-tool-pwsh/lib/index.js', 'utf8'))
const persistentNames = declaredParameterNames(readFileSync(DSH_ROOT + 'dsh-tool-pwsh-persistent/lib/index.js', 'utf8'))

/** Rebuild the normalized schema DSH would derive from a declared name set. */
function normalizedSchema(names) {
  // This dialect marks required parameters with `required: true` and omits the key
  // entirely otherwise (`required: false` is rejected by the schema compiler), while
  // the normalized output always carries every property name.
  return parameterSchemaSpecToJsonSchema(
    Object.fromEntries(names.map((name) => [name, name === 'command' ? { type: 'string', required: true } : { type: 'string' }])),
  )
}

const oneShotSchema = normalizedSchema(oneShotNames)
const persistentSchema = normalizedSchema(persistentNames)

let failures = 0
function check(label, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  (${detail})`}`)
}

console.log('one-shot   pwsh (standard/PTC/Creator) declares:', oneShotNames.join(', '))
console.log('persistent pwsh (minimal)             declares:', persistentNames.join(', '))
console.log('normalized schema shape confirmed    :', JSON.stringify(Object.keys(persistentSchema.properties ?? {})))
console.log()

// The premise the discriminator rests on, read from the real declarations.
check('one-shot tool declares a per-command timeoutMs', oneShotNames.includes('timeoutMs'))
check('one-shot tool declares description', oneShotNames.includes('description'))
check('persistent tool does NOT declare timeoutMs', !persistentNames.includes('timeoutMs'))
check('persistent tool does NOT declare description', !persistentNames.includes('description'))
check('both tools declare command', oneShotNames.includes('command') && persistentNames.includes('command'))

/** Run the plugin's real guard for one tool definition. */
function guardFor(schema) {
  const listeners = []
  const definitions = new Map([['pwsh', { name: 'pwsh', parameters: schema }]])
  const ctx = {
    logger: { warn() {} },
    on(event, handler) { if (event === 'tools/execute') listeners.push(handler) },
    tools: { get: (toolName) => definitions.get(toolName) },
  }
  apply(ctx, { bootTimeoutMs: 50, toolNames: ['pwsh', 'bash'] })
  return listeners[0]
}

// The persistent tool must be bounded: a stalled boot returns the structured error.
{
  const waterfall = guardFor(persistentSchema)
  const result = await waterfall(
    { name: 'pwsh', agent: { id: 'real-minimal' }, signal: new AbortController().signal },
    () => new Promise(() => {}),
  )
  check(
    'real persistent tool IS bounded (stalled boot -> SHELL_BOOT_TIMEOUT)',
    result?.error?.info?.code === 'SHELL_BOOT_TIMEOUT',
  )
}

// The one-shot tool must never be bounded: a slow first real command survives.
{
  const waterfall = guardFor(oneShotSchema)
  const started = Date.now()
  const value = { isError: false, value: 'slow-real-command', content: [] }
  const result = await waterfall(
    { name: 'pwsh', agent: { id: 'real-standard' }, signal: new AbortController().signal },
    async () => { await new Promise((resolve) => setTimeout(resolve, 400)); return value },
  )
  const elapsed = Date.now() - started
  check(
    'real one-shot tool is NOT bounded (400ms slow first command survives a 50ms budget)',
    result === value && elapsed >= 400,
    `${elapsed}ms`,
  )
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
