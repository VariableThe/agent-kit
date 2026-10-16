# Global Agent Rules — Aditya (VariableThe)

Applies to every project and session. A project-local `AGENTS.md` overrides
this file on conflict; explicit user instructions override everything.
Format follows the open AGENTS.md spec (agents.md): setup, style, testing,
PR workflow. Writing conventions borrow from aaditagrawal/agentskills.

## Communication

- Short, direct, factual. No superlatives, praise, or emotional validation.
- No emojis unless the user asks or the task requires them.
- Reference code as `file_path:line_number`.
- Never invent URLs. Only share links you have verified (fetched, or returned
  by a tool such as `gh`).
- State hypotheses and evidence separately. If evidence contradicts an
  earlier claim, say so plainly.

## Verification

- Verify through execution: typecheck, lint, build, and the project's test
  suite. Read what each project defines before running generic commands.
- Prefer real data over synthetic fixtures (real user files, real API
  responses) when testing a fix end to end.
- Inspect files yourself before making factual claims. Cheap local checks
  beat speculation every time.

## Tool Use

- Prefer dedicated file tools over shell equivalents for reading and editing.
- Batch independent tool calls in parallel; sequence dependent ones.
- Never poll background work. Do one useful check, then wait to be resumed.

## Code Conventions

- Minimal diffs. Edit existing files; create new ones only when necessary.
- No new dependencies without need; reuse shared components and utilities;
  never duplicate existing functionality.
- Respect each repo's design system, theme, and UX patterns. Match, don't
  reinvent. Check for a local `AGENTS.md` (Next.js projects here carry
  breaking-change notices pointing at `node_modules/next/dist/docs/`).
- Keep trees clean: never commit unrelated files with your work.

## Quality Bar (after aaditagrawal/agentskills: no-slop, ai-taste)

- Specificity test: if the output could describe any project unchanged, it
  is too generic. Make it contextual or cut it.
- No hollow features: never ship UI backed by nothing (stub buttons, mock
  players, placeholder widgets with no data or endpoint behind them).
- No filler in user-facing copy. State what the thing does; the work speaks.
- Taste is selection: generate options, reject structurally ("fails
  because X"), keep what survives.

## Git Workflow

- **New project, no repo?** If the working directory is not inside a git
  repo, ask the user whether to run `git init` before doing significant
  work. Never initialize unprompted.
- **Ask before pushing.** After every major change (feature, fix, refactor),
  ask whether the user wants it pushed. Never push unprompted.
- **PRs only, never direct to main.** All work goes on a feature branch
  (`feat/...`, `fix/...`, `docs/...`) and is pushed as a Pull Request.
- **Pre-PR checks.** Run the project's checks (lint, typecheck, tests,
  build) before opening a PR. Don't open PRs with failing checks.
- **Focused PRs.** One concern per PR. Don't bundle unrelated files.
- **Conventional Commits.** `feat:`, `fix:`, `docs:`, etc., imperative mood.
- **Stale-PR check before EVERY push.** The user merges PRs at will, so an
  existing branch may already be merged upstream. Before pushing to an
  existing branch, run `gh pr list --head <branch>` (or
  `gh pr view <n> --json state`) and:
  - PR is OPEN → push normally.
  - PR is MERGED or CLOSED, or no PR exists → do NOT push to that branch.
    Create a new branch and open a new PR instead.
  - If the user has said a PR was merged, treat its branch as retired
    without needing to check.
- Report the PR link after creating one.
