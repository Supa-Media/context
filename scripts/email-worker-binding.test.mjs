import assert from "node:assert/strict";
import { test } from "node:test";

import { explain, namesForRun, readBindings, readyLine, secretsRequest, waitForBindings } from "./email-worker-binding.mjs";

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

const transcribe = ["TRANSCRIBE_WORKER_SECRET"];
const transcribeBound = {
  success: true,
  result: [{ name: "TRANSCRIBE_WORKER_SECRET", value: "must-not-be-printed" }],
};

test("the default names stay the email pair, and REQUIRED_SECRETS or arguments select others", () => {
  assert.deepEqual(namesForRun([], {}), ["EMAIL_WORKER_SECRET", "CONTROL_PLANE_URL"]);
  assert.deepEqual(namesForRun([], { REQUIRED_SECRETS: "" }), ["EMAIL_WORKER_SECRET", "CONTROL_PLANE_URL"]);
  assert.deepEqual(namesForRun([], { REQUIRED_SECRETS: "TRANSCRIBE_WORKER_SECRET" }), transcribe);
  assert.deepEqual(namesForRun(["TRANSCRIBE_WORKER_SECRET"], { REQUIRED_SECRETS: "EMAIL_WORKER_SECRET" }), transcribe);
  assert.equal(readyLine(), "[ok] EMAIL_WORKER_SECRET and CONTROL_PLANE_URL are bound as secrets.");
  assert.equal(readyLine(transcribe), "[ok] TRANSCRIBE_WORKER_SECRET is bound.");
});

test("a transcribe list that is empty and then complete is ready inside the budget", async () => {
  const bodies = [{ success: true, result: [] }, transcribeBound];
  let clock = 0;
  const logs = [];
  const state = await waitForBindings({
    request: async () => bodies.shift(),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    required: transcribe,
    log: (line) => logs.push(line),
  });
  assert.equal(state.ok, true);
  assert.equal(state.attempts, 2);
  assert.deepEqual(state.names, transcribe);
  assert.equal(JSON.stringify(state).includes("must-not-be-printed"), false);
  assert.equal(logs.join("\n").includes("must-not-be-printed"), false);
  assert.equal(readyLine(transcribe), "[ok] TRANSCRIBE_WORKER_SECRET is bound.");
});

test("a transcribe list that never shows the name fails after about 30 seconds, with the transcribe words, and does not print a row value", async () => {
  let clock = 0;
  const waits = [];
  const logs = [];
  const state = await waitForBindings({
    request: async () => ({ success: true, result: [{ name: "OTHER", value: "must-not-be-printed" }] }),
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    now: () => clock,
    required: transcribe,
    log: (line) => logs.push(line),
  });
  assert.equal(state.ok, false);
  assert.equal(waits.reduce((sum, ms) => sum + ms, 0), 30_000);
  const text = explain(state);
  assert.equal(
    text,
    [
      "[FAIL] TRANSCRIBE_WORKER_SECRET is not bound to this Worker.",
      "       Bound secrets: OTHER",
      "       Without it every transcribe call is answered 401.",
    ].join("\n"),
  );
  assert.equal(text.includes("must-not-be-printed"), false);
  assert.equal(JSON.stringify(state).includes("must-not-be-printed"), false);
  assert.equal(logs.join("\n").includes("must-not-be-printed"), false);
});

test("an empty transcribe list says no secrets are bound", () => {
  const text = explain(readBindings({ success: true, result: [] }, transcribe));
  assert.equal(
    text,
    [
      "[FAIL] TRANSCRIBE_WORKER_SECRET is not bound to this Worker.",
      "       Bound secrets: (none)",
      "       Without it every transcribe call is answered 401.",
    ].join("\n"),
  );
});

test("a list fetch carries a timeout so a hung request rejects", async () => {
  let seen;
  const request = secretsRequest({
    url: "https://example.test/accounts/not-a-real-account/workers/scripts/context-transcribe/secrets",
    token: "not-a-real-token",
    timeoutMs: 20,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        seen = init;
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      }),
  });
  const result = await Promise.race([
    request().then(
      () => "resolved",
      (error) => error,
    ),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 1000)),
  ]);
  assert.notEqual(result, "hung");
  assert.equal(result.name, "TimeoutError");
  assert.equal(seen.signal instanceof AbortSignal, true);
});
