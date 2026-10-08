/**
 * Indexing priorities in the fast index's backfill (decided by the owner,
 * 2026-10-08): everything but the Inbox and Archive first, then the Inbox,
 * then the Archive, and the counts per priority the admin console shows.
 *
 * Sabotage record (temporary local edits, reverted):
 *   `sorted` back to plain path order             → "the Inbox and Archive wait…" fails
 *   the cursor stored as a bare path              → "a census larger than one probe window…" fails (it restarts forever)
 *   priorities counted from the census alone      → "counted per priority…" fails
 */

import {
  CURSOR_KEY,
  DESCRIPTOR,
  createD1Backend,
  createD1Client,
  createSearchBudget,
  noteStore,
  projectPass,
} from "./fixtures.mjs";
import { progressFrom } from "../../src/search/d1/backfill.js";

export async function runIndexingPriorityChecks(check) {
  const notes = {
    "0-inbox/capture.md": "# Capture\n",
    "1-projects/plan.md": "# Plan\n",
    "9-archive/old.md": "# Old\n",
    "todo.md": "# Todo\n",
    "2-areas/health.md": "# Health\n",
  };
  const census = new Map(Object.keys(notes).map((path) => [path, "v1"]));

  {
    const backend = createD1Backend();
    const client = createD1Client(DESCRIPTOR, { fetchImpl: (u, i) => backend.handle(u, i) });
    const store = noteStore(notes);
    const pass = (noteCap) =>
      projectPass(store, client, {
        census,
        visibilityOf: () => "team",
        budget: createSearchBudget(400),
        noteCap,
      });

    const first = await pass(3);
    check(
      "the Inbox and Archive wait for everything else",
      JSON.stringify(store.reads) === JSON.stringify(["1-projects/plan.md", "2-areas/health.md", "todo.md"]),
    );
    check(
      "counted per priority: what the projection holds against what the census holds",
      JSON.stringify(progressFrom(first).priorities) ===
        JSON.stringify([
          { priority: 1, indexed: 3, pending: 0 },
          { priority: 2, indexed: 0, pending: 1 },
          { priority: 3, indexed: 0, pending: 1 },
        ]),
    );

    await pass(1);
    check(
      "a pass resumes after the last note in priority order: the Inbox, then the Archive",
      store.reads[3] === "0-inbox/capture.md",
    );
    const last = await pass(1);
    check("and the Archive comes last", store.reads[4] === "9-archive/old.md" && last.sweepComplete);
    check(
      "everything counted once the sweep is done",
      JSON.stringify(progressFrom(last).priorities.map((p) => p.pending)) === "[0,0,0]" &&
        progressFrom(last).state === "ready",
    );
    backend.close();
  }

  {
    // A cursor written before priorities is a bare path: it reads as the
    // start, so nothing is skipped on the strength of an order no longer used.
    const backend = createD1Backend();
    const client = createD1Client(DESCRIPTOR, { fetchImpl: (u, i) => backend.handle(u, i) });
    backend.db.prepare("INSERT INTO index_state (key, value) VALUES (?, ?)").run(CURSOR_KEY, "1-projects/plan.md");
    const store = noteStore(notes);
    const result = await projectPass(store, client, {
      census,
      visibilityOf: () => "team",
      budget: createSearchBudget(400),
    });
    check(
      "an older cursor starts the sweep over rather than skipping notes",
      result.projected === 5 && result.sweepComplete,
    );
    backend.close();
  }
}
