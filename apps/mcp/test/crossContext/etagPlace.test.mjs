/**
 * A note's version names where the note is (`tools/etagPlace.js`).
 *
 * The incident (2026-11-17): a Tex job read `@crystal-care/projects/…`, then
 * wrote the bare path, which addressed its own `@seyi`, with the etag it had
 * read. It was told "conflict" four times and left a second copy. Here the
 * same shape: TOKEN_EDITOR owns `@mine` and edits `@theirs`, and both hold
 * `1-projects/shared-name.md`.
 *
 * Sabotage record (temporary local edits, reverted):
 *  1. `checkEtagPlaces` call removed from `routeToolCall`: 3 checks fail, the
 *     refusal's. The write still lands nowhere, but only as the incident's
 *     bare "conflict" against @mine's note.
 *  2. `placeAnswerEtags` dropped from the main return: 7 checks fail, every
 *     one that reads a placed etag back.
 */

import { callTool, textOf, TOKEN_EDITOR } from "./fixtures.mjs";
import { bareEtag, bareEtagArguments, checkEtagPlaces, etagWorkspaceRefusal, parsePlacedEtag, placeAnswerEtags, placeEtag } from "../../src/tools/etagPlace.js";

const etagOf = (text) => /^etag: (\S+)$/m.exec(text)?.[1] ?? null;

/** @param {(label: string, ok: boolean) => void} check */
export async function runCrossContextEtagPlaceChecks(check, harness) {
  const { mine, theirs, env } = harness;

  /* ---------------------------- the stamp itself ---------------------------- */
  check("an etag is placed in its workspace and note", placeEtag("abc", "@band", "n1") === "@band/n1:abc");
  check("and in its workspace alone where the note id is not known", placeEtag("abc", "@band") === "@band:abc");
  check("a placed etag is never placed twice", placeEtag("@band:abc", "@other") === "@band:abc");
  check("a collaboration version keeps its dots", bareEtag("@band/n1:c2.x.y") === "c2.x.y" && parsePlacedEtag("@band/n1:c2.x.y")?.noteId === "n1");
  check("a bare etag is left as it is", bareEtag("abc") === "abc" && parsePlacedEtag("abc") === null);
  const answer = placeAnswerEtags({ content: [{ type: "text", text: "etag: abc\npath: a.md\n\nbody says etag: keep" }] }, "@band");
  check("an answer's header etag is placed, its body is not", answer.content[0].text === "etag: @band:abc\npath: a.md\n\nbody says etag: keep");
  const written = placeAnswerEtags({ content: [{ type: "text", text: "conflict: note changed since you read it (current etag xyz). Re-read" }] }, "@band");
  check("a conflict's current etag is placed too", written.content[0].text.includes("(current etag @band:xyz)"));
  const items = [{ source: "a.md", destination: "b.md", expected_source_etag: "@band:v1" }];
  const bared = bareEtagArguments({ moves: items });
  check("the gateway's own calls get the bare version, the caller's objects untouched", bared.moves[0].expected_source_etag === "v1" && items[0].expected_source_etag === "@band:v1");
  check(
    "a batch item's etag from another workspace is refused by name",
    /@band/.test((await checkEtagPlaces({ moves: [{ source: "a.md", expected_source_etag: "@band:v1" }] }, { workspace: "@mine", store: null })) ?? "")
  );
  check(
    "by name alone (a Lab test chat), an etag from elsewhere is refused and one from here is not",
    /@theirs/.test(etagWorkspaceRefusal({ path: "x.md", expected_etag: "@theirs:v" }, { context: null, own: "@mine" }) ?? "") &&
      etagWorkspaceRefusal({ path: "x.md", expected_etag: "@theirs:v" }, { context: "theirs", own: "@mine" }) === null
  );
  const otherArgs = { path: "a.md", expected_etag: "@band/n1:v" };
  const otherNote = await checkEtagPlaces(otherArgs, { workspace: "@band", store: { noteIdAt: async () => "n2" } });
  check(
    "an etag naming another note at the same path matches nothing, answered by the tool as any stale version (no existence oracle)",
    otherNote === null && otherArgs.expected_etag !== "v" && !otherArgs.expected_etag.includes("n1")
  );
  const sameArgs = { path: "a.md", expected_etag: "@band/n1:v" };
  await checkEtagPlaces(sameArgs, { workspace: "@band", store: { noteIdAt: async () => "n1" } });
  check("an etag naming this note hands the tool its bare version", sameArgs.expected_etag === "v");

  /* ------------------------------ through the gateway ------------------------------ */
  const read = textOf(await callTool(env, TOKEN_EDITOR, "read_note", { path: "@theirs/1-projects/shared-name.md" }));
  const theirEtag = etagOf(read);
  check("a read in another workspace hands back an etag naming it", typeof theirEtag === "string" && theirEtag.startsWith("@theirs"));
  const ownRead = textOf(await callTool(env, TOKEN_EDITOR, "read_note", { path: "1-projects/shared-name.md" }));
  check("a read of one's own names one's own", etagOf(ownRead)?.startsWith("@mine") === true);

  const beforeMine = mine.get("1-projects/shared-name.md")?.body;
  const wrong = await callTool(env, TOKEN_EDITOR, "write_note", {
    path: "1-projects/shared-name.md",
    content: "meant for theirs",
    expected_etag: theirEtag,
  });
  const words = textOf(wrong);
  check("the incident: that etag on a bare path is refused", wrong.isError === true && /^refused:/.test(words));
  check("and the refusal names both places", words.includes("@theirs") && words.includes("@mine/1-projects/shared-name.md"));
  check("and says how to reach the note that was read", words.includes('path "@theirs/1-projects/shared-name.md"'));
  check("and nothing was written in either workspace", mine.get("1-projects/shared-name.md")?.body === beforeMine && !String(theirs.get("1-projects/shared-name.md")?.body).includes("meant for theirs"));

  const right = await callTool(env, TOKEN_EDITOR, "write_note", {
    path: "@theirs/1-projects/shared-name.md",
    content: "THEIRS-MARKER updated through its own place",
    expected_etag: theirEtag,
  });
  check("the same etag where it came from writes", right.isError !== true && /written:/.test(textOf(right)));
  check("and the write's own etag names that workspace", /\(etag @theirs[^\s)]*\)/.test(textOf(right)));
  check("and it landed there", String(theirs.get("1-projects/shared-name.md")?.body).includes("updated through its own place"));

  const stale = await callTool(env, TOKEN_EDITOR, "write_note", {
    path: "@theirs/1-projects/shared-name.md",
    content: "THEIRS-MARKER from a stale read",
    expected_etag: theirEtag,
  });
  check("a stale etag from the right place is still an ordinary conflict, its current etag placed", /conflict/.test(textOf(stale)) && /current etag @theirs/.test(textOf(stale)));

  const legacy = await callTool(env, TOKEN_EDITOR, "write_note", {
    path: "1-projects/shared-name.md",
    content: "MINE-MARKER via a bare etag",
    expected_etag: bareEtag(etagOf(ownRead)),
  });
  check("a bare etag (from before placing) still works as it did", legacy.isError !== true && String(mine.get("1-projects/shared-name.md")?.body).includes("via a bare etag"));
}
