/**
 * ONE QUESTION DRIVES A CHAT'S BROWSER AT A TIME (Dev2, 2026-11-16).
 *
 * Two passes of one background job drove the same Browserbase browser and
 * their sign-in fills interleaved. Each question now names itself with a
 * holder on every call; the screenshot Worker answers 409 busy to anyone else
 * (`infra/site-shots/src/lease.ts`), and the gateway waits (`browserLease.js`).
 *
 * ## Sabotage record
 *
 *   `untilFree` returning the 409 at once instead of waiting
 *     → "a job waits for a busy browser, then runs" fails
 *   `browse.js` without its `error?.busy` branch
 *     → "a chat turn still busy after its brief wait is told the browser is in use" fails
 *   `close()` without `releaseBrowser`
 *     → "a question lets go of its lease when it ends" fails
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { browserSession } from "../../../packages/tex/gateway/agent/browse.js";
import { resetBrowserbaseProbe, siteShotsComputer } from "../../../packages/tex/gateway/agent/browserProviders.js";
import { BRIEF_WAIT_MS, BROWSER_BUSY, PATIENT_WAIT_MS } from "../../../packages/tex/gateway/agent/browserLease.js";

const OWNER = "a".repeat(64);
const PAGE = { url: "https://shop.example.com/", title: "Shop", text: "Welcome", elements: [] };

/** The screenshot Worker, busy for the first `busyFor` /browse calls. */
function binding({ busyFor = 0 } = {}) {
  const requests = [];
  let busy = busyFor;
  return {
    requests,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      const path = new URL(url).pathname;
      requests.push({ path, ...body });
      if (path === "/browse/release") return Response.json({ released: true });
      if (path === "/browse" && busy > 0) {
        busy -= 1;
        return Response.json({ busy: true, error: "another question is using this browser", retryMs: 60_000 }, { status: 409 });
      }
      return Response.json({ session: "bb-1", ran: body.steps.map((s) => ({ do: s.do, ok: true })), page: PAGE });
    },
  };
}

/** A clock that only moves when the waiting sleeps. */
function clock() {
  let at = 0;
  const slept = [];
  return { now: () => at, sleep: async (ms) => void (slept.push(ms), (at += ms)), slept };
}

function sessionOn(computer, { patient = false } = {}) {
  const allowed = new Set(["https://shop.example.com/"]);
  return browserSession(computer, { allowed, addresses: "open https://shop.example.com/", takePages: () => true, patient });
}

const text = (result) => result.content.map((part) => part.text ?? "").join("\n");

test("a job waits for a busy browser, then runs", async () => {
  resetBrowserbaseProbe();
  const SITE_SHOTS = binding({ busyFor: 3 });
  const time = clock();
  const computer = siteShotsComputer({ SITE_SHOTS }, { owner: OWNER, now: time.now, sleep: time.sleep });
  const result = await sessionOn(computer, { patient: true }).call({ steps: [{ do: "goto", url: "https://shop.example.com/" }] });
  assert.ok(!result.isError, text(result));
  assert.match(text(result), /Welcome/);
  assert.equal(SITE_SHOTS.requests.filter((r) => r.path === "/browse").length, 4);
  assert.ok(time.slept.length === 3 && time.slept.every((ms) => ms >= 2_000 && ms <= 10_000), `polls every few seconds: ${time.slept}`);
});

test("a job waits most of the browse tool's limit before it gives up, a chat turn only briefly", async () => {
  for (const [patient, cap] of [[true, PATIENT_WAIT_MS], [false, BRIEF_WAIT_MS]]) {
    resetBrowserbaseProbe();
    const time = clock();
    const computer = siteShotsComputer({ SITE_SHOTS: binding({ busyFor: 1_000 }) }, { owner: OWNER, now: time.now, sleep: time.sleep });
    await assert.rejects(computer.browse(null, [{ do: "read" }], { holder: "h-0000000001", patient }), (error) => error.busy === true);
    assert.ok(time.now() <= cap && time.now() >= cap / 2, `${patient ? "job" : "chat"} waited ${time.now()} ms`);
  }
  assert.ok(PATIENT_WAIT_MS < 160_000, "inside the browse tool's own 160 s limit");
  assert.ok(BRIEF_WAIT_MS <= 15_000);
});

