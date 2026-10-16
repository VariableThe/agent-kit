/**
 * hierarchy-guard — OpenCode policy-enforcement plugin (verified against
 * opencode v2.0.29).
 *
 * WHAT IT ENFORCES
 * Every agent's configured `permissions` rules are re-evaluated by the plugin
 * AFTER the runtime resolves its own rules, and a `deny` is forced when the
 * agent's policy denies the action. Client layers (T3 Code, an SDK
 * `session.update({ permissions })`, or anything else) append session-level
 * rules that win under the runtime's last-match-wins resolution — which is
 * exactly how read-only agents such as `bishop` were observed executing
 * shell/edit calls.
 *
 * PRECEDENCE (verified in the v2.0.29 permission gate)
 *   1. agent rules from config
 *   2. session rules appended by the client (win over agent rules)
 *   3. plugin `evaluate` handlers, which may only force `deny`
 * `permission.hook("evaluate")` is the one hook the runtime runs after rule
 * resolution, so this plugin can only tighten a decision, never loosen one: it
 * never upgrades `deny` -> `allow` or `ask` -> `allow`.
 *
 * FAIL-SAFE
 * Every path is wrapped: a missing/malformed config, or an unexpected event
 * shape, leaves the session exactly as it was and never breaks the agent loop.
 * Enforcement is the permission hook; the `tool.hook("execute.before")` path is
 * belt-and-braces only. Opt out with HIERARCHY_GUARD_OFF=1.
 */
import { Plugin } from "@opencode/plugin";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadPolicy, resolveEffect } from "./policy.mjs";

const OFF_ENV = "HIERARCHY_GUARD_OFF";

type EvaluateEvent = {
  sessionID?: unknown;
  agent?: unknown;
  action?: unknown;
  resources?: unknown;
  effect?: string;
  message?: string;
};

type ToolEvent = {
  sessionID?: unknown;
  agent?: unknown;
  tool?: unknown;
  input?: { command?: unknown; cmd?: unknown } | unknown;
};

function isDisabled(env: NodeJS.ProcessEnv | undefined): boolean {
  return String(env?.[OFF_ENV] ?? "") === "1";
}

/** `OPENCODE_CONFIG` when opencode is pointed at an explicit file, else the global config. */
function resolveConfigPath(env: NodeJS.ProcessEnv | undefined): string {
  const explicit = env?.OPENCODE_CONFIG;
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  return join(homedir(), ".config", "opencode", "opencode.json");
}

function preview(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.length > 200 ? value.slice(0, 200) : value;
}

/** One short, factual line naming the agent, action and resource. */
function denyMessage(agent: unknown, action: unknown, resources: unknown, rule: unknown): string {
  const list = Array.isArray(resources) ? resources : [];
  const first = list.find((r) => typeof r === "string") as string | undefined;
  const subject = first === undefined ? "" : ` for ${JSON.stringify(preview(first))}`;
  const matched =
    rule && typeof rule === "object" && typeof (rule as { resource?: unknown }).resource === "string"
      ? ` (rule ${JSON.stringify((rule as { action?: unknown }).action)}/${JSON.stringify(
          (rule as { resource: string }).resource,
        )})`
      : "";
  return `hierarchy-guard: agent ${JSON.stringify(String(agent ?? ""))} is not permitted to use ${JSON.stringify(
    String(action ?? ""),
  )}${subject}${matched}`;
}

/** A single structured stderr line, emitted only when we actually deny. */
function logDenial(event: EvaluateEvent | ToolEvent, action: string, rule: unknown): void {
  try {
    const resources = Array.isArray((event as EvaluateEvent).resources)
      ? ((event as EvaluateEvent).resources as unknown[])
      : [];
    const input = (event as ToolEvent).input;
    if (input && typeof input === "object") {
      const command = (input as { command?: unknown }).command ?? (input as { cmd?: unknown }).cmd;
      if (typeof command === "string") resources.push(command);
    }
    console.error(
      JSON.stringify({
        plugin: "hierarchy-guard",
        event: "deny",
        sessionID: typeof event.sessionID === "string" ? event.sessionID : undefined,
        agent: typeof event.agent === "string" ? event.agent : undefined,
        action,
        resources: resources.filter((r) => typeof r === "string").slice(0, 3).map(preview),
        rule:
          rule && typeof rule === "object" && typeof (rule as { resource?: unknown }).resource === "string"
            ? { action: (rule as { action?: unknown }).action, resource: (rule as { resource: string }).resource }
            : undefined,
      }),
    );
  } catch {
    /* logging must never break anything */
  }
}

export default Plugin.define({
  id: "hierarchy-guard",
  async setup(ctx) {
    try {
      if (isDisabled(process.env)) return;
      const configPath = resolveConfigPath(process.env);

      const rulesFor = (agent: unknown) => {
        if (typeof agent !== "string" || agent.length === 0) return undefined;
        return loadPolicy(configPath).get(agent);
      };

      // --- Primary mechanism: force deny after the runtime resolved rules. ---
      await ctx.permission?.hook?.("evaluate", (event: EvaluateEvent) => {
        try {
          if (!event || typeof event !== "object") return;
          const rules = rulesFor(event.agent);
          if (!rules) return; // no configured policy for this agent: leave the session alone
          const action = typeof event.action === "string" ? event.action : "";
          const { effect, rule } = resolveEffect(action, event.resources, rules);
          if (effect !== "deny") return; // ask/allow: never loosen, never fabricate a deny
          event.effect = "deny";
          event.message = denyMessage(event.agent, event.action, event.resources, rule);
          logDenial(event, action, rule);
        } catch {
          /* never break the agent loop */
        }
      });

      // --- Belt-and-braces only: observed to be unreliable; logs + no-ops. ---
      await ctx.tool?.hook?.("execute.before", (event: ToolEvent) => {
        try {
          if (!event || typeof event !== "object") return;
          if (event.tool !== "shell") return;
          const rules = rulesFor(event.agent);
          if (!rules) return;
          const input = event.input;
          const command =
            input && typeof input === "object"
              ? ((input as { command?: unknown }).command ?? (input as { cmd?: unknown }).cmd)
              : undefined;
          if (typeof command !== "string") return;
          const { effect } = resolveEffect("shell", command, rules);
          if (effect !== "deny") return;
          // Log only. Observed on v2.0.29: `execute.before` runs BEFORE the
          // permission check, so replacing `input.command` here DOES take
          // effect — and it makes the permission hook evaluate the placeholder
          // instead of the real command, masking the deny message. The
          // permission hook above is the authoritative, rules-exact gate, so
          // this path stays a non-mutating audit line.
          logDenial(event, "shell", null);
        } catch {
          /* non-throwing by design */
        }
      });
    } catch {
      /* setup must never throw */
    }
  },
});
