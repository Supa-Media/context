/**
 * The Durable Object that keeps Tex's notes: one per person (named by their
 * personal workspace) and one per group chat (decided by the owner,
 * 2026-10-31; `docs/decisions/texting-assistant/tex-durable-objects.md`).
 *
 * A note kept here still has its row in the file tree, with its id for a file
 * name, like every other note; the row is marked as living here rather than in
 * the workspace's bucket, and the gateway reads and writes its text here. The
 * object keeps only those texts, in its own SQLite (`texStore/objects.js`),
 * reached only from this gateway (`texStore/wire.js`), which has already
 * checked who is asking. Nothing here decides access.
 */

import { serveTexStore, texObjectsFor } from "./texStore/wire.js";

export class TexStore {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.objects = null;
  }

  async fetch(request) {
    this.objects ??= texObjectsFor(this.state);
    return await serveTexStore(this.objects, request);
  }
}
