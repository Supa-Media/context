/**
 * EVERY ACTION'S ARGS ARE HELD TO ITS OWN SCHEMA BEFORE IT RUNS (Dev2, 2026-11-20: "the way to treat actions better
 * with the validated schema ... we just need to get this down pat"). `packages/tex/gateway/agent/actionArgs.js`,
 * `sixTools.js` `checkedAction`; docs/decisions/texting-assistant/tool-rules.md.
 *
 * ## Sabotage record
 *
 * Applied, run, named test seen failing, reverted (2026-11-20):
 *  1. `checkedAction` returning `out` unchecked → "an action's args are refused naming the argument...", "a key Tex's
 *     own action...", "a missing required argument..." and "one reading is taken..." fail.
 *  2. `closed` keeping the carrier's own `additionalProperties` → "a key Tex's own action does not take is said..." fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ACTIONS } from "../src/tools/v2/actions.js";
import { unsupportedKeywords } from "../src/toolArguments.js";
import { checkActionArguments } from "../../../packages/tex/gateway/agent/actionArgs.js";
import { ASSISTANT_SEND_ACTIONS, sixToolsOver } from "../../../packages/tex/gateway/agent/sixTools.js";
import { FIXED_KINDS, fixedCarriers } from "../../../packages/tex/gateway/agent/sixToolsFixed.js";

function fixedSix(kind = "one") {
  const shown = fixedCarriers(kind);
  return sixToolsOver([...shown.values()], null, { shown });
}

test("an action's args are refused naming the argument, before anything runs, and its manual comes back", () => {
  const six = fixedSix();
  const call = { action: "job_status", args: { name: "Find a plumber" } };
  const out = six.resolve("send", call);
  assert.equal(out.cause, "bad_arguments");
  assert.match(out.error, /^send job_status: unknown argument "name"; permitted here: title/);
  assert.match(out.error, /Nothing ran/);
  assert.match(six.manualOnFailure("send", call) ?? "", /The manual for job_status/);
});

test("a key Tex's own action does not take is said, never dropped unseen, though its carrier's schema is open", () => {
  const six = fixedSix();
  const out = six.resolve("send", { action: "travel_time", args: { from: "Home", to: "JFK", when: "8am" } });
  assert.equal(out.cause, "bad_arguments");
  assert.match(out.error, /unknown argument "when"/);
});

test("a missing required argument and a wrong type are refused the same way, for the gateway's actions too", () => {
  const six = fixedSix();
  assert.match(six.resolve("send", { action: "search_web", args: {} }).error, /send search_web: missing required argument "query"/);
  assert.match(six.resolve("send", { action: "email", args: { to: ["a@example.com"], subject: "Hi", body: 3 } }).error, /send email: argument "body" must be a string/);
  assert.match(six.resolve("manage", { action: "move", args: { source: "a.md" } }).error, /manage move: missing required argument "destination"/);
});

test("one reading is taken, not refused: a lone string for a list, the list's name in the singular, a number as text", () => {
  const six = fixedSix();
  assert.deepEqual(six.resolve("send", { action: "email", args: { to: "a@example.com", subject: "Hi", body: "x" } }).args.to, ["a@example.com"]);
  assert.deepEqual(six.resolve("send", { action: "open_page", args: { url: "https://example.com" } }).args, { urls: ["https://example.com"] });
  // Two addresses in one string are not guessed at.
  assert.equal(six.resolve("send", { action: "email", args: { to: "a@example.com, b@example.com", subject: "Hi", body: "x" } }).cause, "bad_arguments");
  assert.equal(checkActionArguments({ type: "object", properties: { n: { type: "integer" } } }, { n: "3" }).args.n, 3);
});

test("a right call runs as it came, with the call's own workspace beside it", () => {
  const six = fixedSix();
  assert.deepEqual(six.resolve("send", { action: "fill_login", args: { entry: "login:1" }, context: "@family" }), { name: "fill_login", args: { context: "@family", entry: "login:1" } });
  assert.deepEqual(six.resolve("write", { path: "notes/a.md", content: "hi" }), { name: "write_note", args: { path: "notes/a.md", content: "hi" } });
  assert.deepEqual(six.resolve("send", { action: "advisor" }), { name: "ask_advisor", args: {} });
});

test("every action on both fixed lists has a schema this check reads whole, and its required args are its own", () => {
  for (const kind of FIXED_KINDS) {
    const shown = fixedCarriers(kind);
    for (const family of ["write", "manage", "send"]) {
      const table = family === "send" ? { ...ACTIONS.send, ...ASSISTANT_SEND_ACTIONS } : ACTIONS[family];
      for (const [action, entry] of Object.entries(table)) {
        const carrier = shown.get(entry.tool);
        if (!carrier) continue;
        const schema = carrier.inputSchema;
        assert.ok(schema && typeof schema === "object", `${kind} ${family} ${action}: no schema`);
        assert.deepEqual(unsupportedKeywords(schema), [], `${kind} ${family} ${action}: keywords the check would ignore`);
        for (const key of schema.required ?? []) assert.ok(Object.hasOwn(schema.properties ?? {}, key), `${kind} ${action}: requires ${key}, which it does not describe`);
      }
    }
  }
});
