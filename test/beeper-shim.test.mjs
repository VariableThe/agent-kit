import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSSE } from "../src/beeper-mcp-shim.mjs";

test("parseSSE extracts JSON-RPC payloads from event-stream text", () => {
  const body = [
    "event: message",
    'data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}',
    "",
    "event: message",
    'data: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}',
    "",
  ].join("\n");
  const messages = parseSSE(body);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].id, 1);
  assert.equal(messages[1].result.tools.length, 0);
});

test("parseSSE ignores keep-alive comments and malformed data", () => {
  const body = [": ping", "", "data: not-json", "", "data: {\"ok\":true}", ""].join("\n");
  const messages = parseSSE(body);
  assert.deepEqual(messages, [{ ok: true }]);
});

test("parseSSE joins multi-line data fields", () => {
  const body = ['data: {"a":1,', 'data: "b":2}', ""].join("\n");
  assert.deepEqual(parseSSE(body), [{ a: 1, b: 2 }]);
});

test("module import does not start the bridge", () => {
  // If the entrypoint guard were missing, importing the module would call
  // serve() and block on stdin; reaching this assertion proves it did not.
  assert.equal(typeof parseSSE, "function");
});
