/**
 * `PUT /api/bot-hook` (`src/http/botHookUpload.js`): a bot sends its webhook's header from its shell with a one-time
 * ticket. The route passes the ticket and the value to the control plane and nothing else; it refuses a request
 * without a ticket, an empty or multi-line value, and a variable the shell never filled in, before asking anything.
 *
 * ## Sabotage record
 *
 * Dropping the unfilled-variable check failed "a value the shell never filled in is refused".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { handleBotHookUpload } from "../src/http/botHookUpload.js";

const TICKET = "tkt_abcdefghijklmnop0123";

function plane(answer = { host: "bot.example.com", headerEnds: "fbb2" }) {
  const calls = [];
  return { calls, controlPlane: { botHookTicket: async (ticket, value) => (calls.push([ticket, value]), answer) } };
}

const put = (body, headers = { authorization: `Bearer ${TICKET}` }) =>
  new Request("https://mcp.example.com/api/bot-hook", { method: "PUT", headers, body });

test("the ticket and the value go to the control plane, and the answer never carries the value", async () => {
  const { calls, controlPlane } = plane();
  const response = await handleBotHookUpload(put("Bearer grok-secret-fbb2\n"), {}, { controlPlane });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [[TICKET, "Bearer grok-secret-fbb2"]]);
  const text = await response.text();
  assert.ok(!text.includes("grok-secret"));
  assert.deepEqual(JSON.parse(text), { saved: true, host: "bot.example.com", headerEnds: "fbb2" });
});

test("no ticket, another method, an empty or multi-line value are refused before anything is asked", async () => {
  const { calls, controlPlane } = plane();
  assert.equal((await handleBotHookUpload(put("Bearer x", {}), {}, { controlPlane })).status, 401);
  assert.equal((await handleBotHookUpload(new Request("https://mcp.example.com/api/bot-hook", { method: "POST" }), {}, { controlPlane })).status, 405);
  assert.equal((await handleBotHookUpload(put(""), {}, { controlPlane })).status, 400);
  assert.equal((await handleBotHookUpload(put("Bearer a\nX-Other: b"), {}, { controlPlane })).status, 400);
  assert.equal((await handleBotHookUpload(put("x".repeat(5000)), {}, { controlPlane })).status, 413);
  assert.deepEqual(calls, []);
});

test("a value the shell never filled in is refused", async () => {
  const { calls, controlPlane } = plane();
  const response = await handleBotHookUpload(put("Bearer $WEBHOOK_SECRET"), {}, { controlPlane });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /variable wasn't filled in/);
  assert.deepEqual(calls, []);
});

test("a spent or expired ticket is the control plane's refusal, passed on", async () => {
  const { controlPlane } = plane({ error: "This command was already used or has expired. Ask manage area for a new one." });
  const response = await handleBotHookUpload(put("Bearer x"), {}, { controlPlane });
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /already used/);
});
