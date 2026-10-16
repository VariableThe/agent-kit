#!/usr/bin/env node
// beeper-mcp-shim
//
// Bridges the MCP stdio transport to Beeper Desktop's local Streamable-HTTP
// MCP endpoint, so any machine that can `ssh` into the Beeper host can use
// Beeper as a normal MCP server.
//
// Modes:
//   (default)          serve  - stdio <-> HTTP MCP bridge
//   auth               run the Beeper OAuth flow (dynamic registration + PKCE)
//   auth --import-opencode   copy the token OpenCode already obtained
//   status             verify the stored token against Beeper
//   help
//
// Secrets are only ever read from disk or the OAuth flow, and are never
// written to stdout (stdout is the MCP channel) or logged.

import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import process from "node:process";

const require = createRequire(import.meta.url);

const DEFAULT_ENDPOINT = "http://127.0.0.1:23373/v0/mcp";
const ENDPOINT = process.env.BEEPER_MCP_URL || DEFAULT_ENDPOINT;
const ISSUER = new URL(ENDPOINT).origin;
const SCOPE = "read write";

function configDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() ? xdg : join(homedir(), ".config");
  return join(base, "beeper-mcp-shim");
}

function credentialPath() {
  return process.env.BEEPER_MCP_CRED || join(configDir(), "credential.json");
}

function log(...args) {
  process.stderr.write(`[beeper-mcp-shim] ${args.join(" ")}\n`);
}

// ---------------------------------------------------------------------------
// credential storage
// ---------------------------------------------------------------------------

function loadToken() {
  if (process.env.BEEPER_MCP_TOKEN) return process.env.BEEPER_MCP_TOKEN;
  const p = credentialPath();
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, "utf8"));
    return typeof data.access === "string" && data.access ? data.access : null;
  } catch (err) {
    log(`could not read credential: ${err.message}`);
    return null;
  }
}

function saveToken(access, metadata = {}) {
  const p = credentialPath();
  mkdirSync(dirname(p), { recursive: true });
  const body = { access, tokenType: "Bearer", expires: 0, ...metadata };
  writeFileSync(p, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
  log(`credential saved to ${p}`);
}

// ---------------------------------------------------------------------------
// SSE / transport helpers
// ---------------------------------------------------------------------------

export function parseSSE(text) {
  const out = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!data.length) continue;
    try {
      out.push(JSON.parse(data.join("\n")));
    } catch {
      // keep-alive or non-JSON comment; ignore
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// serve mode: stdio <-> HTTP bridge
// ---------------------------------------------------------------------------

async function serve() {
  const token = loadToken();
  if (!token) {
    log("no Beeper token found. Run `beeper-mcp-shim auth` (or `auth --import-opencode`) first.");
    process.exit(2);
  }

  let sessionId = null;
  let protocolVersion = null;
  let stdinEnded = false;
  let pending = 0;

  const writeMessage = (msg) => {
    process.stdout.write(JSON.stringify(msg) + "\n");
  };

  const maybeExit = () => {
    if (stdinEnded && pending === 0) process.exit(0);
  };

  async function forward(msg) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion;

    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify(msg),
      });
    } catch (err) {
      if (msg && msg.id != null) {
        writeMessage({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: `beeper bridge: ${err.message}` },
        });
      } else {
        log(`transport error: ${err.message}`);
      }
      return;
    }

    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;

    const body = await res.text();
    if (!res.ok && !body.trim()) {
      if (msg && msg.id != null) {
        writeMessage({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: `beeper bridge: HTTP ${res.status}` },
        });
      }
      return;
    }

    const ct = res.headers.get("content-type") || "";
    let messages = [];
    if (ct.includes("text/event-stream")) {
      messages = parseSSE(body);
    } else if (body.trim()) {
      try {
        messages = [JSON.parse(body)];
      } catch {
        log(`unparseable response body (${ct || "unknown content-type"})`);
      }
    }

    for (const m of messages) {
      if (!m || typeof m !== "object") continue;
      if (m.result && typeof m.result.protocolVersion === "string") {
        protocolVersion = m.result.protocolVersion;
      }
      writeMessage(m);
    }
  }

  function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      log("ignoring non-JSON line on stdin");
      return;
    }
    pending += 1;
    forward(msg).finally(() => {
      pending -= 1;
      maybeExit();
    });
  }

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      handleLine(line);
    }
  });
  process.stdin.on("end", () => {
    if (buffer.trim()) handleLine(buffer);
    stdinEnded = true;
    maybeExit();
  });
  process.stdin.on("error", (err) => log(`stdin error: ${err.message}`));

  const shutdown = () => process.exit(0);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ---------------------------------------------------------------------------
