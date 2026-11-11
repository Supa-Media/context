/**
 * The deploy works out Sendblue's status address (`sendblue-status-url.mjs`).
 *
 * Sabotage: return the webhook secret itself as the key and "never the
 * webhook secret" fails; drop the missing-input guard and "nothing without
 * a webhook secret" fails; change LABEL and "stable" still passes but the
 * address Sendblue holds for in-flight sends changes once, which is harmless.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { sendblueStatusUrl } from "./sendblue-status-url.mjs";

/** The Worker's own check, `statusPath` in apps/agent/src/sendblue.ts, copied. */
const WORKER_ACCEPTS = (url) => {
  const u = new URL(url);
  return u.protocol === "https:" && /^\/sendblue\/status\/[A-Za-z0-9_-]{16,128}$/.test(u.pathname);
};

test("an address the Worker accepts, on its own workers.dev host", () => {
  const url = sendblueStatusUrl("context-agent", "example-sub", "whsec-fake-value");
  assert.ok(WORKER_ACCEPTS(url), url);
  assert.equal(new URL(url).host, "context-agent.example-sub.workers.dev");
});

test("stable across deploys, and different per secret", () => {
  const a = sendblueStatusUrl("context-agent", "s", "secret-one");
  assert.equal(a, sendblueStatusUrl("context-agent", "s", "secret-one"));
  assert.notEqual(a, sendblueStatusUrl("context-agent", "s", "secret-two"));
});

test("never the webhook secret", () => {
  const secret = "whsec-fake-value-long-enough";
  assert.ok(!sendblueStatusUrl("context-agent", "s", secret).includes(secret));
});

test("nothing without a webhook secret, worker or subdomain", () => {
  assert.equal(sendblueStatusUrl("context-agent", "s", ""), "");
  assert.equal(sendblueStatusUrl("context-agent", "", "x"), "");
  assert.equal(sendblueStatusUrl("", "s", "x"), "");
  assert.equal(sendblueStatusUrl("context-agent", "s", undefined), "");
});

test("refuses a host that is not a DNS label", () => {
  assert.throws(() => sendblueStatusUrl("context-agent", "evil.com/x", "x"));
});
