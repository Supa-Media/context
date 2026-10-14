/**
 * The kings folder, step by step, with storage paused after every step
 * (2026-10-14, `docs/decisions/app-and-console/one-name.md`).
 *
 * Create, rename, rename again, trash and restore one note, each through the
 * barrier's own store (pending moves folded in, the tree's names and kinds
 * attached), and stop the mover after every one, so the bucket is as far
 * behind the tree as it ever gets. After each step, and again once the mover
 * has caught up:
 *
 *  - every name is listed once, in order;
 *  - what the list shows and what a name check says agree, both ways;
 *  - a name the list shows free is accepted;
 *  - the note's heading is its name, and never two names run together.
 *
 * Runs the real Convex functions (`convex-test`) and the real queued moves
 * over an in-memory S3, as `queuedTrash.test.ts` does. Its notes are
 * collaborative, as people's are, which is what caught `followHeading`
 * comparing the bucket object's version with the document's: the heading
 * never followed (sabotage: read with `store.get` there and this fails).
 */

import { describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { FileStore } from "../../functions/lib/fileOps";
import { filesInTree } from "../../functions/lib/fileOps/treeChecks";
import { executeOperation } from "../../functions/lib/filesFns/executeOperation";
import type { FileOperation } from "../../functions/lib/filesFns/operationTypes";
import { attachQueueMove, storeWithMoves } from "../../functions/lib/nodes/moveBarrier";
import { runNodesOperation } from "../../functions/lib/nodes/run";
import { attachTreeListing } from "../../functions/lib/nodes/treeNames";
import { OWNER, drain, fixture, listed, type Fixture } from "./moveFixture.helpers";

const FOLDER = "1-projects/launch";

/** One operation as the barrier runs it, the mover paused afterwards; the tree told what changed. */
async function step(f: Fixture, operation: FileOperation, touched: string[] = []): Promise<Record<string, unknown>> {
  const args = { workspaceId: f.ws, scope: OWNER.scope, operation: { kind: operation.kind } };
  const moves = await f.t.query(internal.functions.nodeMoves.active, { workspaceId: f.ws });
  const view: FileStore = await storeWithMoves(f.ctx, args, f.store, moves);
  attachTreeListing(f.ctx, f.ws, view);
  attachQueueMove(f.ctx, args, view, f.store);
  const result = (await executeOperation(view, OWNER, operation, Date.now())) as Record<string, unknown>;
  if (touched.length > 0) {
    await runNodesOperation(
      f.ctx,
      { workspaceId: f.ws as Id<"workspaces">, scope: "private", operation: { kind: "nodesTouch", paths: touched, files: [] } },
      f.store,
    );
  }
  return result;
}

/** A read through the store a request gets now, with the moves still pending. */
async function readNow(f: Fixture, path: string): Promise<string | null> {
  const moves = await f.t.query(internal.functions.nodeMoves.active, { workspaceId: f.ws });
  const view = await storeWithMoves(f.ctx, { workspaceId: f.ws, scope: "private", operation: { kind: "read" } }, f.store, moves);
  const object = await view.get(path);
  return object === null ? null : await object.text();
}

async function checkNames(f: Fixture, note: string | null, probes: string[]): Promise<void> {
  const shown = await listed(f.owner, f.ws, FOLDER);
  // Once each, in order.
  expect(new Set(shown).size).toBe(shown.length);
  expect([...shown].sort()).toEqual(shown);
  // The list and the name check agree, both ways.
  const moves = await f.t.query(internal.functions.nodeMoves.active, { workspaceId: f.ws });
  const view = await storeWithMoves(f.ctx, { workspaceId: f.ws, scope: "private", operation: { kind: "write" } }, f.store, moves);
  attachTreeListing(f.ctx, f.ws, view);
  const taken = await filesInTree(view, probes);
  for (const probe of probes) expect([probe, taken.has(probe)]).toEqual([probe, shown.includes(probe)]);
  if (note === null) return;
  expect(shown).toContain(note);
  const text = await readNow(f, note);
  const name = note.slice(FOLDER.length + 1).replace(/\.md$/, "");
  expect(text?.split("\n")[0]).toBe(`# ${name}`);
}

describe("the kings folder with storage paused after every step", () => {
  test("names, name checks and headings agree at every step", async () => {
    const f = await fixture("s3");
    const kings = `${FOLDER}/kings.md`;
    const six = `${FOLDER}/kings-6.md`;
    const twenty = `${FOLDER}/kings-20.md`;
    const probes = [kings, six, twenty, `${FOLDER}/plan.md`];

    await step(f, { kind: "write", path: kings, text: "# kings\n\nnotes\n" }, [kings]);
    await checkNames(f, kings, probes);

    await step(f, { kind: "move", from: kings, to: six, followHeading: true }, [kings, six]);
    await checkNames(f, six, probes);

    await step(f, { kind: "move", from: six, to: twenty, followHeading: true }, [six, twenty]);
    await checkNames(f, twenty, probes);

    // Trashed and drawn gone at once; the bucket still holds it at its name.
    const trashed = await step(f, { kind: "trash", path: twenty });
    await checkNames(f, null, probes);
    expect(await listed(f.owner, f.ws, FOLDER)).not.toContain(twenty);

    // The name the list now shows free is free to take, mover still paused.
    await step(f, { kind: "write", path: six, text: "# kings-6\n" }, [six]);
    await checkNames(f, six, probes);

    await step(f, { kind: "restoreTrash", from: trashed.to as string, to: twenty }, [twenty]);
    await drain(f);
    await checkNames(f, twenty, probes);
    await checkNames(f, six, probes);
  });
});
