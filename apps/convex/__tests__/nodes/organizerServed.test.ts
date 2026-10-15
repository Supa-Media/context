/**
 * Auto-organize's read-only passes list every note from the Convex tree where
 * it serves the workspace (phase 5 of
 * `docs/decisions/app-and-console/convex-tree.md`), instead of walking the
 * bucket at the start of every sweep.
 *
 * What is proved:
 *  - `gather` and `outline` read the tree's rows where it serves, and the
 *    bucket where it does not; every action that writes keeps the bucket;
 *  - a sweep gathered over the tree is the sweep gathered over the bucket,
 *    and lists no note folder of the bucket to get there.
 *
 * Sabotage (temporary local edits, reverted):
 *  - `ORGANIZER_READS` holding `resolve`: "every action that writes keeps the
 *    bucket" fails;
 *  - the organizer branch removed from `manifestSource`: "gather and outline
 *    read the tree where it serves" fails.
 */

import { describe, expect, test, vi } from "vitest";
import { getFunctionName } from "convex/server";
import type { Id } from "../../_generated/dataModel";
import type { FileStore } from "../../functions/lib/fileOps";
import { manifestSource } from "../../functions/lib/filesFns/treeOps";
import { nodesPagedStore } from "../../functions/lib/nodes/manifestStore";
import { privacyMirrorOf } from "../../functions/lib/nodes/privacyMirror";
import type { NodeRow } from "../../functions/lib/nodes/table";
import { runOrganizerOperation } from "../../functions/lib/organizer/sweepOps";
import { messyWorkspace, NOW, OWNER } from "../organizerEval/workspace.helpers";

const WS = "w1" as Id<"workspaces">;

/** Every key of the bucket as tree rows, the way a finished sweep leaves them. */
async function rowsOf(store: FileStore): Promise<NodeRow[]> {
  const rows: NodeRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list({ prefix: "", ...(cursor === undefined ? {} : { cursor }) });
    for (const object of page.objects as { key: string; etag?: string; size?: number; uploaded?: Date }[]) {
      if (object.key.startsWith(".")) continue;
      rows.push({
        path: object.key,
        ...(object.etag === undefined ? {} : { etag: object.etag }),
        ...(object.size === undefined ? {} : { size: object.size }),
        ...(object.uploaded === undefined ? {} : { uploaded: object.uploaded.getTime() }),
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The bucket, counting the note listings it answers. */
function counted(store: FileStore) {
  const listings: string[] = [];
  const watched = Object.create(store) as FileStore;
  watched.list = async (options) => {
    listings.push(options?.prefix ?? "");
    return await store.list(options);
  };
  return { watched, notes: () => listings.filter((prefix) => !prefix.startsWith(".")) };
}

function ctxServing(rows: NodeRow[] | null) {
  return {
    runQuery: vi.fn(async (ref: unknown, args: { after?: string; limit?: number }) => {
      const name = getFunctionName(ref as never);
      if (name === "functions/nodes:served") return rows === null ? null : { mirror: null };
      if (name === "functions/nodeMoves:active") return [];
      if (name === "functions/nodes:listLive") {
        const after = rows!.filter((row) => args.after === undefined || row.path > args.after);
        const page = after.slice(0, args.limit ?? 1000);
        return { rows: page, cursor: after.length > page.length ? page[page.length - 1]!.path : null };
      }
      throw new Error(`unexpected ${name}`);
    }),
  } as never;
}

const ARGS = { workspaceId: WS, scope: "private" as const };

describe("which store an organizer pass reads", () => {
  test("gather and outline read the tree where it serves", async () => {
    const { store } = messyWorkspace();
    for (const action of ["gather", "outline"]) {
      const answer = await manifestSource(ctxServing([{ path: "only/in-convex.md" }]), { ...ARGS, operation: { kind: "organizer", action } }, store);
      expect(answer.source, action).toBe("nodes");
      const listed = await answer.store.list({ prefix: "" });
      expect(listed.objects.map((object) => object.key)).toEqual(["only/in-convex.md"]);
    }
  });

  test("where the tree does not serve, the bucket answers", async () => {
    const { store } = messyWorkspace();
    const answer = await manifestSource(ctxServing(null), { ...ARGS, operation: { kind: "organizer", action: "gather" } }, store);
    expect(answer).toEqual({ store, source: "bucket" });
  });

  test("every action that writes keeps the bucket", async () => {
    const { store } = messyWorkspace();
    for (const action of ["record", "resolve", "autopilot", "undo", "deliver", "withdraw", "routing", "clear"]) {
      const answer = await manifestSource(ctxServing([]), { ...ARGS, operation: { kind: "organizer", action } }, store);
      expect(answer.source, action).toBe("bucket");
      expect(answer.store).toBe(store);
    }
  });
});

describe("a sweep over the tree", () => {
  test("gathers what the bucket gathers, without listing a note folder", async () => {
    const { store } = messyWorkspace();
    const fromBucket = await runOrganizerOperation(store, OWNER, { action: "gather", input: "{}" }, NOW, null);
    const rows = await rowsOf(store);
    const mirror = await privacyMirrorOf(store);
    const { watched, notes } = counted(store);
    const tree = nodesPagedStore(
      watched,
      async (after, limit) => {
        const rest = rows.filter((row) => after === undefined || row.path > after);
        const page = rest.slice(0, limit);
        return { rows: page, cursor: rest.length > page.length ? page[page.length - 1]!.path : null };
      },
      mirror.etag === undefined ? null : mirror,
    );
    const fromTree = await runOrganizerOperation(tree, OWNER, { action: "gather", input: "{}" }, NOW, null);
    expect(JSON.parse(fromTree)).toEqual(JSON.parse(fromBucket));
    expect(JSON.parse(fromTree).total).toBeGreaterThan(10);
    expect(notes()).toEqual([]);
  });
});
