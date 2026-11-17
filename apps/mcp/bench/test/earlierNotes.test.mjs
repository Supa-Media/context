import assert from "node:assert/strict";
import { test } from "node:test";

import { linksIn, noteBody, seedLinkedNotes } from "../earlierNotes.mjs";

test("links come out once each, trailing punctuation dropped, no parent steps", () => {
  assert.deepEqual(linksIn("see context://@john/projects/a/trip.md. and context://@john/projects/a/trip.md, also context://@x/../y.md"), [{ context: "john", path: "projects/a/trip.md" }]);
  assert.deepEqual(linksIn("nothing here"), []);
});

test("the body is the chat's words with the links taken out", () => {
  assert.equal(noteBody("projects/lisbon-wedding/trip.md", ["All on one page: context://@john/projects/lisbon-wedding/trip.md", "Ceremony 4pm."]), "# Trip\n\nAll on one page.\n\nCeremony 4pm.\n");
});

test("only a missing note is written, and a refused write is skipped, never retried elsewhere", async () => {
  const calls = [];
  const dispatch = async (name, args) => {
    calls.push([name, args.path]);
    if (name === "read_note") return args.path === "there.md" ? { content: [] } : { isError: true };
    return args.path === "theirs.md" ? { isError: true } : { content: [] };
  };
  const got = await seedLinkedNotes(dispatch, ["context://@me/there.md context://@me/new.md context://@other/theirs.md"]);
  assert.deepEqual(got, { written: ["@me/new.md"], skipped: ["@other/theirs.md"] });
  assert.deepEqual(calls.filter(([n]) => n === "write_note").map(([, p]) => p), ["new.md", "theirs.md"]);
});
