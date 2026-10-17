/**
 * policy.mjs — pure, dependency-free policy helpers for the hierarchy-guard
 * plugin. No opencode imports: everything here runs under plain Node and is
 * unit-tested directly.
 *
 * The rule matcher is a faithful copy of opencode v2.0.29's `Q_(value, rule)`
 * (decompiled from /usr/bin/opencode):
 *
 *   function Q_(value, pattern) {
 *     const v = value.replaceAll(backslash, slash);
 *     let p = pattern.replaceAll(backslash, slash)
 *                    .replace(regex-metachars, escaped)   // [ . + ^ $ { } ( ) | [ ] \ ]
 *                    .replace(every-star, dot-star)
 *                    .replace(every-question, dot);
 *     if (p.endsWith(" .*")) p = p.slice(0, -3) + "( .*)?";
 *     return new RegExp("^" + p + "$", "s").test(v);
 *   }
 *
 * The plugin MUST agree with the runtime exactly: a matcher that differed would
 * over- or under-enforce relative to the rules the runtime applies on its own.
 * The trailing " .*" quirk is what makes `pwd *` (and every `cmd *` allow rule)
 * also match the bare command `pwd`.
 */

import { readFileSync, statSync } from "node:fs";

/** A regex that never matches, used for malformed patterns. */
const NEVER = /(?!)/;

/**
 * opencode normalizes backslashes to forward slashes in both the value and the
 * pattern before matching (Windows paths in policy resources).
 */
export function normalizeResource(value) {
  return String(value ?? "").replaceAll("\\", "/");
}

const patternCache = new Map();

/**
 * Compile a policy resource/action glob into an anchored dotAll RegExp that
 * behaves byte-for-byte like the runtime's matcher.
 */
export function compilePattern(resource) {
  if (typeof resource !== "string") return NEVER;
  const cached = patternCache.get(resource);
  if (cached !== undefined) return cached;

  let body = resource
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  // Runtime quirk: a trailing " .*" becomes an OPTIONAL argument group, so a
  // `cmd *` rule also matches the bare `cmd`.
  if (body.endsWith(" .*")) body = body.slice(0, -3) + "( .*)?";

  const re = new RegExp("^" + body + "$", "s");
  patternCache.set(resource, re);
  return re;
}

/** True when `value` matches a single glob `pattern` (runtime semantics). */
export function matchesPattern(value, pattern) {
  return compilePattern(pattern).test(normalizeResource(value));
}

const KNOWN_EFFECTS = new Set(["allow", "ask", "deny"]);

/** A policy rule must at least name an action and a resource glob. */
export function isRule(rule) {
  return (
    !!rule &&
    typeof rule === "object" &&
    typeof rule.action === "string" &&
    typeof rule.resource === "string"
  );
}

/** Unknown/missing effects are treated as the runtime default, "ask". */
function ruleEffect(rule) {
  return rule && typeof rule.effect === "string" && KNOWN_EFFECTS.has(rule.effect)
    ? rule.effect
    : "ask";
}

/**
 * Resolve one resource against a rule list with the runtime's last-match-wins
 * `findLast` semantics. Returns the default `ask` when nothing matches.
 */
function resolveResource(action, resource, rules) {
  const value = normalizeResource(resource);
  const hit = rules.findLast(
    (rule) => compilePattern(rule.action).test(action) && compilePattern(rule.resource).test(value),
  );
  if (hit === undefined) return { effect: "ask", rule: null };
  return { effect: ruleEffect(hit), rule: hit };
}

/**
 * Resolve the effective effect for an action over several resources, mirroring
 * the runtime gate: deny as soon as any resource denies, otherwise ask if any
 * asks, otherwise allow.
 */
