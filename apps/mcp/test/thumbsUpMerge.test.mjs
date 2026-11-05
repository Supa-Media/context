/**
 * Dev2's 2026-11-04 chat (10:14 PM ET) as a golden case: Tex asked "Want me
 * to merge it? 👍 or 👎?", Dev2 liked it twice, and Tex asked again each
 * time. The Worker had the words the 👍 was on, but logged the tapback as
 * "👍" alone, and a texted turn reads its question from the log, so the model
 * saw "(a tapback) 👍" and guessed which message it meant.
 *
 * The Worker now logs a tapback as its line, "👍 (yes) on Tex's message …"
 * (`apps/agent/src/inboxTurn.ts` `logInbound`, tested in
 * `apps/agent/src/reactions.test.ts`); these check the gateway end: that line
 * is the turn's question, and the turn is told a 👍 on its question is the yes.
 *
 * Sabotage record (2026-11-05): `runTheModel` back to `logged?.question ??
 * askedWith(…)` (no `loggedTapback`) fails "a logged 👍 is told it is the yes".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { texLedger } from "../src/texStore/ledger.js";
import { durableSql } from "./texStoreFixture.mjs";
import { eventEntry } from "../src/agent/ledger.js";
import { loggedTurn } from "../src/agent/loggedTurn.js";
import { loggedTapback, quotedOf } from "../src/agent/quoted.js";

const CHAT = "texts";
const AT = 1_793_848_486_190;
const ASK = "The README fix is up as PR #836, but it isn't on main yet. Want me to merge it? 👍 or 👎?";
const LINE = `👍 (yes) on Tex's message "${ASK}"`;

test("a logged 👍 reaches the turn's question with the message it was on", async () => {
  const ledger = texLedger(durableSql());
  ledger.append(CHAT, [
    eventEntry({ id: `${AT - 12_000}-000578`, at: AT - 12_000, chat: CHAT, from: { kind: "tex" }, kind: "text", text: ASK }),
    eventEntry({ id: `${AT}-000579`, at: AT, chat: CHAT, from: { kind: "person", who: "a".repeat(64) }, kind: "reaction", text: LINE }),
  ]);
  const read = ledger.read(CHAT, { before: Number.MAX_SAFE_INTEGER });
  const logged = await loggedTurn(null, { covers: [`${AT}-000579`], chat: CHAT }, { ledger: Promise.resolve({ ...read, chat: CHAT }) });
  assert.ok(logged, "the turn is read from the log");
  assert.match(logged.question, /\(a tapback\) 👍 \(yes\) on Tex's message "The README fix is up as PR #836/);
});

test("a logged 👍 is told it is the yes, and only a tapback is", () => {
  const quoted = quotedOf({ quoted: ASK, tapback: "Liked" });
  const question = loggedTapback(`(a tapback) ${LINE}`, quoted);
  assert.match(question, /their yes: do it now, and never ask the same question again/);
  assert.ok(question.endsWith(`(a tapback) ${LINE}`), "the log's line stays the question");
  assert.equal(loggedTapback("merge it", quotedOf({ quoted: ASK })), "merge it", "an inline reply is not a tapback");
  assert.equal(loggedTapback("hi", quotedOf({})), "hi");
  // The turn uses it whenever its question comes from the log.
  const source = readFileSync(new URL("../src/agent/texEntryPoint/runTheModel.js", import.meta.url), "utf8");
  assert.equal((source.match(/logged \? loggedTapback\(logged\.question, quoted\) : askedWith\(question, quoted\)/g) ?? []).length, 2);
});
