/**
 * A TEXTED YES IS ANSWERED IN THE PAST TENSE (owner, 2026-10-18).
 *
 * Dev said yes to a bug report and Tex answered "Done: send a bug report to the
 * Context team." The approval's summary is an imperative, written to be asked;
 * the confirmation now turns each clause's verb to the past tense.
 *
 * ## Sabotage record
 *
 *   `settleByText` echoing `Done: ${record.summary}.` again
 *     → reportGate, emailGate, calendarGate and the handle-claim checks fail
 *   `doneLine` converting only the first clause
 *     → "every facet of one call is in the past tense" fails
 *   `clauses` splitting inside quotes
 *     → "a quoted subject is left as it was written" fails
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { doneLine } from "../src/agent/doneLine.js";
import { calendarSummary } from "../src/tools/calendarWrite.js";
import { emailSummary } from "../src/tools/email.js";

test("every summary the gateway builds reads as done", () => {
  const cases = {
    "send a bug report to the Context team": "Done, I sent a bug report to the Context team.",
    "claim the handle @woodshop for a new shared workspace (handles are permanent)":
      "Done, I claimed the handle @woodshop for a new shared workspace (handles are permanent).",
    "let Claude use your GitHub key on api.github.com": "Done, I let Claude use your GitHub key on api.github.com.",
    "change something in @woodshop (write_note)": "Done, I changed something in @woodshop (write_note).",
    "publish the website": "Done, I published the website.",
    "fetch an image from example.com into a.md": "Done, I fetched an image from example.com into a.md.",
    "write projects/x.md into @woodshop": "Done, I wrote projects/x.md into @woodshop.",
    "make a.md visible to the team": "Done, I made a.md visible to the team.",
    "save this conversation where the team can read it": "Done, I saved this conversation where the team can read it.",
    "move a.md to b/a.md, where more people can read it": "Done, I moved a.md to b/a.md, where more people can read it.",
    "share a.md with every member by link": "Done, I shared a.md with every member by link.",
  };
  for (const [summary, line] of Object.entries(cases)) assert.equal(doneLine(summary), line);
  assert.equal(
    doneLine(calendarSummary({ action: "create", title: "Dentist" })),
    'Done, I added "Dentist" to your calendar.',
  );
  assert.equal(doneLine(calendarSummary({ action: "cancel", title: "Dentist" })), 'Done, I cancelled "Dentist" on your calendar.');
  assert.equal(
    doneLine(emailSummary({ to: ["jo@example.com"], cc: [], subject: "Re: Thursday" })),
    'Done, I sent an email to jo@example.com, "Re: Thursday".',
  );
});

test("every facet of one call is in the past tense", () => {
  assert.equal(
    doneLine("share a.md with anyone who has the link, and take answers from them"),
    "Done, I shared a.md with anyone who has the link, and took answers from them.",
  );
  assert.equal(
    doneLine("write a.md into @woodshop, and make a.md visible to the team"),
    "Done, I wrote a.md into @woodshop, and made a.md visible to the team.",
  );
});

test("a quoted subject is left as it was written", () => {
  assert.equal(
    doneLine('send an email to jo@example.com, "Notes, and send the deck"'),
    'Done, I sent an email to jo@example.com, "Notes, and send the deck".',
  );
});

test("a summary that starts with no known verb keeps the plain form", () => {
  assert.equal(doneLine("write_note"), "Done: write_note.");
  assert.equal(doneLine("sending things"), "Done: sending things.");
  assert.equal(doneLine(undefined), "Done.");
});
