// The post-commit graph hook (arch 16.3): the committed path, body and version
// of a Context-managed write are change hints for the link graph. The graph is
// a derivative, so nothing here may reject, slow or change the write: every
// exception is swallowed (reconciliation repairs what is missed) and, where the
// host can, the work runs behind the response.
import { loadGraphManifest } from "./manifest.js";
import { graphMode } from "./mode.js";
import { projectNote } from "./project.js";
import { isNewer } from "./rebuild.js";
import { afterResponse } from "../search/writeProjection.js";

/**
 * Project one written note. With budget 0 the manifest read is refused before any store op; with no manifest (reconciliation
 * creates it, Task 10), nothing else runs. A "pending" or "stale" result is
 * left to reconciliation. Never rejects.
 */
export async function projectNoteAfterWrite(store, { path, body, version, budget }) {
  try {
    const manifest = await loadGraphManifest(store, budget);
    // Newer code's generation: an older client never writes into it (arch 9.6).
    if (!manifest || isNewer(manifest)) return;
    await projectNote(store, path, body, version, {
      budget,
      gen: manifest.generation,
      mode: graphMode(store),
      now: Date.now(),
    });
  } catch {
    // A derivative's failure is one note late, not a failed write.
  }
}

/** `projectNoteAfterWrite` behind the response where `store.defer` exists. Never rejects. */
export async function projectNoteAfterWriteDeferred(store, hint) {
  try {
    await afterResponse(store, () => projectNoteAfterWrite(store, hint));
  } catch {
    // Same contract as above.
  }
}
