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

## Known limitation: T3 Code agent identity

T3 Code's adapter hardcodes thread/child OpenCode agent to `build` and
writes session-level rules, so T3-spawned sessions carry `agent: "build"`;
the plugin cannot know they were meant to be bishop/knight. Enforcement
applies wherever the session's agent identity matches a configured agent.
When delegating via the subagent tool, pass the intended worker as the
tool's `agent` parameter so the session runs under the correct identity.

## Install wiring

The installer symlinks the whole directory to
`~/.config/opencode/plugins/hierarchy-guard`, which OpenCode
auto-discovers — no config change. `package.json` carries no dependencies:
`@opencode/plugin` is host-provided at runtime, never vendored. Tests live
at `test/hierarchy-guard-policy.test.mjs` (plus `test/hierarchy-guard-e2e.sh`,
not wired into `npm test`: it needs network access and the opencode binary).
