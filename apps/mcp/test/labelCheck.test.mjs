/**
 * A draft that would show the person an internal label goes back once, as a fact (`labelCheck.js`; 2026-11-27: a real
 * check-in went out as "[check-in] Two things to check…", and guest keys like guest-66ef reached five chats).
 * Sabotage: make `labelNotice` return null and the replay case `checkin-no-label-tag` fails with these.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { guestKeys, labelNotice, openingLabel } from "../../../packages/tex/gateway/agent/labelCheck.js";
import { claimChecksNode } from "../../../packages/tex/gateway/agent/graph/nodes/claimChecks.js";

test("a line opening with a label no step reads is found, as written", () => {
  for (const [draft, label] of [
    ["[check-in] Two things to check.", "[check-in]"],
    ["  [Today] the form is due", "[Today]"],
    ["Heads up.\n[follow-up] the venue wrote back", "[follow-up]"],
    ["[Fri 2026-11-27 18:00] hey", "[Fri 2026-11-27 18:00]"],
  ]) assert.equal(openingLabel(draft), label, draft);
});

test("what a step reads, links, wiki links, checkboxes and brackets inside a sentence are left alone", () => {
  for (const draft of ["[picture 1]", "Here it is\n[picture https://example.invalid/a.png]", "[card times]", "[2] yes, Friday", "[continues 3] Found it.", "[the venue](https://example.invalid)", "[[1 Samuel 3]] has it", "[ ] call Jo", "[x] done", "She wrote \"[sic]\" there.", "- [today] a list line", "plain words"]) {
    assert.equal(openingLabel(draft), null, draft);
  }
});

test("a guest's ledger key anywhere is an internal label too", () => {
  assert.deepEqual(guestKeys("Instinct and Boba are saved as guest-66ef and guest-6ce3, and guest-66ef again."), ["guest-66ef", "guest-6ce3"]);
  assert.deepEqual(guestKeys("the guest list is long"), []);
  assert.deepEqual(JSON.parse(labelNotice("ask guest-7266 to sign up")), { internal_guest_keys: ["guest-7266"], sent_as_written: true, read_by_tex: false });
  assert.deepEqual(JSON.parse(labelNotice("[check-in] hi")), { line_opens_with: "[check-in]", sent_as_written: true, read_by_tex: false });
  assert.equal(labelNotice("Was that you?"), null);
});

test("the Claim checks node sends a labelled draft back once a turn, before the turn's own checks, even with none", async () => {
  const t = { drafts: { waiting: { draft: "[check-in] Was that you?" } }, answerChecks: null };
  const first = await claimChecksNode({}, { ctx: { turn: t } });
  assert.deepEqual(first, { when: ["back"], back: true, review: false });
  assert.match(t.claimNotice, /"line_opens_with":"\[check-in\]"/);
  const again = await claimChecksNode({}, { ctx: { turn: t } });
  assert.deepEqual(again, { when: ["pass"], back: false, review: false }, "a rewrite that keeps it goes on");
  assert.equal(t.claimNotice, null);
});
