# Agent Rules — src/ (the Beeper bridge)

Applies to `src/beeper-mcp-shim.mjs` and `test/`.

- **Keep the shim zero-dependency and Node-only.** It runs on bare hosts with
  nothing but Node ≥ 22.5. Do not add npm dependencies.
- **Never commit secrets.** Beeper credentials live at
  `~/.config/beeper-mcp-shim/credential.json` (mode 600), outside the repo.
  Treat `opencode.db` and any token output as private.
- **Stdout is the MCP channel.** Only JSON-RPC goes to stdout; all logging
  goes to stderr. Never write a secret to stdout or the logs.
- **Verify, don't assume.** `beeper-mcp-shim status` proves the token works.
- Run `npm test` and `npm run check` before opening a PR.
