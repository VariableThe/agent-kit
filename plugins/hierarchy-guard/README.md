# hierarchy-guard

OpenCode plugin (V2 API, verified against opencode v2.0.29) that re-enforces
each agent's configured `permissions` rules after the runtime resolves its
own rules.

## What it enforces

Every agent's `permissions` list from the live `opencode.json` is
re-evaluated on each permission check. When the agent's own policy denies an
action, the plugin forces `effect: "deny"` — even if a client layer appended
a session-level `allow` that would otherwise win under the runtime's
last-match-wins resolution. Without this, read-only agents (e.g. `bishop`)
were observed executing shell/edit calls a client allow had re-enabled.

## Precedence

The plugin's `permission.hook("evaluate")` runs AFTER the runtime resolves
agent rules + session/client rules, and it can only tighten the decision: it
never upgrades `deny`/`ask` to `allow`, and it leaves agents with no
configured policy untouched. Pure helpers live in `policy.mjs` (no opencode
imports, unit-tested); `index.ts` is the thin hook wiring.

## Opt-out

`HIERARCHY_GUARD_OFF=1` disables the plugin entirely (setup returns early,
no hooks registered).

## Fail-safe

Every path is defensive: a missing/malformed config yields an empty policy
(never throws), unexpected event shapes are ignored, and setup never throws.
A broken plugin behaves exactly as if it were absent — it never breaks the
agent loop. For the shell tool, the `tool.hook("execute.before")` path is
audit-only (one stderr line on deny); enforcement there is the permission
hook, because the shell path ignores input mutation.

## execute tool

The execute (Code Mode JS) tool carries no `permission` field in v2.0.29 and
triggers no `permission.evaluate` events, yet its sandbox exposes
`require()`/`child_process` — a shell-equivalent bypass for agents denied
shell. The plugin gates it in `tool.hook("execute.before")`: when the
session agent's policy denies unconstrained shell (action `"shell"` over
resource `"*"`), the hook replaces `event.input` with `{ code: "" }` and
logs the same structured stderr line. Verified 2026-10-17 against the live
binary: unlike the shell path, the execute path honors the replacement —
the tool errors with `Code cannot be empty`, no JS runs, and an `execSync`
filesystem marker is never created. Agents whose policy allows shell, and
agents with no configured policy, are untouched.

### T3 Code exemption

Under the T3 Code harness the neutering is skipped for a short exempt list
(`build`, i.e. Monarch) — see `EXECUTE_NEUTER_EXEMPT_AGENTS` in `policy.mjs`.
This is safe because the T3 Code `execute` sandbox is a restricted JS
interpreter, not the general runtime the v2.0.29 gate was written for.
Probed 2026-10-17 in a live T3 Code session: `typeof require` and
`typeof process` are `undefined`, `globalThis` is rejected as an unknown
identifier, dynamic `import` is unsupported, `fetch('file:///etc/hostname')`
fails with "fetch cannot be used for filesystem access", and an
`execSync`/`writeFileSync` escape created no marker file (the same session's
shell created one, and shell stays gated). Neutering there bought nothing and
cost Monarch its entire Code Mode catalog — the only route to the browser
tools, the MCP servers (context7, playwright, beeper, opencode_console) and
the T3 Code app tools — surfacing as "Code cannot be empty." on every call.

The gate is the environment, not the client name: `isT3CodeHarness` returns
true when `process.env` has any own enumerable key beginning `T3CODE_` with a
non-empty string value (prefix-based, so a renamed `T3CODE_*` variable still
detects the harness). Detection came from environment evidence — a T3 Code
session exposes `T3CODE_CLI_PATH=/home/decon/.t3/bin/t3` and other `T3CODE_*`
keys, while native OpenCode CLI/service sessions expose none. Every other
agent (bishop, witch, grand-bishop) keeps the neutering under T3 Code, native
sessions keep it for all agents, and `permission.hook("evaluate")` remains the
authoritative enforcer regardless.

## T3 Code agent identity (verified 2026-10-17)

T3 Code runs its primary thread as `build` and does apply that agent's
configured system text. Passing the intended worker to the subagent tool's
`agent` parameter **does** set the child session's identity — enforcement then
matches that identity. Observed today: `bishop` ran as `bishop` on
`opencode/beam-free` with shell/edit/glob denied by this plugin, and `knight`
ran as `knight` on `opencode/deepseek-v4.1-flash-free` with shell/edit/execute
working. So a delegated session is policed as the agent it was asked to be;
only the primary T3 Code thread is fixed at `build`.

## Install wiring

The installer symlinks the whole directory to
`~/.config/opencode/plugins/hierarchy-guard`, which OpenCode
auto-discovers — no config change. `package.json` carries no dependencies:
`@opencode/plugin` is host-provided at runtime, never vendored. Tests live
at `test/hierarchy-guard-policy.test.mjs` (plus `test/hierarchy-guard-e2e.sh`,
not wired into `npm test`: it needs network access and the opencode binary).