// auth mode
// ---------------------------------------------------------------------------

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function registerClient(redirectUri) {
  const res = await fetch(`${ISSUER}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "beeper-mcp-shim",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    }),
  });
  if (!res.ok) throw new Error(`registration failed: HTTP ${res.status} ${await res.text()}`);
  const data = await res.json();
  if (!data.client_id) throw new Error("registration response missing client_id");
  return data.client_id;
}

function openBrowser(url) {
  for (const [cmd, args] of [
    ["xdg-open", [url]],
    ["open", [url]],
  ]) {
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true });
      child.on("error", () => {});
      child.unref();
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

async function cmdAuth({ importOpencode }) {
  if (importOpencode) return importFromOpencode();

  const port = Number(process.env.BEEPER_MCP_CALLBACK_PORT || 0) || 0;
  const redirectUri = `http://127.0.0.1:${port || 0}/callback`;

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const err = url.searchParams.get("error");
      res.writeHead(200, { "content-type": "text/plain" });
      if (err || !code || state !== pending.state) {
        res.end("Authorization failed. You can close this tab.");
        reject(new Error(err || "authorization denied or state mismatch"));
        return;
      }
      res.end("Authorized. You can close this tab and return to the terminal.");
      try {
        const token = await exchangeCode(code, redirectUri, pending);
        saveToken(token.access_token, {
          metadata: { issuer: ISSUER, scope: SCOPE, serverUrl: ENDPOINT },
        });
        server.close();
        resolve();
      } catch (exchangeErr) {
        reject(exchangeErr);
      }
    });

    const pending = { state: base64url(randomBytes(16)), verifier: base64url(randomBytes(32)) };

    server.on("error", reject);
    server.listen(port, "127.0.0.1", async () => {
      const boundPort = server.address().port;
      const finalRedirect = `http://127.0.0.1:${boundPort}/callback`;
      try {
        const clientId = await registerClient(finalRedirect);
        const challenge = base64url(createHash("sha256").update(pending.verifier).digest());
        const authorize = new URL(`${ISSUER}/oauth/authorize`);
        authorize.searchParams.set("response_type", "code");
        authorize.searchParams.set("client_id", clientId);
        authorize.searchParams.set("redirect_uri", finalRedirect);
        authorize.searchParams.set("scope", SCOPE);
        authorize.searchParams.set("state", pending.state);
        authorize.searchParams.set("code_challenge", challenge);
        authorize.searchParams.set("code_challenge_method", "S256");
        authorize.searchParams.set("resource", ENDPOINT);
        pending.clientId = clientId;
        pending.redirectUri = finalRedirect;

        log("Open this URL in a browser on the Beeper host to approve access:");
        process.stderr.write(`\n  ${authorize.toString()}\n\n`);
        if (!openBrowser(authorize.toString())) {
          log("(could not open a browser automatically; paste the URL above)");
        }
        log("waiting for approval...");
      } catch (err) {
        reject(err);
      }
    });
  });
}

async function exchangeCode(code, redirectUri, pending) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: pending.clientId,
    code_verifier: pending.verifier,
    resource: ENDPOINT,
  });
  const res = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status} ${await res.text()}`);
  const data = await res.json();
  if (!data.access_token) throw new Error("token response missing access_token");
  return data;
}

function importFromOpencode() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    throw new Error("node:sqlite is unavailable in this Node build; run `beeper-mcp-shim auth` instead");
  }
  const candidates = [
    process.env.OPENCODE_DB,
    join(homedir(), ".local", "share", "opencode", "opencode.db"),
  ].filter(Boolean);
  const dbPath = candidates.find((p) => existsSync(p));
  if (!dbPath) throw new Error("opencode.db not found; set OPENCODE_DB or run `beeper-mcp-shim auth`");

  const db = new DatabaseSync(dbPath, { readOnly: true });
  let row;
  try {
    row = db
      .prepare("select value from credential where label = ? order by active desc limit 1")
      .get("beeper");
  } catch {
    row = db
      .prepare("select value from credential where integration_id like 'mcp_%' order by active desc limit 1")
      .get();
  }
  db.close();
  if (!row || !row.value) throw new Error("no Beeper MCP credential found in opencode.db");
  const parsed = JSON.parse(row.value);
  if (!parsed.access) throw new Error("credential has no access token");
  saveToken(parsed.access, { metadata: { source: "opencode", serverUrl: ENDPOINT } });
}

// ---------------------------------------------------------------------------
// status mode
// ---------------------------------------------------------------------------

async function cmdStatus() {
  const token = loadToken();
  if (!token) {
    log("no token found");
    process.exit(2);
  }
  const call = async (method, params, id) => {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const text = await res.text();
    const ct = res.headers.get("content-type") || "";
    const messages = ct.includes("text/event-stream") ? parseSSE(text) : [JSON.parse(text)];
    return messages.find((m) => m && m.id === id) || messages[0];
  };
  try {
    await call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "beeper-mcp-shim", version: "1" },
    }, 1);
    const tools = await call("tools/list", {}, 2);
    const count = tools?.result?.tools?.length ?? 0;
    process.stdout.write(`connected to ${ENDPOINT}; ${count} tools available\n`);
  } catch (err) {
    process.stdout.write(`failed: ${err.message}\n`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// entrypoint
// ---------------------------------------------------------------------------

function usage() {
  process.stdout.write(
    [
      "beeper-mcp-shim <command>",
      "",
      "  (no command)             stdio <-> Beeper HTTP MCP bridge",
      "  auth                     run the Beeper OAuth flow and store a token",
      "  auth --import-opencode   copy the token OpenCode already obtained",
      "  status                   verify the stored token against Beeper",
      "  help                     show this message",
      "",
      `Endpoint: ${ENDPOINT}`,
      `Credential: ${credentialPath()}`,
      "",
    ].join("\n")
  );
}

async function main() {
  const args = process.argv.slice(2);
  const [cmd] = args;
  if (cmd === "help" || cmd === "--help" || cmd === "-h") return usage();
  if (cmd === "auth") return cmdAuth({ importOpencode: args.includes("--import-opencode") });
  if (cmd === "status") return cmdStatus();
  return serve();
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().catch((err) => {
    log(`fatal: ${err.message}`);
    process.exit(1);
  });
}
