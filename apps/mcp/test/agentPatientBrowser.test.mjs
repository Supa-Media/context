/**
 * A JOB TAKES ITS TIME ON A SLOW PAGE (the owner, 2026-11-16).
 *
 * A background job on an old ASP.NET vendor portal was handed "(no text)" and
 * "(nothing)" to press for a page whose menus were all there when it read it
 * again later, and it wandered the menus. "It's not about speed for jobs."
 * Now a job's browser asks the screenshot Worker to wait long for a page that
 * reads blank (`infra/site-shots/src/patience.ts`), a chat turn keeps the
 * Worker's short wait, a page still blank after the wait is said to be
 * loading rather than empty, and a wait step lets a job wait longer.
 *
 * ## Sabotage record
 *
 *   `patient` not passed on from `browserSession` to the browser
 *     → "a job's first run of each call asks for the long wait" fails
 *   `readingText` saying "(no text)" for a blank page
 *     → "a blank page reads as still loading, never as empty" fails
 *   `waitMs` dropped from the Worker's request body
 *     → "the wait reaches the screenshot Worker on both browsers" fails
 *   `pageReads.js` taking the still-loading line for a page read
 *     → "a blank page reads as still loading, never as empty" fails
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BROWSE_DEFINITION, JOB_PAGE_WAIT_MS, browserSession } from "../../../packages/tex/gateway/agent/browse.js";
import { DRAWN_PAGE, NO_TEXT_YET, readingText } from "../../../packages/tex/gateway/agent/browseReading.js";
import { resetBrowserbaseProbe, siteShotsComputer } from "../../../packages/tex/gateway/agent/browserProviders.js";
import { openTurnWeb } from "../../../packages/tex/gateway/agent/turnWeb.js";
import { pagesRead } from "../../../packages/tex/gateway/agent/pageReads.js";

const PORTAL = "https://portal.example.com/Default.aspx";

function fakeComputer({ blank = false, captcha = null } = {}) {
  const calls = [];
  return {
    calls,
    mayResume: () => true,
    async browse(session, steps, options) {
      calls.push({ steps, options });
      return {
        session: "bb-session-0001",
        ran: steps.map((step) => ({ do: step.do, ok: true })),
        page: { url: PORTAL, title: "Portal", text: blank ? "" : "Timesheets", truncated: false, elements: [], ...(blank ? { loading: 75 } : {}) },
        ...(captcha && calls.length === 1 ? { captcha } : {}),
      };
    },
  };
}

const session = (computer, extra = {}) => browserSession(computer, { allowed: new Set([PORTAL]), addresses: "check the portal", takePages: () => true, ...extra });
const textOf = (result) => result.content.map((part) => part.text ?? "").join("\n");

test("a job's first run of each call asks for the long wait, and a chat turn never does", async () => {
  const job = fakeComputer({ captcha: "unsolved" });
  await session(job, { patient: true }).call({ steps: [{ do: "goto", url: PORTAL }] });
  assert.equal(job.calls[0].options?.waitMs, JOB_PAGE_WAIT_MS);
  // The captcha's retries in the same call keep the Worker's short wait, so the call stays inside its 160 s.
  assert.ok(job.calls.length > 1);
  for (const later of job.calls.slice(1)) assert.equal(later.options?.waitMs, undefined);
  const chat = fakeComputer();
  await session(chat).call({ steps: [{ do: "goto", url: PORTAL }] });
  assert.equal(chat.calls[0].options?.waitMs, undefined);
  // The job's wait fits the browse call's limit with room for the steps and a captcha's solver.
  assert.ok(JOB_PAGE_WAIT_MS + 17_000 + 30_000 + 2 * 8_000 < 160_000);
});

test("a wait step goes to the browser with whole seconds, 1 to 60", async () => {
  const computer = fakeComputer();
  const browser = session(computer, { patient: true });
  await browser.call({ steps: [{ do: "wait", seconds: 30.7 }] });
  assert.deepEqual(computer.calls[0].steps, [{ do: "wait", seconds: 30 }]);
  for (const seconds of [0, 61, undefined, "soon"]) {
    const refused = await browser.call({ steps: [{ do: "wait", seconds }] });
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /A wait step needs seconds, from 1 to 60/);
  }
  assert.match(BROWSE_DEFINITION.description, /a wait step with seconds \(up to 60\)/);
  assert.match(BROWSE_DEFINITION.description, /Never decide a blank page is empty/);
  assert.ok(BROWSE_DEFINITION.inputSchema.properties.steps.items.properties.do.enum.includes("wait"));
});

test("a blank page reads as still loading, never as empty", async () => {
  const result = await session(fakeComputer({ blank: true }), { patient: true }).call({ steps: [{ do: "goto", url: PORTAL }] });
  const said = textOf(result);
  assert.match(said, /still loading after 75 seconds/);
  assert.match(said, /add a wait step/);
  assert.doesNotMatch(said, /\(no text\)/);
  assert.doesNotMatch(said, /^\(nothing\)$/m);
  // A blank reading from a Worker that did not wait says the same in short.
  const unwaited = readingText({ url: PORTAL, title: "", text: "", elements: [] }, [{ do: "read", ok: true }]);
  assert.ok(unwaited.includes(NO_TEXT_YET));
  // A page with words is read as it is.
  assert.match(readingText({ url: PORTAL, title: "", text: "Reports", elements: [] }, []), /\nReports\n/);
  // A page drawn rather than written (a PDF shown whole) points at a look or a download, not a wait.
  assert.ok(readingText({ url: PORTAL, title: "", text: "", elements: [], drawn: true }, []).includes(DRAWN_PAGE));
  // None of them counts as the page having been read (`pageReads.js`), however long the line.
  for (const extra of [{ loading: 75 }, { drawn: true }, {}]) assert.equal(pagesRead(readingText({ url: PORTAL, title: "", text: "", elements: [], ...extra }, [])).size, 0);
});

test("the wait reaches the screenshot Worker on both browsers", async () => {
  resetBrowserbaseProbe();
  const bodies = [];
  const binding = {
    async fetch(_url, init) {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.provider === "browserbase") return new Response(JSON.stringify({ error: "no key" }), { status: 501 });
      return Response.json({ session: "cf-session-0001", ran: [], page: { url: PORTAL, title: "", text: "", elements: [] } });
    },
  };
  const computer = siteShotsComputer({ SITE_SHOTS: binding }, { owner: "a".repeat(64) });
  await computer.browse(null, [{ do: "read" }], { waitMs: JOB_PAGE_WAIT_MS });
  assert.equal(bodies[0].provider, "browserbase");
  assert.equal(bodies[0].waitMs, JOB_PAGE_WAIT_MS);
  assert.equal(bodies[1].provider, undefined);
  assert.equal(bodies[1].waitMs, JOB_PAGE_WAIT_MS);
  await computer.browse(null, [{ do: "read" }]);
  assert.equal("waitMs" in bodies.at(-1), false);
  resetBrowserbaseProbe();
});

test("a background job's turn opens a patient browser, and a chat turn does not", async () => {
  resetBrowserbaseProbe();
  const sent = [];
  const SITE_SHOTS = {
    async fetch(_url, init) {
      const body = JSON.parse(init.body);
      sent.push(body);
      return Response.json({ session: "bb-session-0002", ran: body.steps.map((s) => ({ do: s.do, ok: true })), page: { url: PORTAL, title: "Portal", text: "Timesheets", elements: [] } });
    },
  };
  const env = { SITE_SHOTS, GATEWAY_SECRET: "test-secret" };
  const session = { actorUserId: "user_a", workspaceId: "ws_a", egress: {} };
  const ASK = `Get last week's report from ${PORTAL}`;
  for (const patient of [true, false]) {
    const { web } = await openTurnWeb(env, { session, texting: true, group: null, question: ASK, vouched: ASK, channel: null, store: null, dispatch: null, ledger: {}, patient });
    await web.call("browse", { steps: [{ do: "goto", url: PORTAL }] });
    const browse = sent.filter((body) => Array.isArray(body.steps)).at(-1);
    assert.equal(browse.waitMs, patient ? JOB_PAGE_WAIT_MS : undefined);
  }
  resetBrowserbaseProbe();
});
