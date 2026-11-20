/**
 * A CHECK-IN SEARCHES, AND IS TOLD IT ONLY READS (Dev2, 2026-11-20: "give check-ins read-only search"; and, of the
 * cached tool list, "we just add a prompt that clearly says, like, you are a check-in ... You can only use read-only
 * tools"). `packages/tex/gateway/agent/heartbeat.js`; docs/decisions/texting-assistant/tool-rules.md.
 *
 * ## Sabotage record
 *
 * Applied, run, named test seen failing, reverted (2026-11-20):
 *  1. `checkInWeb` not calling `markUntrusted` → "a check-in searches the web and opens nothing…" fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { CHECK_IN_TOOLS, HEARTBEAT_READS, checkInWeb, heartbeatCallTool, heartbeatQuestion } from "../../../packages/tex/gateway/agent/heartbeat.js";
import { UNTRUSTED_READS } from "../src/privacy/egress.js";

test("a check-in's dispatcher searches their email, an untrusted read, and still refuses a write", async () => {
  const calls = [];
  const callTool = heartbeatCallTool(async (name) => {
    calls.push(name);
    return { content: [{ type: "text", text: "ok" }] };
  });
  assert.notEqual((await callTool("search_email", { query: "invoice" })).isError, true);
  assert.equal((await callTool("send_email", { to: ["a@example.invalid"] })).isError, true);
  assert.deepEqual(calls, ["search_email"]);
  assert.ok(HEARTBEAT_READS.has("search_email") && UNTRUSTED_READS.has("search_email"));
});

test("a check-in searches the web and opens nothing, and a result marks the look untrusted", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ web: { results: [{ title: "Kiln", url: "https://example.invalid/", description: "glazes" }] } }), { headers: { "content-type": "application/json" } });
  try {
    const ledger = { untrusted: false };
    const web = checkInWeb({ BRAVE_SEARCH_API_KEY: "test-key" }, ledger);
    assert.deepEqual(web.tools.map((tool) => tool.name), ["search_web"]);
    assert.equal((await web.call("open_page", { urls: ["https://example.invalid/"] })).isError, true);
    assert.equal(ledger.untrusted, false, "a refusal reads nothing");
    assert.notEqual((await web.call("search_web", { query: "kiln glazes" })).isError, true);
    assert.equal(ledger.untrusted, true);
    assert.equal(checkInWeb({}, { untrusted: false }), null, "no search provider, no web");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("a check-in is always told it only reads, whatever its setup's words", () => {
  const asked = heartbeatQuestion({ changed: [], now: 0, texted: [], instructions: "Only text me about deadlines." });
  assert.ok(asked.includes(CHECK_IN_TOOLS));
  assert.match(CHECK_IN_TOOLS, /only reads/);
});