test("a chat turn still busy after its brief wait is told the browser is in use, and nothing about a sign-in", async () => {
  resetBrowserbaseProbe();
  const time = clock();
  const computer = siteShotsComputer({ SITE_SHOTS: binding({ busyFor: 1_000 }) }, { owner: OWNER, now: time.now, sleep: time.sleep });
  const result = await sessionOn(computer).call({ steps: [{ do: "goto", url: "https://shop.example.com/" }] });
  assert.equal(result.isError, true);
  assert.equal(text(result), BROWSER_BUSY);
  assert.match(BROWSER_BUSY, /in use by another job right now/);
  assert.doesNotMatch(BROWSER_BUSY, /password|log ?in failed|invalid/i);
});

test("every call of one question carries the same holder, and another question its own", async () => {
  resetBrowserbaseProbe();
  const SITE_SHOTS = binding();
  const computer = siteShotsComputer({ SITE_SHOTS }, { owner: OWNER });
  const one = sessionOn(computer);
  await one.call({ steps: [{ do: "goto", url: "https://shop.example.com/" }] });
  await one.fillSecret({ ref: 1, value: "not-a-real-secret", origin: "https://shop.example.com", field: "password" });
  await sessionOn(computer).call({ steps: [{ do: "read" }] });
  const holders = SITE_SHOTS.requests.filter((r) => r.path === "/browse").map((r) => r.holder);
  assert.equal(holders.length, 3);
  assert.ok(holders.every((h) => typeof h === "string" && h.length >= 8));
  assert.equal(holders[0], holders[1], "the fill rides on the question's own lease");
  assert.notEqual(holders[0], holders[2]);
});

test("a fill on a busy browser says the browser is in use, never that the password failed", async () => {
  resetBrowserbaseProbe();
  const SITE_SHOTS = binding();
  const time = clock();
  const computer = siteShotsComputer({ SITE_SHOTS }, { owner: OWNER, now: time.now, sleep: time.sleep });
  const session = sessionOn(computer);
  await session.call({ steps: [{ do: "goto", url: "https://shop.example.com/" }] });
  SITE_SHOTS.fetch = (inner => async (url, init) => (new URL(url).pathname === "/browse" ? Response.json({ busy: true }, { status: 409 }) : inner(url, init)))(SITE_SHOTS.fetch);
  const filled = await session.fillSecret({ ref: 1, value: "not-a-real-secret", origin: "https://shop.example.com", field: "password" });
  assert.deepEqual(filled, { ok: false, reason: BROWSER_BUSY });
});

test("a question lets go of its lease when it ends, held for the person or not", async () => {
  for (const answer of ["Done, it's ordered.", "Text me the 6-digit code the site just sent."]) {
    resetBrowserbaseProbe();
    const SITE_SHOTS = binding();
    const session = sessionOn(siteShotsComputer({ SITE_SHOTS }, { owner: OWNER }));
    await session.call({ steps: [{ do: "goto", url: "https://shop.example.com/" }] });
    const holder = SITE_SHOTS.requests[0].holder;
    await session.close({ answer });
    assert.deepEqual(SITE_SHOTS.requests.at(-1), { path: "/browse/release", provider: "browserbase", owner: OWNER, holder });
  }
});

test("a question that never drove the browser releases nothing", async () => {
  resetBrowserbaseProbe();
  const SITE_SHOTS = binding();
  await sessionOn(siteShotsComputer({ SITE_SHOTS }, { owner: OWNER })).close({ answer: "Hi" });
  assert.deepEqual(SITE_SHOTS.requests, []);
});

test("Cloudflare's own browser, with no owner, is sent no holder and released by nobody", async () => {
  resetBrowserbaseProbe();
  const SITE_SHOTS = binding();
  const session = sessionOn(siteShotsComputer({ SITE_SHOTS }, {}));
  await session.call({ steps: [{ do: "goto", url: "https://shop.example.com/" }] });
  await session.close({ answer: "Done." });
  assert.equal(SITE_SHOTS.requests[0].holder, undefined);
  assert.ok(!SITE_SHOTS.requests.some((r) => r.path === "/browse/release"));
});
