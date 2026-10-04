# dsh-shell-boot-timeout

English | [中文](README.zh.md)

A **small, single-file** [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin.

It adds **one** `tools/execute` listener that bounds the first shell-tool call, so a
persistent shell which never finishes starting reports one clear error instead of
spinning silently until the backend's own deadline.

It is deliberately tiny: **zero dependencies**, one file, one inserted row in the
profile patch. It patches no shipped package and changes no preset.

---

## Verified version range

**Read this before installing.** This is a workaround pinned to specific upstream
behaviour, so the version matters.

| | Version |
|---|---|
| **Verified against** | `@deepseek-ai/dsh` **0.2.0-rc.2** |
| **Declared range** (`package.json` → `dsh.supported`) | `>=0.2.0-rc.2 <0.3.0` |
| **Platform verified** | **Windows only** |
| **Not tested** | `0.1.x`, `0.3.x`, macOS, Linux |

The declared range is an expectation, not a guarantee: the behaviour it depends on was
only reproduced on `0.2.0-rc.2`. The version guard is **soft** — on an unverified
version the plugin logs a warning and keeps working, rather than failing your profile.

**What it depends on**, and therefore what an upstream change could break:

- the Cordis `tools/execute` waterfall (mode, ordering, signal-replacement rules);
- `defineTool` normalizing `parameters` into a JSON Schema with `properties`;
- the two shipped shell tools' parameter shapes (see *How it decides what to bound*).

If a future release changes any of those, the plugin degrades to **not bounding** — its
handshake check returns `false` rather than inventing a new failure in a mode that
works.

---

## The problem it solves

In **Minimal mode**, the shell tool is `@deepseek-ai/dsh-tool-pwsh-persistent`, which
runs commands over a **persistent PTY session**. Its first call must spawn the shell
and wait for *readiness*.

`dsh-terminal-bash` installs a PowerShell `prompt` function that emits an OSC `133;D;`
marker, and accepts **only** `waitReason === 'stdin_read'` as proof the shell is up:

```js
"function prompt { [Console]::Write([char]27 + ']133;D;' + [int]$LASTEXITCODE + [char]7); 'dsh> ' }"
```

On Windows, under the ACL sandbox's **`read-only`** mode, pwsh starts in
**ConstrainedLanguage** (its AppLocker temp probe cannot write). There
`[Console]::Write` fails with:

```
InvalidOperation: Cannot create type. Only core types are supported in this language mode.
```

So the marker is **never emitted**. Because the Windows process inspector reports
`isStdinWaiting() === false`, the marker is the *only* route to `stdin_read`; the
startup loop ignores the `inferred_idle` fallback and re-sends forever. Nothing is ever
executed, so nothing can fail — the call just hangs.

Required combination: **Minimal mode + `read-only` sandbox.** Other modes use the
one-shot `pwsh` tool, which needs no boot handshake and works under every mode.

---

## What it does — and does not do

**Does:** turn that silent stall into a fast, structured error:

```
Error: the shell behind the `pwsh` tool never reported readiness within 20000ms, so no
command was run. ... Switch the permission preset to `workspace-write` ...
```

It aborts the call first, which unblocks the pending PTY spawn, so the abandoned call
stops instead of running to the backend deadline.

**Does not:** make `pwsh` work in Minimal + `read-only`. The stall is an upstream
bootstrap bug that a profile plugin cannot fix; this only makes the failure fast and
self-explanatory.

### How it decides what to bound

Bounding must **not** apply to Standard / PTC / Creator mode, where the tool is the
one-shot `pwsh` and the *first* call is already a real command (`npm install`, a test
suite) that may legitimately outlast any fixed budget. The two tools are told apart by
their declared parameters:

| Tool | Mode | Declares | Bounded? |
|---|---|---|---|
| `@deepseek-ai/dsh-tool-pwsh` | standard, ptc, cordis | `command`, `description`, `timeoutMs`, `workdir` | **no** |
| `@deepseek-ai/dsh-tool-pwsh-persistent` | minimal | `command` only | **yes** |

A tool that accepts its own per-command `timeoutMs` runs a real command immediately, so
it is already bounded by the caller and is left alone. An unreadable or unrecognized
schema also returns "not bounded".

### Retry safety

A bounded call that fails does **not** mark the shell booted, so a retry is bounded
again instead of silently reverting to the 300s stall. After a genuine successful boot
the bound is dropped for that Agent, so long-running commands keep their configured
budget.

---

## Install

This plugin is a DSH **bundle**: a package whose `package.json` declares
`dsh.bundle.patch`. Install it with the plugin manager (`install_bundle`, given this
directory), which performs package installation and bundle selection itself.

> **Package vs repository name.** The package is named
> `@local/dsh-shell-boot-timeout`; the repository is named for the patch row id
> (`shell-boot-timeout`). The package is `private: true` and never published to npm —
> `@local/` is just a convention for local-only bundles, so the name only matters for
> DSH's module resolution.

> **pnpm ≥ 10 is required.** DSH's profile scaffold reads pnpm settings from
> `pnpm-workspace.yaml`, which only pnpm ≥ 10 does; pnpm 9 fails with
> `ERR_PNPM_ADDING_TO_ROOT`. This is an environment requirement, not specific to this
> plugin.

Editing the module file requires a **host restart** to take effect: Node's ESM loader
caches the imported module, so toggling the row off and on re-uses the old code.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `bootTimeoutMs` | `20000` | Budget for the first shell-tool call. Raise on a very slow host. |
| `toolNames` | `['pwsh', 'bash']` | Tool names eligible to be bounded; the handshake check still applies. |
| `verifiedDshVersion` | `0.2.0-rc.2` | Verified floor; drift below it logs a warning only. |

Invalid configuration throws at activation (a non-positive `bootTimeoutMs`, or an empty
`toolNames`).

## Tests

Both suites run on plain Node — no DSH boot, no network:

```sh
node tests/offline.test.mjs        # 12 cases: timeout, pass-through, retry safety, config
node tests/discriminator.test.mjs  #  7 cases: the real shipped tool declarations
```

`discriminator.test.mjs` reads the parameter names out of the shipped tools' own source
and normalizes them with DSH's own `parameterSchemaSpecToJsonSchema`, so the
"bounded?" decision is proven against the real declarations rather than hand-written
fakes. It needs an installed `@deepseek-ai/dsh` to read those files from.

## Design notes

- **No preset override.** A profile patch cannot reach inside a preset's `plugins`
  list — that list is `config` data of the `preset-<id>` row, not a Loader group. A
  patch targeting `persistent-shell` reports `patch insert: entry "persistent-shell"
  not found`. Targeting `preset-minimal` instead would mean restating the entire
  shipped preset on every upgrade.
- **No `terminals` injection.** Minimal mode's `terminals` provider lives inside the
  preset's `isolate: terminals: true` realm, which a host-plane row cannot reach. The
  `tools/execute` waterfall is the public seam that sees every preset.
- **Minimal write surface:** one inserted row, one injected service (`tools`), no new
  tool, no prompt change, no change to any mode that already works.

## License

MIT
