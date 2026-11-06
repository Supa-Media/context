/**
 * The control plane's tree reads, answered by the workspace object where the workspace's notes live there (home
 * `object`; `docs/decisions/storage-and-credentials/object-row-writes.md`, "Readers move off Convex's tables").
 *
 * `servedNodesStore` is the one store every console tree read pages (the file list, the walk, note and folder paths,
 * the map, a folder's notes, the chaos score, folder icons) and the gateway's manifest and facts. For such a
 * workspace it pages the object's live file rows (`ws.rows.files`, through the door) and judges them by the rules the
 * object holds for the reader's audience, so none of those reads opens `nodes`, `nodeAccess`, `nodeAccessState` or
 * `nodeTrees`. Privacy is still decided by the unchanged callers with `canSee`, over this mirror.
 *
 * It answers `null`, and the caller reads Convex's rows as before, where it cannot be the whole answer: the workspace
 * is not on its object, the gateway is unreachable from this deployment, a change Convex committed is still waiting in
 * the push's outbox (`workspaceObjectPush.waitingSince`, what a binding's `notesBehind` says), a chunked move is being drawn over Convex's
 * rows (`nodeRowMoves.drawn`, folded there and nowhere else), or the object is behind (a mark is open: a narrowing
 * Convex already took may not have landed, and Convex's rows are the newer). A page that finds the object behind
 * part way through a walk fails the walk rather than mix the two.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import type { FileStore } from "../fileOps/store";
import { consoleWorkspaceClient, type WorkspaceObjectClient } from "../workspaceObjects/door";
import { nodesPagedStore, type NodePage } from "./manifestStore";
import { rowsEtag } from "./readerRules";
import type { Audience } from "./rowAccess";
import type { NodeRow, PrivacyMirror } from "./table";

type HeldRules = { folders: { prefix: string; visibility: string }[]; notes: { path: string; visibility: string }[] };
type FilesAnswer = {
  served?: boolean;
  behind?: boolean;
  rows?: Array<{ path: string; etag: string | null; size: number | null; uploaded: number | null; noteId: string | null }>;
  cursor?: string | null;
  rules?: HeldRules | null;
};

/** Raised by a page that found the object behind after the walk began: the walk fails rather than mix two states. */
export class ObjectTreeBehind extends Error {
  constructor() {
    super("the workspace object fell behind during this read");
  }
}

/** The held rules as a reader's mirror, exactly as `readerRules.readerMirror` renders Convex's rows. */
export function mirrorOfHeld(held: HeldRules): PrivacyMirror {
  const folders = held.folders
    .map((rule) => ({ prefix: rule.prefix, visibility: rule.visibility }))
    .sort((a, b) => (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0));
  const notes = held.notes
    .map((rule) => ({ path: rule.path, visibility: rule.visibility }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { etag: rowsEtag(folders, notes), invalid: false, folders, notes, rows: true };
}

function wellFormed(answer: FilesAnswer | null | undefined): answer is Required<Pick<FilesAnswer, "rows" | "rules">> & FilesAnswer {
  return (
    answer?.served === true &&
    Array.isArray(answer.rows) &&
    answer.rules !== null &&
    typeof answer.rules === "object" &&
    Array.isArray(answer.rules.folders) &&
    Array.isArray(answer.rules.notes)
  );
}

function nodeRowOf(row: NonNullable<FilesAnswer["rows"]>[number]): NodeRow {
  return {
    path: row.path,
    ...(row.etag === null ? {} : { etag: row.etag }),
    ...(row.size === null ? {} : { size: row.size }),
    ...(row.uploaded === null ? {} : { uploaded: row.uploaded }),
    ...(row.noteId === null ? {} : { noteId: row.noteId }),
  } as NodeRow;
}

type Options = { client?: WorkspaceObjectClient | null };

/**
 * The object's client where it may answer this workspace's tree reads now, or `null` where Convex's rows must (see the
 * header). Its own answer can still say `behind`, which the caller treats the same way.
 */
export async function objectTreeClient(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  options: Options = {},
): Promise<WorkspaceObjectClient | null> {
  const home = await ctx.runQuery(internal.functions.workspaceObjectsRows.homeOf, { workspaceId }).catch(() => null);
  if (home !== "object") return null;
  const client = options.client !== undefined ? options.client : consoleWorkspaceClient(ctx, workspaceId, { caller: "tree" });
  if (client === null) return null;
  // A change Convex committed and the object has not taken yet (a public mutation cannot wait for its push): Convex's
  // rows are the newer until it lands, as every binding opened now says (`notesBehind`).
  if (await ctx.runQuery(internal.functions.workspaceObjectPush.waitingSince, { workspaceId, at: Number.MAX_SAFE_INTEGER })) return null;
  const moves = await ctx.runQuery(internal.functions.nodeRowMoves.drawn, { workspaceId });
  if (moves.length > 0) return null;
  return client;
}

/** The object's tree as a served store, or `null` where Convex's rows must answer (see the header). */
export async function objectServedStore(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  base: FileStore,
  audience: Audience = "member",
  options: Options = {},
): Promise<FileStore | null> {
  const client = await objectTreeClient(ctx, workspaceId, options);
  if (client === null) return null;
  let first: FilesAnswer;
  try {
    first = (await client.rows.files({ limit: 1, audience })) as FilesAnswer;
  } catch {
    return null;
  }
  if (first?.behind === true || !wellFormed(first)) return null;
  const mirror = mirrorOfHeld(first.rules as HeldRules);
  const page: NodePage = async (after, limit, root) => {
    const answer = (await client.rows.files({
      limit,
      audience,
      ...(after === undefined ? {} : { after }),
      ...(root === undefined ? {} : { root }),
    })) as FilesAnswer;
    if (answer?.behind === true || !wellFormed(answer)) throw new ObjectTreeBehind();
    return { rows: answer.rows.map(nodeRowOf), cursor: answer.cursor ?? null };
  };
  return nodesPagedStore(base, page, mirror, []);
}

/**
 * One folder's listing from the object (`ws.rows.listing`) at the clearance the barrier resolved, as the live tree
 * socket draws it (`apps/convex/__tests__/workspaceObjectListing.test.ts` proves the two listings equal), or `null`
 * where Convex's rows must answer.
 */
export async function objectFolderListing(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  request: { path: string; scope: "private" | "team"; grantedNames: readonly string[]; audience: Audience },
  options: Options = {},
): Promise<Record<string, unknown> | null> {
  const client = await objectTreeClient(ctx, workspaceId, options);
  if (client === null) return null;
  let answer: { served?: boolean; behind?: boolean; listing?: Record<string, unknown> };
  try {
    answer = (await client.rows.listing({ path: request.path, scope: request.scope, groups: [...request.grantedNames], audience: request.audience })) as typeof answer;
  } catch {
    return null;
  }
  if (answer?.served !== true || answer.behind === true || answer.listing === null || typeof answer.listing !== "object") return null;
  return answer.listing;
}
