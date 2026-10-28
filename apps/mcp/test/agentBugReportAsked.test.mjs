/**
 * "FILE THIS AS A BUG" FILES A BUG; "THE NOTE HAS A PICTURE" NEEDS ONE THERE
 * (Tex Devs group, 2026-10-26).
 *
 * Asked "File the fact that you can't see your own diagram and messages as a
 * bug report", Tex wrote into a team handoff note and texted "Filed."; then
 * "The known-limit note now has a picture" after a write that carried none.
 *
 * Sabotage record (local edits, reverted):
 * 1. `writeBeforeReport` always null: "a note write before the report is refused" fails.
 * 2. `filesABugElsewhere` always false: "an answer with no report goes back" fails.
 * 3. `claimsNotePicture` ignoring `images`: "a write that carried the card" fails.
 * 4. The group check dropped from `reportGate`: "a group's report never carries texts" fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { claimCheck } from "../src/agent/claimCheck.js";
import { BUG_NOTICE } from "../src/agent/bugCheck.js";
import { NOTE_PICTURE_NOTICE, claimsNotePicture } from "../src/agent/visuals/notice.js";
import { asksToFile, reportGate } from "../src/tools/reportGate.js";

const ASKED = "File the fact that you can’t see your own diagram and messages as a bug report";
const ok = async () => ({ content: [{ type: "text", text: "ok" }] });

test("the group's words ask to file a bug", () => {
  assert.ok(asksToFile(ASKED));
  assert.ok(asksToFile("log this as an issue"));
  assert.ok(!asksToFile("I filed my taxes as a single person"));
  assert.ok(!asksToFile("what is a bug"));
});

test("a note write before the report is refused, and runs once the report is filed", async () => {
  const claims = claimCheck({ question: ASKED });
  const calls = [];
  const call = claims.wrap(async (name, args) => {
    calls.push(name);
    return ok();
  });
  const refused = await call("write_note", { path: "projects/tex/handoff/self-improvement-loop.md", content: "# Loop" });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /a note is not one.*report_problem/s);
  assert.deepEqual(calls, [], "the note was never written");
  await call("report_problem", { message: "Tex can't see a diagram it sent in the group." });
  await call("write_note", { path: "notes/x.md", content: "# x", expected_etag: "e1" });
  assert.deepEqual(calls, ["report_problem", "write_note"]);
  assert.equal(claims.check("Filed."), null);
});

test("an answer with no report goes back once to file it; a held report counts", async () => {
  const claims = claimCheck({ question: ASKED });
  assert.equal(claims.check("Filed. I added it to the handoff note."), BUG_NOTICE);
  assert.notEqual(claims.check("Filed. I added it to the handoff note."), BUG_NOTICE, "once a turn");

  const held = claimCheck({ question: "file a bug about the missing card" });
  await held.wrap(async () => ({ isError: true, held: true, content: [{ type: "text", text: "Held for their YES" }] }))("report_problem", { message: "x" });
  assert.notEqual(held.check("I wrote it up."), BUG_NOTICE);

  const other = claimCheck({ question: "what's on the setlist?" });
  assert.equal(other.check("The opener."), null);
  assert.equal(await other.wrap(ok)("write_note", { path: "a.md", content: "a" }).then((r) => r.isError), undefined);
});

test("'the note now has a picture' needs a write that carried one", async () => {
  const said = "The known-limit note now has a picture: three steps, with the coordinator's decision as the open item.";
  assert.ok(claimsNotePicture(said, [{ name: "write_note", ok: true }]));
  assert.ok(claimsNotePicture("I added the diagram to the backlog note.", []));
  assert.ok(!claimsNotePicture("Here's the night out, and the note has the prices.", []));

  const bare = claimCheck({ question: "add the picture to that note" });
  await bare.wrap(ok)("write_note", { path: "n.md", content: "# n" });
  assert.equal(bare.check(said), NOTE_PICTURE_NOTICE);

  const carried = claimCheck({ question: "add the picture to that note" });
  await carried.wrap(ok)("write_note", { path: "n.md", content: "# n\n\n![[card.png]]", images: [{ name: "card.png", data: "picture:1" }] });
  assert.notEqual(carried.check(said), NOTE_PICTURE_NOTICE, "a write that carried the card");
  const v2 = claimCheck({ question: "add the picture to that note" });
  await v2.wrap(ok)("write", { action: "save", path: "n.md", content: "# n", args: { images: [{ name: "card.png", data: "picture:1" }] } });
  assert.notEqual(v2.check(said), NOTE_PICTURE_NOTICE, "the six-tool write too");
});

test("a group's report never carries texts, so the tagger's own texts with Tex stay theirs", async () => {
  let read = false;
  const sent = [];
  const store = {
    reportProblem: async (message, texts) => {
      sent.push({ message, texts });
      return { eventId: "e".repeat(32) };
    },
    get: async () => {
      read = true;
      return null;
    },
  };
  const session = { actorClientId: "context_texts_group", egress: { approved: true } };
  await reportGate({ message: "Tex can't see its own card.", share_texts: true }, { store, session });
  assert.deepEqual(sent, [{ message: "Tex can't see its own card.", texts: undefined }]);
  assert.equal(read, false, "their texts were never read");
});
