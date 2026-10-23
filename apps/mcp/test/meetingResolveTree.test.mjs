/**
 * A meeting's note is found through the Convex tree, never by opening notes
 * (owner, 2026-10-14: "names, existence checks and front matter come only from
 * the Convex tree; storage is read only to open a note's body"). That is what
 * `resolveMeetingNotePath` (`src/meetings/notes.js`) answers with, for a
 * session whose note has moved since it was finalized.
 *
 * The bucket below counts every GET **by key**, so "the resolver never opened a
 * candidate note" is a number: the candidate keys' GET count is asserted to be
 * zero. The tree answers names (`ask: "names"`) and props (`ask: "props"`) from
 * the notes in the bucket; a search index is built beforehand, exactly as the
 * maintenance behind a response builds it.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *
 * 1. The stored path checked with `getWithLegacyFallback` again (a GET):
 *    "the stored path is confirmed by the tree, and the note is not opened"
 *    fails on the candidate GET count.
 * 2. Front matter read from the opened note (`parseMeetingNote(await text())`)
 *    in place of `factProps`: "a hit whose facts are not read yet is skipped,
 *    never opened" fails, because the unread note is then opened and matched.
 * 3. The forwarding ledger not consulted: "a renamed meeting note is found at
 *    its new name, through the forwarding trail" fails (nothing is indexed, so
 *    only the trail can find it).
 * 4. The forwarded address not checked with the caller's own `canSee`: "a
 *    forwarded address the tier cannot see is never returned" fails.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { R2Store, createBucket, createSearchBudget, syncShardedIndex } from "./searchShards/fixtures.mjs";
import { resolveMeetingNotePath } from "../src/meetings/notes.js";
import { propsOf } from "../src/tree/props.js";
import { compareKeys } from "../src/tree/served.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { withServedTree } from "./servedTree.mjs";

// The access rows the control plane sends beside the binding: 1-projects is team, everything else private.
const RULES = { etag: "rows-v1", accessVersion: 1, folders: [{ prefix: "1-projects", visibility: "team" }], notes: [] };

const MEETING_A = "mtg_resolve_a";
const MEETING_B = "mtg_resolve_b";
const TITLE = "Weekly sync";

/** A meeting note as `renderMeetingNote` writes its front matter and heading. */
function meetingNote(id, title = TITLE) {
  return `---\nmeeting-id: ${id}\nstarted: 2026-10-05T09:00:00Z\n---\n# ${title}\n\nThe discussion.\n`;
}

/**
 * Notes a bucket holds, with the tree's facts for it. `unread` names notes whose props the tree has not read.
 * The access rules come from the control plane's rows (`withPrivacyAuthority`), not from a file in the bucket.
 */
function treeBackedStore(notes, { unread = [], ledger = [], treeServed = true } = {}) {
  const bucket = createBucket();
  for (const [key, text] of Object.entries(notes)) bucket.seed(key, text);
  const store = withServedTree(new R2Store(bucket));
  Object.defineProperty(store, "treeFacts", {
    configurable: true,
    value: async (request) => {
      if (!treeServed) return { served: false, loading: false };
      if (request.ask === "names") {
        const files = request.paths.filter((path) => bucket.objects.has(path));
        return { served: true, files, folders: [] };
      }
      assert.equal(request.ask, "props", "the resolver asks only for names and props");
      return {
        served: true,
        props: request.paths
          .filter((path) => bucket.objects.has(path) && !unread.includes(path))
          .map((path) => {
            const parsed = propsOf(bucket.objects.get(path).body);
            return { path, version: bucket.etagOf(path), sealed: parsed === null, props: parsed && JSON.stringify(parsed) };
          }),
      };
    },
  });
  Object.defineProperty(store, "forwardingLedger", {
    configurable: true,
    value: { read: async () => ledger, record: async () => {} },
  });
  return { store: withPrivacyAuthority(store, { rules: RULES }), bucket };
}

/** Build the search index the way the maintenance behind a response would, then forget those reads. */
async function indexed(store, bucket) {
  for (let pass = 0; pass < 12; pass += 1) {
    const found = await syncShardedIndex(store, {
      budget: createSearchBudget(500),
      isIndexable: (key) => key.endsWith(".md") && key !== "privacy.md",
    });
    if (!found.changed) break;
  }
  bucket.resetCounts();
}

/** The GETs the resolver spent on `keys`, which must be none. */
function getsOf(bucket, keys) {
  return bucket.counts.gets.filter((key) => keys.includes(key));
}

const OWNER = "private";
const TEAM = "team";

