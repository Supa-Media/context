/**
 * The mailboxes a turn is told (`src/agent/mailAccounts.js`; Dev2, 2026-11-14).
 *
 * Sabotage record: `mailAccountsPrompt` returning "" → the first test fails;
 * the states moved into the context part → "...states stay out of the cached
 * part" fails; `mail` dropped from `turnPrompt`'s modules → the last fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_LISTED_MAILBOXES, mailAccountsFacts, mailAccountsPrompt } from "../src/agent/mailAccounts.js";
import { turnPrompt } from "../src/agent/turnPrompt.js";

const BOXES = [
  { address: "Me@Example.com", state: "ok" },
  { address: "work@example.com", state: "stale" },
  { address: "old@example.com", state: "needs_reconnect", readOnly: true },
  { address: "me@example.com", state: "ok" },
  { address: "not an address", state: "ok" },
];

test("a turn is told every connected mailbox, and how to search one or all", () => {
  const said = mailAccountsPrompt(BOXES);
  assert.match(said, /Their connected mailboxes: me@example\.com, work@example\.com, old@example\.com \(read only/);
  assert.match(said, /no account searches every one of them at once/);
  assert.match(said, /pass account with its address/);
  assert.match(said, /never say your search reaches only some/);
  assert.ok(!said.includes("not an address"));
  assert.equal(mailAccountsPrompt([]), "");
  assert.equal(mailAccountsPrompt(null), "");
});

test("...and the states stay out of the cached part, said per text only for a mailbox that is not fine", () => {
  assert.ok(!mailAccountsPrompt(BOXES).includes("stale") && !mailAccountsPrompt(BOXES).includes("reconnect"));
  const facts = mailAccountsFacts(BOXES);
  assert.match(facts, /work@example\.com hasn't synced for hours/);
  assert.match(facts, /old@example\.com needs reconnecting/);
  assert.ok(!facts.includes("me@example.com"));
  assert.equal(mailAccountsFacts([{ address: "me@example.com", state: "ok" }]), "");
});

test("a person with many mailboxes is told the first ones", () => {
  const many = Array.from({ length: MAX_LISTED_MAILBOXES + 3 }, (_, at) => ({ address: `m${at}@example.com`, state: "ok" }));
  const said = mailAccountsPrompt(many);
  assert.ok(said.includes(`m${MAX_LISTED_MAILBOXES - 1}@example.com`) && !said.includes(`m${MAX_LISTED_MAILBOXES}@example.com`));
});

test("the turn's prompt carries them as their own modules, the list in the context part and the states in the preamble", () => {
  const base = { texting: true, pictures: false, notes: null, models: null, tools: [], history: [], threadNote: "", turnNote: "", webNames: new Set(), progress: null, aboutMe: null, identity: null, jobs: null, voice: null, calendar: null, observe: false, workspaces: [], localNow: { now: Date.UTC(2026, 10, 14, 15), timeZone: "America/New_York" }, plan: null, nudge: "" };
  const built = turnPrompt(null, "anthropic/claude-haiku-5-5", { ...base, mail: BOXES });
  assert.ok(built.system.context.includes("Their connected mailboxes: me@example.com"));
  assert.ok(built.preamble.includes("Mailboxes not fine right now"));
  const ids = built.prompt.modules.map((module) => module.id);
  assert.ok(ids.includes("context/mail") && ids.includes("preamble/mailStates"), ids.join(","));
  // With no mailboxes, nothing is said, and the other modules are what they were.
  const none = turnPrompt(null, "anthropic/claude-haiku-5-5", base);
  assert.ok(!none.system.context.includes("connected mailboxes") && !none.preamble.includes("Mailboxes not fine"));
});
