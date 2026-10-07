/**
 * Making a just-written note searchable, after the response is sent.
 *
 * Two derivatives. The R2 index in the customer's bucket is every context's,
 * free or paid, and a write re-indexes its own note there with a pass that
 * lists nothing (`syncShardedIndex`'s `only`, reached through `recordChange`).
 * The D1 projection is Premium's, and only once it is `ready`.
 *
 * Before the R2 half existed, a written note reached search only when a later
 * search found the index's last listing a minute old — and a search that had
 * other hits never waited for that, so a note written a moment ago was absent
 * from any answer that matched anything else. The writer knows exactly which
 * note changed; asking a listing to rediscover it was the whole delay.
 *
 * Both halves are behind the response and neither may fail the write: the
 * canonical note is already safe in the customer's bucket, and a later
 * reconciliation pass repairs either derivative.
 */

import { countProjected } from "./d1/backfill.js";
import { createD1Client } from "./d1/client.js";
import { projectNote, upsertStatements } from "./d1/project.js";
import { createSearchBudget } from "./maintain.js";
import { syncShardedIndex } from "./shards.js";
import { meaningWritable, removeMeaningNotes, writeMeaningNote } from "./meaning/store.js";

/**
 * Store ops one write's R2 pass may spend: the manifest and its docmap, the
 * shard and the note, the shard's write, the docmap's and the manifest's — and
 * room to spare for a move, which names two paths in two shards.
 */
export const WRITE_INDEX_OPS = 24;

/**
 * Re-index the notes a write changed, in the R2 index.
 *
 * @param {Array<{ path: string, version?: string|null, size?: number, removed?: boolean }>} notes
 *   what the writer stored, or `removed: true` for a path it took away (a
 *   move's source, an archive).
 * @returns {Promise<void>} never rejects.
 */
export async function indexWrittenNotes(store, notes) {
  const only = new Map();
  for (const note of notes) {
    if (!note || typeof note.path !== "string" || !note.path) continue;
    only.set(
      note.path,
      note.removed
        ? null
        : {
            version: typeof note.version === "string" ? note.version : "",
            uploaded: new Date().toISOString(),
            ...(Number.isFinite(note.size) ? { size: note.size } : {}),
          },
    );
  }
  if (only.size === 0) return;
  try {
    await syncShardedIndex(store, { budget: createSearchBudget(WRITE_INDEX_OPS), only });
  } catch {
    // A storage failure here is one note late, not lost: the next full pass
    // lists the bucket and finds it.
  }
}

/** Run `work` behind the response where the host can, in front of it where it cannot. */
async function afterResponse(store, work) {
  if (typeof store.defer === "function") {
    try {
      store.defer(work());
      return "deferred";
    } catch {
      // A host that refuses waitUntil is the same as one without it.
    }
  }
  await work();
  return "inline";
}

/**
 * The notes a change wrote, moved or removed, re-indexed in the R2 index
 * behind the response. Called from `recordChange`, which every note write
 * already goes through; the D1 projection is `projectWrittenNoteAfterResponse`
 * below, called by the writers that have the note's text in hand.
 */
export async function indexWrittenNotesAfterResponse(store, notes) {
  // A removed path leaves the meaning index here too: its passage ids come
  // from the path alone, so nothing has to be read. What a move or a restore
  // ADDS reaches it through the catch-up pass, as it does fast search's.
  const removed = meaningWritable(store)
    ? (notes ?? []).filter((note) => note?.removed).map((note) => note.path)
    : [];
  return afterResponse(store, async () => {
    await indexWrittenNotes(store, notes);
    if (removed.length > 0) await removeMeaningNotes(store, removed);
  });
}

/**
 * The derivatives that need the note's text: fast search's D1 projection once
 * it is `ready`, and search by meaning's index once it takes writes. Called by
 * the writers that have the text in hand; neither may fail the write.
 *
 * `meaning: false` skips the embedding for a writer that saves every few
 * seconds while somebody types (the live editor): re-embedding up to twelve
 * passages per keystroke batch is cost with nothing to show for it, and the
 * catch-up pass picks the note up from its changed version instead.
 */
export async function projectWrittenNoteAfterResponse(
  store,
  { path, content, version, visibility, meaning: embedNow = true },
) {
  const fast = Boolean(store.searchIndex && store.searchIndex.state === "ready");
  const meaning = embedNow !== false && meaningWritable(store);
  if (!fast && !meaning) return "off";

  const project = async () => {
    if (!fast) return;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const client = createD1Client(store.searchIndex);
        const projected = projectNote(path, {
          version,
          uploaded: null,
          visibility,
          content,
        });
        await client.runAll(upsertStatements(path, projected));
        if (typeof store.reportSearchIndexProgress === "function") {
          const notesIndexed = await countProjected(client);
          await store.reportSearchIndexProgress({
            notesIndexed,
            notesPending: 0,
            state: "ready",
          });
        }
        return;
      } catch {
        // The canonical note is already safe in the customer's bucket. A
        // later reconciliation pass repairs the disposable projection.
      }
    }
    try {
      console.error(
        JSON.stringify({
          event: "search-projection-write-behind-failed",
          workspace: store.actor?.workspaceId,
        }),
      );
    } catch {
      // Reporting a derivative failure cannot fail the note write either.
    }
  };

  return afterResponse(store, async () => {
    await project();
    if (meaning) await writeMeaningNote(store, { path, content, visibility });
  });
}
