/**
 * An ask about a record is not answered from memory (`recordRead.js`).
 *
 * Sabotage: drop `reread` from `untriedWebCheck`, or pass only `claims` to
 * `rereadCarried` in `runTheModel.js` → "a carried search or fetch lets the
 * answer go" fails. Drop `wrapLocal` from `untriedWebCheck`, or stop
 * `doItChecks` forwarding local calls to its inner check → "a read_back
 * local call lets the answer go" fails.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { doItChecks } from "../src/agent/doItChecks.js";
import { RECORD_READ_NOTICE, recordReadNotice } from "../src/agent/recordRead.js";
import { rereadCarried } from "../src/agent/turnResume.js";
import { untriedWebCheck } from "../src/agent/untriedWeb.js";

test("an ask to read a note, with no read, is sent back; a mention is not", () => {
  assert.equal(recordReadNotice("what does the note say about the trip", []), RECORD_READ_NOTICE);
  assert.equal(recordReadNotice("what does the note say about the trip", [{ name: "search_notes", ok: true }]), null);
  assert.equal(recordReadNotice("what's the capital of Portugal", []), null, "general knowledge is not a record");
  assert.equal(recordReadNotice("If nothing needs the chat, answer exactly SKIP.", []), null, "a check-in mentioning the chat is not an ask to read it");
  assert.equal(recordReadNotice("find catering for 30 people, in a plain note", []), null, "naming a note as where to write is not an ask to read one");
  assert.equal(
    recordReadNotice("every morning at 7:30 tell me what's due, and note the tulips in a plain note", []),
    null,
    "note as a verb, and a plain note to write, is not an ask to read one",
  );
  assert.equal(recordReadNotice("check the status page and share fourth", []), null, "a status page is not their page");
  assert.equal(recordReadNotice("check my email", []), RECORD_READ_NOTICE);
  assert.equal(recordReadNotice("read the page about the trip", []), RECORD_READ_NOTICE);
});

test("the front door's check sends a record ask back, and lets it go after a read", async () => {
  const unread = untriedWebCheck({ question: "what does my email from Paulo say" });
  assert.match(String(unread.check("Paulo says the ceremony is at 4.")), /have not read any of it/);
  const read = untriedWebCheck({ question: "what does my email from Paulo say" });
  await read.wrap(async () => ({ content: [{ type: "text", text: "From Paulo: ceremony at 4." }] }))("search_email", { query: "Paulo" });
  assert.equal(read.check("Paulo says the ceremony is at 4."), null);
});

test("a carried search or fetch lets the answer go", () => {
  const ask = "what does the note say about the trip";
  const carried = (name, args) => ({
    round: 1,
    messages: [
      { role: "assistant", text: "", toolCalls: [{ id: "c", name, args }] },
      { role: "tool", id: "c", name, text: "Lisbon in October." },
    ],
  });
  for (const name of ["search", "fetch"]) {
    const check = untriedWebCheck({ question: ask });
    rereadCarried(carried(name, name === "fetch" ? { id: "projects/trip.md" } : { query: "trip" }), check);
    assert.equal(check.check("The note says Lisbon in October."), null, `a carried ${name} lets the answer go`);
  }
  const sent = untriedWebCheck({ question: ask });
  rereadCarried(carried("send_email", { to: "ada@example.test" }), sent);
  assert.match(String(sent.check("The note says Lisbon in October.")), /have not read any of it/, "a carried send is not a read");
  // The front door's check is what a resumed turn tells (`runTheModel.js`); `claims` is null there.
  const source = readFileSync(new URL("../src/agent/texEntryPoint/runTheModel.js", import.meta.url), "utf8");
  assert.match(source, /rereadCarried\(rounds\?\.from \?\? null, claims \?\? tries\)/);
});

test("a read_back local call lets the answer go", async () => {
  const ask = "what does the note say about the trip";
  const door = doItChecks({ question: ask, inner: untriedWebCheck({ question: ask }) });
  const [readBack] = door.wrapLocal([{ tool: { name: "read_back" }, call: async () => ({ content: [{ type: "text", text: "Lisbon in October." }] }) }]);
  await readBack.call({ ref: "r1abcdef" });
  assert.equal(await door.check("The note says Lisbon in October."), null, "reopening a kept read is a read");
  const listed = doItChecks({ question: ask, inner: untriedWebCheck({ question: ask }) });
  listed.wrapLocal([{ tool: { name: "read_back" }, call: async () => ({ content: [{ type: "text", text: "Lisbon in October." }] }) }]);
  assert.match(String(await listed.check("The note says Lisbon in October.")), /have not read any of it/, "offering the tool without calling it is not a read");
});
