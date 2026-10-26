/**
 * Tex end to end, live against staging, through the texts simulator.
 *
 * Proves what a person texting Tex gets, on the deployed Workers rather than
 * fakes: the seeded alpha@supa.media persona links a fictional 555-01XX number
 * (the simulator's only numbers) with a code from the app's own action, then
 * texts a quick question, a long task, a browser task, two pictures and a
 * vault request, and the run reads the replies the way the simulator page
 * does. The long
 * task must come back with more than one text (progress, then the result) and
 * never "Something went wrong".
 *
 * The transcript is printed: it is a staging persona's fixture notes and a
 * public web page, nothing real. The phone is unlinked at the end, whatever
 * happened.
 *
 * Needs APP_ENV=staging, STAGING_CONVEX_DEPLOYMENT, and TEX_SIMULATOR_ORIGIN
 * (the staging agent Worker's origin, which the workflow derives and masks).
 */

import assert from "node:assert/strict";
import { randomBytes, randomInt } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

const PERSONA = "alpha@supa.media";
/** "visuals" runs only the visual-answer checks (`tex-live-staging.yml`); anything else runs the whole set. */
const SUITE = process.env.TEX_LIVE_SUITE ?? "";
const CODE = "000000";
const deployment = process.env.STAGING_CONVEX_DEPLOYMENT;
const origin = (process.env.TEX_SIMULATOR_ORIGIN ?? "").replace(/\/+$/, "");
assert.equal(process.env.APP_ENV, "staging", "APP_ENV must be staging");
assert.ok(deployment && /^[a-z0-9-]+$/.test(deployment), "STAGING_CONVEX_DEPLOYMENT is required");
assert.ok(/^https:\/\/[^\s/]+$/.test(origin), "TEX_SIMULATOR_ORIGIN is required");

const ref = (name) => makeFunctionReference(name);
const key = randomBytes(32).toString("hex");
const phone = `+1415555${String(100 + randomInt(100)).padStart(4, "0")}`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pass = (label) => console.log(`PASS  ${label}`);
/** A vault or sign-in link is a live one-time token; the Actions log is public, so print only that it was there. */
const redact = (line) => line.replace(/\/(vault|link|setup)\/[^\s]+/g, "/$1/…");

async function sim(action, body) {
  const url =
    action === "thread"
      ? `${origin}/texts-simulator/api/thread?phone=${encodeURIComponent(phone)}`
      : `${origin}/texts-simulator/api/${action}`;
  const response = await fetch(url, {
    method: action === "thread" ? "GET" : "POST",
    headers: { "x-simulator-key": key, "content-type": "application/json" },
    body: action === "thread" ? undefined : JSON.stringify({ phone, ...body }),
  });
  assert.ok(response.ok, `simulator ${action} answered ${response.status}`);
  return response.json();
}

/** Text Tex and wait until it has stopped typing; returns the texts it sent back. */
async function text(message, { timeoutMs = 3 * 60_000 } = {}) {
  const before = (await sim("thread")).messages.length;
  const sent = Date.now();
  await sim("send", { text: message });
  console.log(`\n> ${message}`);
  let printed = before + 1;
  for (;;) {
    await pause(2000);
    const thread = await sim("thread");
    for (const entry of thread.messages.slice(printed)) {
      console.log(`< [${Math.round((entry.at - sent) / 1000)}s] ${redact(entry.text)}`);
    }
    printed = Math.max(printed, thread.messages.length);
    if (!thread.typing && thread.messages.length > before + 1) {
      return thread.messages.slice(before + 1).filter((entry) => entry.dir === "in").map((entry) => entry.text);
    }
    assert.ok(Date.now() - sent < timeoutMs, `no reply to "${message}" within ${timeoutMs / 1000}s`);
  }
}

const convex = new ConvexHttpClient(`https://${deployment}.convex.cloud`, { logger: false });
await convex.action(ref("auth:signIn"), { provider: "email", params: { email: PERSONA } });
const signedIn = await convex.action(ref("auth:signIn"), { provider: "email", params: { email: PERSONA, code: CODE } });
assert.ok(signedIn.tokens?.token, "persona sign-in failed");
convex.setAuth(signedIn.tokens.token);
pass("signed in as the alpha persona");

