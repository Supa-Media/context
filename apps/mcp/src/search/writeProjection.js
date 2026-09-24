/** Projecting a just-written note into the D1 search index after the response is sent. Moved verbatim out of `src/index.js`. */

import { countProjected } from "./d1/backfill.js";
import { createD1Client } from "./d1/client.js";
import { projectNote, upsertStatements } from "./d1/project.js";

export async function projectWrittenNoteAfterResponse(
  store,
  { path, content, version, visibility },
) {
  if (!store.searchIndex || store.searchIndex.state !== "ready") return "off";

  const run = async () => {
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

  if (typeof store.defer === "function") {
    try {
      store.defer(run());
      return "deferred";
    } catch {
      // A host that refuses waitUntil is the same as one without it.
    }
  }
  await run();
  return "inline";
}
