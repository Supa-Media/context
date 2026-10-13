/**
 * Starting a queued folder move (phase 4 of
 * `docs/decisions/app-and-console/convex-tree.md`): the one step a person
 * waits for, however big the folder is.
 *
 * It runs inside the credential barrier, after the caller's access was
 * decided, and in this order:
 *
 *  1. Hold the names (`nodeMoves.reserve`). Refused while the tree does not
 *     serve this workspace, or the queue is full: the caller moves the old way.
 *     A move that shares a name with one still running is told to wait.
 *  2. Read what is under the folder from the tree's rows, not the bucket,
 *     through the moves already drawn. A folder holding anything the caller
 *     cannot see moves the old way, which already leaves those notes behind.
 *  3. The same refusals a move made in one go gives (`movePath`): an
 *     invisible source is not found, a destination that exists is refused
 *     without naming what the caller cannot see, and no destination may be
 *     one the caller could not see.
 *  4. Carry the rules (`movePrivacy.ts`), refresh the tree's copy of them,
 *     then draw the move (`nodeMoves.activate`). The move is drawn only if the
 *     tree's copy is the `privacy.md` just written, so a moved name is never
 *     judged without the narrowing it carries.
 *  5. Record the forwarding address and move the folder's icons, as a move
 *     made in one go does, so old links and the sidebar follow at once.
 *
 * A single note never queues: it moves in one step already, with its
 * version check, through `movePath`.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { recordForwarding } from "../../../../mcp/src/forwarding.js";
import { logicalPath, physicalCandidates } from "../../../../mcp/src/moves/queued.js";
import { remapFolderIcons } from "@context/shared/src/folderIcons.cjs";
import type { Clearance } from "../clearance";
import { FileOpError, notFound } from "../fileOps/errors";
import { folderVisibleAtScope } from "../fileOps/listing";
import { assertMoveDestinationsVisible } from "../fileOps/moveRules";
import { loadPrivacyState } from "../fileOps/privacyState";
import type { FileStore } from "../fileOps/store";
import type { MoveResult } from "../fileOps/moving";
import { PRIVACY_KEY, canSee } from "../privacy";
import { carryPrivacy, releasePrivacy } from "./movePrivacy";
import type { PendingMove } from "./moveOverlay";
import { touchNodesNow } from "./run";

/** Rows one inventory page reads. */
const ROWS_PAGE = 2_000;

/** What sits at a name in the tree as drawn: a folder (with its files), a file, or nothing. */
export interface Inventory {
  folder: boolean;
  file: boolean;
  /** Files under the folder, at their names in the tree. */
  files: string[];
}

/**
 * What the tree draws at `path`, read from rows through `moves`. With
 * `firstOnly`, stops at the first thing found: a destination check needs no
 * more than that.
 */
export async function inventory(
  ctx: Pick<ActionCtx, "runQuery">,
  workspaceId: Id<"workspaces">,
  path: string,
  moves: readonly PendingMove[],
  firstOnly = false,
): Promise<Inventory> {
  const found: Inventory = { folder: false, file: false, files: [] };
  const seen = new Set<string>();
  for (const candidate of physicalCandidates(path, moves) as string[]) {
    let after: string | undefined;
    for (;;) {
      const page = await ctx.runQuery(internal.functions.nodeMoves.rowsUnder, {
        workspaceId,
        path: candidate,
        ...(after === undefined ? {} : { after }),
        limit: ROWS_PAGE,
      });
      for (const row of page.rows) {
        const folded = logicalPath(row.path, moves) as string;
        if (seen.has(folded)) continue;
        if (folded === path) {
          seen.add(folded);
          if (row.kind === "folder") found.folder = true;
          else found.file = true;
        } else if (folded.startsWith(`${path}/`)) {
          seen.add(folded);
          found.folder = true;
          if (row.kind === "file" && !folded.endsWith("/")) found.files.push(folded);
        }
        if (firstOnly && (found.folder || found.file)) return found;
      }
      if (page.cursor === null || page.cursor === after) break;
      after = page.cursor;
    }
  }
  return found;
}

/** Whether a store can move one object without ever losing an edit (`moveObject`). */
export function storeCanQueue(store: FileStore): boolean {
  const capabilities = store.capabilities;
  return capabilities?.conditionalCreate === true && (capabilities.conditionalDelete === true || capabilities.conditionalWrite === true);
}

/**
 * Start a queued move of folder `from` to `to`, or answer `null` for "move it
 * the old way". Throws the refusals `movePath` would.
 */
export async function startQueuedMove(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    store: FileStore;
    from: string;
    to: string;
    clearance: Clearance;
    now: number;
  },
): Promise<MoveResult | null> {
  const { workspaceId, store, from, to, clearance, now } = args;
  if (!storeCanQueue(store)) return null;
  const reserved = await ctx.runMutation(internal.functions.nodeMoves.reserve, {
    workspaceId,
    from,
    to,
    scope: clearance.scope,
    grantedNames: [...clearance.names],
    now,
  });
  if (!reserved.ok) {
    if (reserved.reason === "reserved") {
      throw new FileOpError("CONFLICT", "Something there is still moving. Try again once it has finished.");
    }
    return null;
  }
  let drawn = false;
  try {
    const moves = reserved.moves;
    const source = await inventory(ctx, workspaceId, from, moves);
    // A single note, or nothing: `movePath` answers both the way it always has.
    if (!source.folder) return null;

    const state = await loadPrivacyState(store);
    if (state.invalid) return null;
    if (!canSee(from, clearance.scope, state.rules, state.overrides, clearance.names)) throw notFound();
    // Notes the caller cannot see stay where they are: the old way does that.
    const hidden = source.files.some((key) => !canSee(key, clearance.scope, state.rules, state.overrides, clearance.names));
    if (hidden) return null;

    const there = await inventory(ctx, workspaceId, to, moves, true);
    if (there.folder) {
      if (!folderVisibleAtScope(to, clearance, state.rules, state.overrides)) throw notFound();
      throw new FileOpError("DESTINATION_EXISTS", "That folder already exists. Moving one folder onto another would merge them.");
    }
    if (there.file) {
      if (!canSee(to, clearance.scope, state.rules, state.overrides, clearance.names)) throw notFound();
      throw new FileOpError("DESTINATION_EXISTS", `Something already exists at ${to}.`);
    }
    assertMoveDestinationsVisible(
      source.files.map((key) => ({ source: key, destination: `${to}${key.slice(from.length)}` })),
      clearance,
      state,
    );

    const carried = await carryPrivacy(store, from, to);
    if (carried === null) return null;
    await touchNodesNow(ctx, workspaceId, store, { paths: [], files: [PRIVACY_KEY] });
    drawn = await ctx.runMutation(internal.functions.nodeMoves.activate, {
      id: reserved.id,
      kind: "folder",
      total: source.files.length,
      added: carried.added,
      privacyEtag: carried.etag,
      now,
    });
    if (!drawn) {
      // Nothing moved: take the carried rules back and let the old way carry them.
      await releasePrivacy(store, { from: to, undone: true, added: carried.added }).catch(() => {});
      await touchNodesNow(ctx, workspaceId, store, { paths: [], files: [PRIVACY_KEY] });
      return null;
    }
    await recordForwarding(store, [{ from, to, kind: "folder" as const }], { now });
    await remapFolderIcons(store, from, to);
    return { from, to, paths: [to], queued: source.files.length };
  } finally {
    if (!drawn) await ctx.runMutation(internal.functions.nodeMoves.release, { id: reserved.id }).catch(() => {});
  }
}