// Before texting: the gateway's own answer to one app turn for this persona,
// so a broken workspace (no reachable storage, no model) fails here with its
// reason instead of as Tex's opaque "Something went wrong". Status and error
// code only.
{
  const workspaces = await convex.query(ref("functions/workspaces:listMyWorkspaces"), {});
  const personal = workspaces.find((w) => w.kind === "personal") ?? workspaces[0];
  const grant = await convex.action(ref("functions/agentGrant:mintConsoleGrant"), { workspaceId: personal._id ?? personal.workspaceId });
  const answered = await fetch("https://mcp-staging.context.lc/agent", {
    method: "POST",
    headers: { authorization: `Bearer ${grant.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ question: "Hi", timeZone: "America/New_York" }),
  });
  const body = await answered.json().catch(() => ({}));
  assert.equal(answered.status, 200, `the gateway refused the persona's turn: ${answered.status} ${body.error ?? ""} ${body.error_description ?? ""}`);
  pass("the gateway answers the persona's own turn");
}

let failed = null;
try {
  const { code } = await convex.action(ref("functions/textLinks:startPhoneLink"), { phone });
  const linked = await text(`link ${code}`, { timeoutMs: 60_000 });
  assert.ok(linked.some((reply) => /Tex/.test(reply) && /connected/.test(reply)), `link reply: ${linked.join(" | ")}`);
  pass("a fictional number links with the app's code, and Tex introduces itself");

  if (SUITE === "visuals") {
    // Visual answers (docs/decisions/texting-assistant/visual-answers.md): a
    // list of options or a plan comes back as a card and one line, and a
    // plain question stays words. The simulator logs a picture as "[picture]".
    const options = await text(
      "Compare these caterers for 30 people, budget $300: Blend LIC $225, Lugo's $230, India Passage $290. Which one?",
      { timeoutMs: 4 * 60_000 },
    );
    assert.ok(options.some((reply) => /^\[picture/.test(reply)), `options reply: ${options.join(" | ")}`);
    pass("options to choose between come back as a card");
    const week = await text("Plan me a Saturday in Montreal: breakfast, a museum, a walk and dinner, with times.", { timeoutMs: 6 * 60_000 });
    assert.ok(week.some((reply) => /^\[picture/.test(reply)), `plan reply: ${week.join(" | ")}`);
    pass("a day's plan comes back as a card");
    const fact = await text("What's 12 times 12?", { timeoutMs: 2 * 60_000 });
    assert.ok(!fact.some((reply) => /^\[picture/.test(reply)), `fact reply: ${fact.join(" | ")}`);
    pass("one fact stays words");
  } else {

    const quick = await text("Hey, what are you?");
    assert.ok(quick.length >= 1 && !quick.some((reply) => /Something went wrong/.test(reply)), "quick answer failed");
    pass("a quick question is answered");

    // Tex knows the time where the person is (owner, 2026-10-14: it once asked
    // for the phone's time). A reminder "in 2 minutes" is set without a question
    // about the time, and its text arrives from the routine a few minutes later.
    const reminder = await text("Remind me to stretch in 2 minutes", { timeoutMs: 3 * 60_000 });
    assert.ok(
      !reminder.some((reply) => /what time|your phone|don't have a clock|can't see the time/i.test(reply)),
      `reminder reply asked for the time: ${reminder.join(" | ")}`,
    );
    pass("a reminder in 2 minutes is set without asking what time it is");
    const set = Date.now();
    const seen = (await sim("thread")).messages.length;
    let reminded = null;
    while (reminded === null) {
      assert.ok(Date.now() - set < 6 * 60_000, "no reminder text within 6 minutes");
      await pause(10_000);
      const fresh = (await sim("thread")).messages.slice(seen).filter((entry) => entry.dir === "in");
      reminded = fresh.find((entry) => /stretch/i.test(entry.text)) ?? null;
    }
    console.log(`< [reminder after ${Math.round((reminded.at - set) / 1000)}s] ${redact(reminded.text)}`);
    pass("the reminder texts on time, from its routine");

    const long = await text(
      "Find the opening hours of the Louvre on the web, then save them to a new note in my inbox called louvre-hours.md, and tell me when it's done.",
      { timeoutMs: 11 * 60_000 },
    );
    assert.ok(!long.some((reply) => /Something went wrong/.test(reply)), `long task failed: ${long.join(" | ")}`);
    assert.ok(long.length >= 2, `a long task should text progress before its result, got: ${long.join(" | ")}`);
    pass("a long task texts progress and then its result");

    // The browser (apps/mcp/src/agent/browse.js): a site's own search box,
    // typed with the person's words, then the answer read off the result.
    const browsed = await text(
      "Go to wikipedia.org, type Ada Lovelace into its search box and open her article, then tell me the year she was born.",
      { timeoutMs: 6 * 60_000 },
    );
    assert.ok(browsed.some((reply) => /1815/.test(reply)), `browsing reply: ${browsed.join(" | ")}`);
    pass("Tex drives a browser: types into a site's search and reads the result");

    // Pictures (docs/decisions/texting-assistant/pictures.md): a graphic is a
    // page the screenshot Worker photographs, a photo is Google's image model
    // through the AI Gateway. The simulator logs each picture sent as
    // "[picture]".
    const drawn = await text("Make me a simple poster for a picnic this Saturday at noon in the park.", { timeoutMs: 4 * 60_000 });
    assert.ok(drawn.some((reply) => /^\[picture/.test(reply)), `poster reply: ${drawn.join(" | ")}`);
    pass("Tex draws a poster and texts it as a picture");
    const made = await text("Make me a photo of an orange cat wearing a yellow raincoat.", { timeoutMs: 4 * 60_000 });
    assert.ok(made.some((reply) => /^\[picture/.test(reply)), `photo reply: ${made.join(" | ")}`);
    pass("Tex makes a photo with the image model and texts it");

    // The vault (docs/decisions/texting-assistant/vault.md): a login is saved
    // by the person on a signed-in page, never by text, so asking Tex to keep
    // one must come back with that page's link. Nothing is saved here.
    const vault = await text("Can you save my login for news.ycombinator.com so you can sign in for me later?", {
      timeoutMs: 3 * 60_000,
    });
    assert.ok(vault.some((reply) => /\/vault\/\S+/.test(reply)), `vault reply: ${redact(vault.join(" | "))}`);
    pass("asking Tex to keep a login texts the save page's link, not a request for the password");
  }
} catch (error) {
  failed = error;
} finally {
  try {
    await text("unlink", { timeoutMs: 60_000 });
    console.log("Unlinked the fictional number.");
  } catch (error) {
    console.log(`Could not unlink: ${error.message}`);
  }
}
if (failed) throw failed;