test("the stored path is confirmed by the tree, and the note is not opened to check it", async () => {
  const path = "0-inbox/meetings/2026-10-05-weekly-sync.md";
  const { store, bucket } = treeBackedStore({ [path]: meetingNote(MEETING_A) });
  await indexed(store, bucket);

  const session = { id: MEETING_A, title: TITLE, notePath: path };
  assert.equal(await resolveMeetingNotePath(store, session, OWNER), path);
  assert.deepEqual(getsOf(bucket, [path]), [], "the candidate was never GET from the bucket");
});

test("a renamed meeting note is found at its new name, through the forwarding trail", async () => {
  const oldPath = "0-inbox/meetings/2026-10-05-weekly-sync.md";
  const newPath = "0-inbox/archive/weekly-sync-filed.md";
  const { store, bucket } = treeBackedStore(
    { [newPath]: meetingNote(MEETING_A) },
    { ledger: [{ from: oldPath, to: newPath, kind: "exact", at: 1 }] },
  );
  // Nothing is indexed: the search cannot find this note, so only the trail can.
  const session = { id: MEETING_A, title: TITLE, notePath: oldPath };
  assert.equal(await resolveMeetingNotePath(store, session, OWNER), newPath);
  assert.deepEqual(getsOf(bucket, [oldPath, newPath]), [], "neither the stale nor the new note was opened");
});

test("a renamed meeting note with no trail left is found by its title, from the tree's facts", async () => {
  const oldPath = "0-inbox/meetings/2026-10-05-weekly-sync.md";
  const newPath = "0-inbox/archive/weekly-sync-filed.md";
  const otherPath = "0-inbox/meetings/2026-10-06-weekly-sync.md";
  const { store, bucket } = treeBackedStore({
    [newPath]: meetingNote(MEETING_A),
    [otherPath]: meetingNote(MEETING_B),
  });
  await indexed(store, bucket);

  const session = { id: MEETING_A, title: TITLE, notePath: oldPath };
  assert.equal(await resolveMeetingNotePath(store, session, OWNER), newPath);
  assert.deepEqual(getsOf(bucket, [oldPath, newPath, otherPath]), [], "no candidate was opened to read its meeting-id");
});

test("a title hit whose facts the tree has not read yet is skipped, never opened", async () => {
  const oldPath = "0-inbox/meetings/2026-10-05-weekly-sync.md";
  const newPath = "0-inbox/archive/weekly-sync-filed.md";
  const { store, bucket } = treeBackedStore(
    { [newPath]: meetingNote(MEETING_A) },
    { unread: [newPath] },
  );
  await indexed(store, bucket);

  // The only title match is this meeting's own note, but the tree cannot yet
  // confirm its meeting-id, so the stored path is reported honestly instead.
  const session = { id: MEETING_A, title: TITLE, notePath: oldPath };
  assert.equal(await resolveMeetingNotePath(store, session, OWNER), oldPath);
  assert.deepEqual(getsOf(bucket, [newPath]), [], "the unread note was not opened to read its front matter");
});

test("a title collision is never resolved to another meeting's note, and nothing is opened", async () => {
  const oldPath = "0-inbox/meetings/2026-10-05-weekly-sync.md";
  const otherPath = "0-inbox/meetings/2026-10-06-weekly-sync.md";
  const { store, bucket } = treeBackedStore({ [otherPath]: meetingNote(MEETING_B) });
  await indexed(store, bucket);

  const session = { id: MEETING_A, title: TITLE, notePath: oldPath };
  assert.equal(await resolveMeetingNotePath(store, session, OWNER), oldPath);
  assert.deepEqual(getsOf(bucket, [otherPath, oldPath]), []);
});

test("a forwarded address the tier cannot see is never returned", async () => {
  const oldPath = "1-projects/weekly-sync.md";
  const privatePath = "0-inbox/archive/weekly-sync-private.md";
  const { store, bucket } = treeBackedStore(
    { [privatePath]: meetingNote(MEETING_A) },
    { ledger: [{ from: oldPath, to: privatePath, kind: "exact", at: 1 }] },
  );
  const session = { id: MEETING_A, title: TITLE, notePath: oldPath };

  assert.equal(await resolveMeetingNotePath(store, session, TEAM), oldPath, "a team reader is told the stored path");
  assert.equal(await resolveMeetingNotePath(store, session, OWNER), privatePath, "the owner resolves it normally");
  assert.deepEqual(getsOf(bucket, [oldPath, privatePath]), []);
});

test("a tree that does not serve names reports the stored path, and reads nothing to decide", async () => {
  const path = "0-inbox/meetings/2026-10-05-weekly-sync.md";
  const { store, bucket } = treeBackedStore({ [path]: meetingNote(MEETING_A) }, { treeServed: false });
  const session = { id: MEETING_A, title: TITLE, notePath: path };

  assert.equal(await resolveMeetingNotePath(store, session, OWNER), path);
  assert.deepEqual(getsOf(bucket, [path]), []);
});
