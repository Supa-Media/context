import assert from "node:assert/strict";
import { test } from "node:test";

import { linksIn, noteBody, seedLinkedNotes } from "../earlierNotes.mjs";

test("links come out once each, trailing punctuation dropped, no parent steps", () => {
  assert.deepEqual(linksIn("see context://@john/projects/a/trip.md. and context://@john/projects/a/trip.md, also context://@x/../y.md"), [{ context: "john", path: "projects/a/trip.md" }]);
  assert.deepEqual(linksIn("nothing here"), []);
});

test("the body is the chat's words with the links taken out", () => {
  assert.equal(
    noteBody("projects/garden/plan.md", [
      "job you started 9 min ago finished: Beds measured. Page written: context://@sam/projects/garden/plan.md. Present to Sam.",
      "All on one page: context://@sam/projects/garden/plan.md",
      "Tomatoes go in the south bed.",
      "Shed list is separate: context://@sam/projects/shed.md",
    ]),
    "# Plan\n\nBeds measured.\n\nTomatoes go in the south bed.\n",
  );
});

test("only a note read as not found is written; a refused write or any other read error is skipped", async () => {
  const calls = [];
  const dispatch = async (name, args) => {
    calls.push([name, args.path]);
    if (name === "read_note") return args.path === "there.md" ? { content: [] } : args.path === "flaky.md" ? { isError: true, content: [{ type: "text", text: "storage unavailable" }] } : { isError: true, content: [{ type: "text", text: "not found" }] };
    return args.path === "theirs.md" ? { isError: true } : { content: [] };
  };
  const got = await seedLinkedNotes(dispatch, ["context://@me/there.md context://@me/new.md context://@other/theirs.md context://@me/flaky.md"]);
  assert.deepEqual(got, { written: ["@me/new.md"], skipped: ["@other/theirs.md", "@me/flaky.md"] });
  assert.deepEqual(calls.filter(([n]) => n === "write_note").map(([, p]) => p), ["new.md", "theirs.md"]);
});
