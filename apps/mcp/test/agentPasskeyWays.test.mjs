/**
 * A PASSKEY PAGE IS NOT THE END OF A GOOGLE SIGN-IN (2026-11-01).
 *
 * The texts below are written for these tests and follow the shape of the
 * failure: a background job signing in to a site with "Continue with Google"
 * met Google's passkey step and answered that Google "keeps asking for the
 * passkey" with "no other route", on a turn that never reached Google's list
 * of other ways.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *   `walls.passkey` dropped from `claimCheck` → "an answer that stops at a
 *     passkey before Google's other ways were seen gets one more round" fails.
 *   `passkeyMarks` line removed from `browse.js` → "a browser result says
 *     whether it met the wall or reached the other ways" fails.
 *   The `googleWays` branch dropped from `passkeyLine` → "Google's list of
 *     ways gets its own line" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { browserSession } from "../src/agent/browse.js";
import { PASSKEY_WAYS_NOTICE, stopsAtAPasskey } from "../src/agent/browserWalls.js";
import { claimCheck } from "../src/agent/claimCheck.js";
import { PASSKEY_LINE, WAYS_LINE, passkeyLine, passkeyMarks } from "../src/agent/pageWalls.js";

const PASSKEY_URL = "https://accounts.google.com/v3/signin/challenge/pk?TL=x";
const PASSKEY_TEXT = "Verify it's you\nUse your passkey to confirm it's really you\nTry again\nTry another way";
const WAYS_URL = "https://accounts.google.com/v3/signin/challenge/selection?TL=x";
const WAYS_TEXT = "Choose how you want to sign in:\nUse your passkey\nTap Yes on your phone or tablet\nEnter your password\nGet help";
const PASSWORD_URL = "https://accounts.google.com/v3/signin/challenge/pwd?TL=x";

const GAVE_UP = "SiteKeeper still won't let me in. Google keeps asking for the passkey on sam@example.com, and there's no other route I can get to. Want me to hand you the browser so you can approve it yourself?";

test("Google's list of ways gets its own line, and a password page none", () => {
  assert.equal(passkeyLine(PASSKEY_TEXT, PASSKEY_URL), PASSKEY_LINE);
  assert.equal(passkeyLine(WAYS_TEXT, WAYS_URL), WAYS_LINE);
  assert.equal(passkeyLine(WAYS_TEXT, "https://accounts.google.com/v3/signin/challenge/x"), WAYS_LINE, "by its words");
  assert.equal(passkeyLine("Welcome\nEnter your password", PASSWORD_URL), "");
  // Off Google, the list's words are a page's own.
  assert.equal(passkeyLine(WAYS_TEXT, "https://example.com/login"), PASSKEY_LINE);
  assert.match(WAYS_LINE, /Enter your password/);
  assert.match(WAYS_LINE, /Never pick a passkey/);
});

/** A browser whose one page is `page`. */
function browserOn(page) {
  return browserSession(
    {
      browse: async (session, steps) => ({ session: "bb-session-0003", page: { title: "Sign in", elements: [], ...page }, ran: steps.map((step) => ({ do: step.do, ok: true })) }),
    },
    { allowed: { has: () => true, add() {}, webIsOpen: () => true, trust() {}, openWeb() {} }, addresses: page.url, takePages: () => true },
  );
}

test("a browser result says whether it met the wall or reached the other ways", async () => {
  const wall = await browserOn({ url: PASSKEY_URL, text: PASSKEY_TEXT }).call({ steps: [{ do: "goto", url: PASSKEY_URL }] });
  assert.equal(wall.passkeyWall, true);
  assert.equal(wall.passkeyWaysSeen, undefined);
  const ways = await browserOn({ url: WAYS_URL, text: WAYS_TEXT }).call({ steps: [{ do: "goto", url: WAYS_URL }] });
  assert.equal(ways.passkeyWaysSeen, true);
  assert.ok(ways.content[0].text.includes(WAYS_LINE));
  assert.deepEqual(passkeyMarks({ url: "https://shop.example.com/", text: "Hi" }), {});
  assert.deepEqual(passkeyMarks({ url: PASSWORD_URL, text: "Enter your password" }), { passkeyWaysSeen: true });
});

/** Every notice a turn's check gives `answer`, round after round, after browser calls answering `results`. */
async function notices(answer, results) {
  const check = claimCheck({ question: "yes sign in", job: { goal: "Sign in to SiteKeeper with saved Google login" } });
  const web = check.wrapWeb({ tools: [{ name: "browse" }], call: async () => results.shift() });
  for (let i = 0; results.length > 0 && i < 10; i += 1) await web.call("browse", {});
  const said = [];
  for (let round = 0; round < 10; round += 1) {
    const notice = await check.check(answer);
    if (notice === null) break;
    said.push(notice);
  }
  return said;
}

const reading = (marks) => ({ content: [{ type: "text", text: "a page" }], ...marks });

test("an answer that stops at a passkey before Google's other ways were seen gets one more round", async () => {
  assert.ok((await notices(GAVE_UP, [reading({ passkeyWall: true })])).includes(PASSKEY_WAYS_NOTICE));
  // Once a turn.
  assert.equal((await notices(GAVE_UP, [reading({ passkeyWall: true })])).filter((n) => n === PASSKEY_WAYS_NOTICE).length, 1);
  // The list was read: what Tex says of it stands.
  assert.ok(!(await notices(GAVE_UP, [reading({ passkeyWall: true }), reading({ passkeyWaysSeen: true })])).includes(PASSKEY_WAYS_NOTICE));
  // No passkey page this turn (a report read back from a job): nothing to send it back to.
  assert.ok(!(await notices(GAVE_UP, [reading({})])).includes(PASSKEY_WAYS_NOTICE));
});

test("only an answer that stops at the passkey is one", () => {
  for (const draft of [
    GAVE_UP,
    "Google is blocking the sign-in with a passkey prompt.",
    "I can't get past Google's passkey step.",
    "It's stuck on the passkey page.",
  ]) assert.equal(stopsAtAPasskey(draft), true, draft);
  for (const draft of [
    "Signed in to SiteKeeper. Google skipped the passkey and took your password.",
    "Google texted a code to your phone ending in 12 instead of the passkey. Text it to me.",
    "You're in. Your dashboard shows 3 sites.",
  ]) assert.equal(stopsAtAPasskey(draft), false, draft);
});
