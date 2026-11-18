import assert from "node:assert/strict";
import { test } from "node:test";

import { explain, readBindings, waitForBindings } from "./email-worker-binding.mjs";

const both = {
  success: true,
  result: [
    { name: "EMAIL_WORKER_SECRET", value: "must-not-be-printed" },
    { name: "CONTROL_PLANE_URL", value: "https://secret.example" },
  ],
};

test("both names bound is ready, and a value on the row is ignored", () => {
  const state = readBindings(both);
  assert.equal(state.ok, true);
  assert.deepEqual(state.names, ["EMAIL_WORKER_SECRET", "CONTROL_PLANE_URL"]);
  assert.equal(JSON.stringify(state).includes("must-not-be-printed"), false);
});

test("an empty list and a missing name are not ready", () => {
  assert.equal(readBindings({ success: true, result: [] }).ok, false);
  assert.equal(readBindings({ success: true, result: [] }).kind, "email");
  assert.equal(readBindings({ success: true, result: [{ name: "EMAIL_WORKER_SECRET" }] }).kind, "control");
  assert.equal(readBindings({ success: false, errors: [{ code: 7000 }] }).kind, "list");
});

test("a list that throws and then answers is ready inside the budget", async () => {
  let calls = 0;
  let clock = 0;
  const state = await waitForBindings({
    request: async () => {
      calls += 1;
      if (calls === 1) throw new Error("socket hang up");
      return both;
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  });
  assert.equal(state.ok, true);
  assert.equal(state.attempts, 2);
});

test("a list that is empty and then complete is ready inside the budget", async () => {
  const bodies = [{ success: true, result: [] }, both];
  let clock = 0;
  const waits = [];
  const state = await waitForBindings({
    request: async () => bodies.shift(),
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    now: () => clock,
  });
  assert.equal(state.ok, true);
  assert.equal(state.attempts, 2);
  assert.deepEqual(waits, [2000]);
});

test("a list that stays empty fails after about 30 seconds, with the same words as the step", async () => {
  let clock = 0;
  const waits = [];
  const state = await waitForBindings({
    request: async () => ({ success: true, result: [] }),
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    now: () => clock,
  });
  assert.equal(state.ok, false);
  assert.equal(waits.reduce((sum, ms) => sum + ms, 0), 30_000);
  const text = explain(state);
  assert.match(text, /\[FAIL\] EMAIL_WORKER_SECRET is not bound to this Worker/);
  assert.match(text, /Bound secrets: \(none\)/);
  assert.equal(text.includes("must-not-be-printed"), false);
});

test("a missing control-plane secret keeps the 10053 runbook", () => {
  const text = explain(readBindings({ success: true, result: [{ name: "EMAIL_WORKER_SECRET" }] }));
  assert.match(text, /CONTROL_PLANE_URL is not bound to this Worker AS A SECRET/);
  assert.match(text, /10053/);
});
