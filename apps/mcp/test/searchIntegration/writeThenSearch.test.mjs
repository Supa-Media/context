/**
 * A note is searchable the moment its write returns — through the worker, not
 * through a direct call to the index.
 *
 * The defect this pins: a search only started a full pass once the index's
 * last listing was a minute old, and a search that found *anything* never
 * waited for one, so a note written a moment ago was missing from every answer
 * that also matched an older note. The write now re-indexes its own note behind
 * its response (`recordChange` → `syncShardedIndex`'s `only`), so the very next
 * search has it — with the reconcile clock still fresh, which is the case that
 * used to hide it.
 *
 * Sabotage: removing the `indexChangedNotes` call from `recordChange` fails
 * both checks below. That the write's pass lists nothing is held by
 * `searchShards/writeTargeted.test.mjs`.
 */

import { OWNER_TOKEN, callTool, indexedPaths, searchText } from "./fixtures.mjs";

export async function runSearchIntegrationWriteThenSearchChecks(check, harness) {
  const { bucket, env } = harness;

  // An older note that shares the term, and a search that makes the index's
  // listing fresh — so nothing but the write itself can put the new note in.
  bucket.seed("1-projects/gamma/older.md", "# Older\n\nA NARWHAL was sighted once.\n");
  await searchText(env, OWNER_TOKEN, { query: "narwhal" });
  await searchText(env, OWNER_TOKEN, { query: "narwhal" });

  const path = "1-projects/gamma/fresh.md";
  await callTool(env, OWNER_TOKEN, "write_note", {
    path,
    content: "# Fresh sighting\n\nA second NARWHAL, written just now.\n",
  });
  const afterWrite = await searchText(env, OWNER_TOKEN, { query: "narwhal" });
  check(
    "a note written through the worker is found by the next search, beside the older match",
    typeof afterWrite === "string" &&
      afterWrite.includes(path) &&
      afterWrite.includes("1-projects/gamma/older.md")
  );

  const destination = "1-projects/gamma/moved.md";
  await callTool(env, OWNER_TOKEN, "move_note", { source: path, destination });
  const afterMove = await searchText(env, OWNER_TOKEN, { query: "narwhal" });
  check(
    "a moved note is found at its new path by the next search, and not at its old one",
    typeof afterMove === "string" &&
      afterMove.includes(destination) &&
      !indexedPaths(bucket).includes(path)
  );
}
