import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPolicy,
  compilePattern,
  isExecuteNeuterExempt,
  isRule,
  isT3CodeHarness,
  loadPolicy,
  matchesPattern,
  normalizeResource,
  resetPolicyCache,
  resolveEffect,
} from "../plugins/hierarchy-guard/policy.mjs";

const tmp = mkdtempSync(join(tmpdir(), "hg-policy-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function writeFixture(name, contents) {
  const path = join(tmp, name);
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  return path;
}

describe("compilePattern (runtime parity)", () => {
  it("`ls *` matches a command with arguments and not a different command", () => {
    const re = compilePattern("ls *");
    assert.equal(re.test("ls -la /x"), true);
    assert.equal(re.test("pwd"), false);
  });

  it("`* /*` matches commands writing/reading outside the tree", () => {
    const re = compilePattern("* /*");
    assert.equal(re.test("ls -la /x"), true);
    assert.equal(re.test("echo a > /tmp/x"), true);
    assert.equal(re.test("pwd"), false);
  });

  it("`pwd *` matches `pwd x`", () => {
    assert.equal(compilePattern("pwd *").test("pwd x"), true);
  });

  it("`pwd *` ALSO matches bare `pwd` (runtime optional-argument quirk)", () => {
    // The v2.0.29 matcher rewrites a trailing " .*" to "( .*)?", so a `cmd *`
    // allow rule also covers the bare command. compilePattern copies that
    // exactly; a matcher that diverged would over/under-enforce versus the
    // runtime it has to agree with. (This corrects the spec's "not bare pwd"
    // expectation, which does not match the runtime.)
    assert.equal(compilePattern("pwd *").test("pwd"), true);
  });

  it("`*../*` matches parent-directory traversal", () => {
    assert.equal(compilePattern("*../*").test("cat ../x"), true);
  });

  it("escapes regex metacharacters in policy resources", () => {
    assert.equal(compilePattern("a.b").test("a.b"), true);
    assert.equal(compilePattern("a.b").test("axb"), false);
    assert.equal(compilePattern("*$HOME*").test("cat $HOME/x"), true);
    assert.equal(compilePattern("*${HOME}*").test("cat ${HOME}/x"), true);
    assert.equal(compilePattern("*--output*").test("ls --output=x"), true);
  });

  it("`?` matches exactly one character", () => {
    assert.equal(compilePattern("a?c").test("abc"), true);
    assert.equal(compilePattern("a?c").test("ac"), false);
  });

  it("normalizes backslashes on both sides, like the runtime", () => {
    assert.equal(matchesPattern("cat x\\y", "*\\*"), true);
    assert.equal(normalizeResource("a\\b"), "a/b");
  });

  it("anchoring is strict: a substring does not match", () => {
    assert.equal(compilePattern("ls").test("xls"), false);
    assert.equal(compilePattern("ls").test("ls x"), false);
  });

  it("a non-string resource never matches", () => {
    for (const bad of [undefined, null, 42, {}]) {
      assert.equal(compilePattern(bad).test("anything"), false);
    }
  });

  it("matchesPattern mirrors compilePattern", () => {
    assert.equal(matchesPattern("ls -la /x", "ls *"), true);
    assert.equal(matchesPattern("pwd", "ls *"), false);
  });
});

describe("resolveEffect", () => {
  const shellDeny = { action: "shell", resource: "*", effect: "deny" };
  const shellAllow = { action: "shell", resource: "*", effect: "allow" };

  it("last match wins: a later allow overrides an earlier deny", () => {
    const { effect } = resolveEffect("shell", ["rm -rf x"], [shellDeny, shellAllow]);
    assert.equal(effect, "allow");
  });

  it("last match wins: a later deny overrides an earlier allow", () => {
    const { effect, rule } = resolveEffect("shell", ["ls"], [shellAllow, shellDeny]);
    assert.equal(effect, "deny");
    assert.equal(rule, shellDeny);
  });

  it("resources are independent: one deny among allows is a deny", () => {
    const rules = [shellDeny, { action: "shell", resource: "ls *", effect: "allow" }];
    const { effect } = resolveEffect("shell", ["ls -la", "rm -rf /"], rules);
    assert.equal(effect, "deny");
  });

  it("no matching rule defaults to ask (runtime default)", () => {
    const unrelated = { action: "edit", resource: "*", effect: "deny" };
    const { effect, rule } = resolveEffect("shell", ["ls"], [unrelated]);
    assert.equal(effect, "ask");
    assert.equal(rule, null);
  });

  it("a `*` action matches any action", () => {
    const { effect } = resolveEffect("edit", ["src/x.ts"], [{ action: "*", resource: "*", effect: "deny" }]);
    assert.equal(effect, "deny");
  });

  it("a rule that denies one action does not leak to another action", () => {
    assert.equal(resolveEffect("edit", ["x"], [shellDeny]).effect, "ask");
  });

  it("an explicit ask beats allow but loses to deny", () => {
    const ask = { action: "read", resource: "*.env", effect: "ask" };
    const allow = { action: "read", resource: "*", effect: "allow" };
    assert.equal(resolveEffect("read", [".env"], [allow, ask]).effect, "ask");
    assert.equal(resolveEffect("read", [".env"], [allow, ask, { action: "read", resource: "*", effect: "deny" }]).effect, "deny");
  });

  it("ignores malformed rules and unknown effects (treated as ask)", () => {
    assert.equal(resolveEffect("shell", ["ls"], [{ action: "shell" }]).effect, "ask");
    assert.equal(resolveEffect("shell", ["ls"], [{ action: "shell", resource: "*", effect: "wat" }]).effect, "ask");
    assert.equal(isRule({ action: "shell", resource: "*" }), true);
    assert.equal(isRule({ action: "shell" }), false);
  });

  it("an empty rules list resolves to ask; an empty resource list resolves to allow", () => {
    assert.equal(resolveEffect("shell", ["ls"], []).effect, "ask");
    assert.equal(resolveEffect("shell", [], [{ action: "*", resource: "*", effect: "deny" }]).effect, "allow");
  });

  it("gates execute as shell-equivalent: unconstrained-shell deny -> deny", () => {
    // The execute (Code Mode JS) tool has no permission gate of its own, so
    // the plugin resolves action "shell" over resource "*" for it: any agent
    // whose policy denies unconstrained shell gets its execute input neutered.
    const bishopLike = [
      { action: "shell", resource: "*", effect: "deny" },
      { action: "shell", resource: "ls *", effect: "allow" },
      { action: "shell", resource: "* /*", effect: "deny" },
    ];
    assert.equal(resolveEffect("shell", "*", bishopLike).effect, "deny");
    assert.equal(
      resolveEffect("shell", "*", [{ action: "shell", resource: "*", effect: "allow" }]).effect,
      "allow",
    );
    // A policy that only constrains another action leaves execute alone.
    assert.equal(
      resolveEffect("shell", "*", [{ action: "edit", resource: "*", effect: "deny" }]).effect,
      "ask",
    );
  });

  it("uses the first matching deny rule as the reported rule", () => {
    const a = { action: "shell", resource: "rm *", effect: "deny" };
    const b = { action: "shell", resource: "*", effect: "deny" };
    const { rule } = resolveEffect("shell", ["rm -rf x"], [b, a]);
    assert.equal(rule, a);
  });
});

describe("isT3CodeHarness / isExecuteNeuterExempt", () => {
  const T3_ENV = { T3CODE_CLI_PATH: "/home/decon/.t3/bin/t3", PATH: "/usr/bin" };

  it("isT3CodeHarness is true for any non-empty T3CODE_ value", () => {
    assert.equal(isT3CodeHarness(T3_ENV), true);
    // Prefix-based on purpose: a renamed T3CODE_ variable still detects the harness.
    assert.equal(isT3CodeHarness({ T3CODE_SOMETHING_ELSE: "1" }), true);
  });

  it("isT3CodeHarness is false without a T3CODE_ key or with an empty/non-string value", () => {
    assert.equal(isT3CodeHarness({}), false);
    assert.equal(isT3CodeHarness({ PATH: "/usr/bin", HOME: "/home/decon" }), false);
    assert.equal(isT3CodeHarness({ T3CODE_CLI_PATH: "" }), false);
    assert.equal(isT3CodeHarness({ T3CODE_CLI_PATH: 42 }), false);
    assert.equal(isT3CodeHarness({ T3CODE_CLI_PATH: null }), false);
    // An inherited-looking prefix must not count if it is not the own key name.
    assert.equal(isT3CodeHarness({ XT3CODE_CLI_PATH: "/x" }), false);
  });

  it("exempts build only under the T3 Code harness", () => {
    assert.equal(isExecuteNeuterExempt("build", T3_ENV), true);
    assert.equal(isExecuteNeuterExempt("build", {}), false);
    assert.equal(isExecuteNeuterExempt("build", { T3CODE_CLI_PATH: "" }), false);
    assert.equal(isExecuteNeuterExempt("build", { T3CODE_CLI_PATH: "/x", PATH: "/usr/bin" }), true);
  });

  it("does not exempt any other agent, even under T3 Code", () => {
    for (const agent of ["bishop", "witch", "grand-bishop", "knight", "control"]) {
      assert.equal(isExecuteNeuterExempt(agent, T3_ENV), false);
    }
  });

  it("is false for non-string agents and never throws on a bad env", () => {
    for (const agent of [undefined, null, 42, {}, ["build"], Symbol("build")]) {
      assert.equal(isExecuteNeuterExempt(agent, T3_ENV), false);
    }
    for (const env of [null, undefined, 42, "T3CODE_CLI_PATH=/x", [], () => {}]) {
      assert.equal(isExecuteNeuterExempt("build", env), false);
    }
    assert.equal(isT3CodeHarness(null), false);
    assert.equal(isT3CodeHarness(undefined), false);
    assert.equal(isT3CodeHarness("T3CODE_CLI_PATH=/x"), false);
  });
});

describe("buildPolicy / loadPolicy", () => {
  const config = {
    agents: {
      guardedsubj: {
        model: "opencode/x",
        permissions: [{ action: "shell", resource: "*", effect: "deny" }],
      },
      control: { model: "opencode/x" },
      empty: { permissions: [] },
    },
  };

  it("builds a map only from agents that declare a permissions array", () => {
    const policy = buildPolicy(config);
    assert.deepEqual([...policy.keys()].sort(), ["empty", "guardedsubj"]);
    assert.equal(policy.get("guardedsubj").length, 1);
    assert.equal(policy.get("control"), undefined);
  });

  it("tolerates a garbage config without throwing", () => {
    for (const bad of [null, undefined, 42, "x", [], { agents: null }, { agents: [] }]) {
      assert.equal(buildPolicy(bad).size, 0);
    }
  });

  it("parses a two-agent fixture file", () => {
    resetPolicyCache();
    const path = writeFixture("opencode.json", config);
    const policy = loadPolicy(path);
    assert.equal(policy.get("guardedsubj")[0].effect, "deny");
    assert.equal(policy.has("control"), false);
    assert.equal(policy.get("empty").length, 0);
  });

  it("returns an empty map for a missing file", () => {
    resetPolicyCache();
    assert.equal(loadPolicy(join(tmp, "nope.json")).size, 0);
    assert.equal(loadPolicy("").size, 0);
    assert.equal(loadPolicy(undefined).size, 0);
  });

  it("returns an empty map for malformed JSON", () => {
    resetPolicyCache();
    assert.equal(loadPolicy(writeFixture("broken.json", "{ not json")).size, 0);
  });

  it("hot-reloads when the file changes (cache keyed by mtime + size)", () => {
    resetPolicyCache();
    const path = writeFixture("live.json", { agents: { a: { permissions: [{ action: "edit", resource: "*", effect: "deny" }] } } });
    assert.equal(loadPolicy(path).get("a")[0].action, "edit");
    writeFixture("live.json", { agents: { a: { permissions: [{ action: "shell", resource: "*", effect: "deny" }] } } });
    // Same path, edited on disk: must not serve the stale parse.
    assert.equal(loadPolicy(path).get("a")[0].action, "shell");
  });
});