export function resolveEffect(action, resources, rules) {
  const list = (Array.isArray(rules) ? rules : []).filter(isRule);
  const actionValue = normalizeResource(action);
  const values = Array.isArray(resources) ? resources : [resources];

  let rule = null;
  let sawAsk = false;
  let sawAllow = false;

  for (const resource of values) {
    const resolved = resolveResource(actionValue, resource, list);
    if (resolved.effect === "deny") return { effect: "deny", rule: resolved.rule };
    if (resolved.effect === "ask") {
      sawAsk = true;
      if (rule === null) rule = resolved.rule;
    } else {
      sawAllow = true;
      if (rule === null) rule = resolved.rule;
    }
  }

  if (sawAsk) return { effect: "ask", rule };
  if (sawAllow) return { effect: "allow", rule };
  return { effect: "allow", rule: null }; // no resources at all: runtime yields allow
}

/** Prefix every T3 Code session variable carries (e.g. `T3CODE_CLI_PATH`). */
const T3CODE_ENV_PREFIX = "T3CODE_";

/**
 * Agents exempt from execute-tool neutering, and ONLY while running under the
 * T3 Code harness. `build` is Monarch, the primary T3 Code orchestrator: Code
 * Mode is its only route to the browser tools, the MCP servers and the T3 Code
 * app tools, so neutering it removes those catalogs outright. The exemption is
 * safe because the harness sandbox was probed on 2026-10-17 and cannot reach
 * the filesystem or spawn a process (`require`/`process` undefined, dynamic
 * `import` unsupported, `fetch` rejects `file:` URLs, an `execSync` write
 * created no marker file) — there is nothing to gate there. Every other agent
 * (bishop, witch, grand-bishop) stays neutered, native OpenCode sessions stay
 * neutered, and the `permission.hook("evaluate")` leg remains the
 * authoritative enforcer everywhere.
 */
const EXECUTE_NEUTER_EXEMPT_AGENTS = ["build"];

/**
 * True when `env` looks like a T3 Code session environment. Detection is
 * prefix-based on an own enumerable key with a non-empty string value, so it
 * survives the specific `T3CODE_*` variable being renamed. Native OpenCode CLI
 * and service processes carry no such key.
 */
export function isT3CodeHarness(env) {
  if (!env || typeof env !== "object") return false;
  for (const key of Object.keys(env)) {
    if (!key.startsWith(T3CODE_ENV_PREFIX)) continue;
    const value = env[key];
    if (typeof value === "string" && value.length > 0) return true;
  }
  return false;
}

/**
 * True only for an exempt agent running under the T3 Code harness; false for
 * every other agent, for a non-string agent, and for a missing/non-object env.
 */
export function isExecuteNeuterExempt(agent, env) {
  return isT3CodeHarness(env) && EXECUTE_NEUTER_EXEMPT_AGENTS.includes(agent);
}

/** Build the agent -> rules map from a parsed opencode config object. */
export function buildPolicy(config) {
  const policy = new Map();
  const agents =
    config && typeof config === "object" && !Array.isArray(config) ? config.agents : undefined;
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) return policy;

  for (const [name, def] of Object.entries(agents)) {
    if (!def || typeof def !== "object" || Array.isArray(def)) continue;
    if (!Array.isArray(def.permissions)) continue;
    policy.set(name, def.permissions.filter(isRule));
  }
  return policy;
}

// Parsed policies keyed by path, invalidated on mtime/size change (hot reload).
const policyCache = new Map();

/** Drop cached parses; used by tests that rewrite a fixture in place. */
export function resetPolicyCache() {
  policyCache.clear();
}

/**
 * Load `agents.<name>.permissions` from an opencode config file.
 *
 * A missing file, unreadable file, or malformed JSON yields an empty map
 * (fail-safe: the session keeps whatever rules it already had). The cheap
 * `statSync` per call picks up edits without re-parsing on every permission
 * check.
 */
export function loadPolicy(configPath) {
  if (typeof configPath !== "string" || configPath.length === 0) return new Map();

  let stamp;
  try {
    const st = statSync(configPath);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    policyCache.delete(configPath);
    return new Map();
  }

  const cached = policyCache.get(configPath);
  if (cached !== undefined && cached.stamp === stamp) return cached.policy;

  let policy;
  try {
    policy = buildPolicy(JSON.parse(readFileSync(configPath, "utf8")));
  } catch {
    policy = new Map();
  }
  policyCache.set(configPath, { stamp, policy });
  return policy;
}
