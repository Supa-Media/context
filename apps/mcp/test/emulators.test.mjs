// A preview build sends Google calls to its emulators; any other build changes nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installEmulators } from "../src/emulators.js";

test("unset (every staging and production build), fetch is left alone", () => {
  const target = { fetch: async () => new Response("real") };
  const before = target.fetch;
  assert.equal(installEmulators(null, target), false);
  assert.equal(target.fetch, before);
  assert.equal(globalThis.fetch.emulated, undefined, "importing the gateway never wraps the real fetch in tests");
});

test("a preview's origin wraps fetch once, rewriting Google and leaving other hosts alone", async () => {
  const seen = [];
  const target = { fetch: async (input) => (seen.push(String(input)), new Response("ok")) };
  const origin = "https://context-emulators-pr7.fake-sub.workers.dev";
  assert.equal(installEmulators(origin, target), true);
  assert.equal(installEmulators(origin, target), false, "never wrapped twice");
  await target.fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  await target.fetch("https://gateway.ai.cloudflare.com/v1/x");
  assert.deepEqual(seen, [`${origin}/google/gmail/v1/users/me/messages`, "https://gateway.ai.cloudflare.com/v1/x"]);
});

test("an origin that is not a preview's emulators Worker is refused at start", () => {
  assert.throws(() => installEmulators("https://evil.example", { fetch: async () => new Response("") }), /emulators origin/);
});
