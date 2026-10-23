/**
 * The gateway's agent tools read the Convex tree (phase 5 of
 * `docs/decisions/app-and-console/convex-tree.md`).
 *
 * `list_notes`, `orient`'s map and counts, `list_contacts`, `list_meetings`,
 * `list_channel_days` and `evaluate_lists` each walked the bucket, page by
 * page, on every call. Where the tree serves a workspace, the gateway asks
 * `/gateway/tree/manifest` for the same keys instead, a page at a time.
 *
 * Three rules hold it, the same three phase 2 holds the app to:
 *
 * - **Who may ask is the grant's, never the gateway's say.** The gateway
 *   secret gets the request through the door; the person's access token is
 *   spent here, the workspace is chosen only from that grant's own set, and
 *   the clearance is the gateway's own `visibilityTierForGrant` rule read off
 *   the grant (`private` only for an owner whose grant asked for it). No
 *   field of the request names a scope.
 * - **Privacy is not reimplemented.** The rows and the rules mirror are
 *   handed to the unchanged `syncManifest` through `servedNodesStore`, so
 *   `canSee` decides what comes back, as it decides the sidebar's listings.
 *   The gateway filters again with its own engine; this only narrows.
 * - **The tree answers once its `nodeTrees` row is `ready`** (`treeServes`).
 *   An unknown token, a malformed request, a workspace not yet served, a walk
 *   that could not finish and a rules file that would not parse are all
 *   `{ served: false }`, the same bytes.
 *
 * No bucket is opened here: the store under the rows refuses every read but
 * the two `servedNodesStore` answers itself, so a manifest page never spends
 * the workspace's storage credential.
 */

import type { ObjectType } from "convex/values";
import { v } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx, QueryCtx } from "../../../_generated/server";
import { NO_NAMES, clearanceOf } from "../clearance";
import { audienceOfNames } from "../pinnedReaders";
import type { Audience } from "./rowAccess";
import { contextsForGrant, resolveLiveGrant } from "../controlPlane/liveGrants";
import { TOKEN_HASH_PATTERN, hashToken } from "../crypto";
import { json } from "../gatewayAuth";
import { syncManifest } from "../fileOps/syncManifest";
import { NO_BUCKET, servedNodesStore } from "./manifestStore";

/**
 * Keys one answer carries. The console's walk stops at `MANIFEST_PAGE_ENTRIES`
 * because its pages cross a Convex function boundary, which refuses an array
 * past 8,192 elements; this page leaves as an HTTP body, so it can hold most
 * workspaces whole, and an agent's listing costs the gateway one request. Ten
 * thousand names stay inside the gateway's cap on a tree answer
 * (`TREE_RESPONSE_BYTE_CAP`, `apps/mcp/src/controlPlane/tree.js`) even at the
 * longest path a request may name.
 */
export const GATEWAY_PAGE_ENTRIES = 10_000;

/** Paths in one request field: a folder or a cursor is one path, never more. */
export const GATEWAY_PATH_LENGTH = 1024;

export interface GatewayReader {
  scopes: string[];
  workspaces: Array<{ workspaceId: Id<"workspaces">; role: string; grantedNames?: string[] }>;
}

/**
 * The workspace and tier a grant reads at, or null where it may not read.
 *
 * `expectedWorkspaceId` only selects within the grant's own set. The tier is
 * the gateway's `visibilityTierForGrant` (`apps/mcp/src/session.js`): an
 * owner whose grant carries `context:private` reads privately, and everybody
 * else reads as the team. A grant without `context:read` reads nothing.
 *
 * `names` are a pin reader's guest names (`lib/pinnedReaders.ts`), as `contextsForGrant` carries them, and none
 * for anybody else, as before. Every route that judges by this clearance passes
 * them on, or a pin reader would be judged as a member of the team; `audience` says which rules they are judged by.
 */
export function gatewayReadClearance(
  reader: GatewayReader,
  expectedWorkspaceId: string,
): { workspaceId: Id<"workspaces">; scope: "private" | "team"; names: string[]; audience: Audience } | null {
  if (!reader.scopes.includes("context:read")) return null;
  const covered = reader.workspaces.find((entry) => entry.workspaceId === expectedWorkspaceId);
  if (covered === undefined) return null;
  const scope = covered.role === "owner" && reader.scopes.includes("context:private") ? "private" : "team";
  const audience = audienceOfNames(covered.grantedNames);
  // Only a guest's names: these routes judged every other reader with none, and still do.
  return { workspaceId: covered.workspaceId, scope, names: audience === "guest" ? (covered.grantedNames ?? []) : [], audience };
}

export const readClearanceArgs = { hashedAccessToken: v.string(), expectedWorkspaceId: v.string() };

export const readClearanceReturns = v.union(
  v.null(),
  v.object({
    workspaceId: v.id("workspaces"),
    scope: v.union(v.literal("private"), v.literal("team")),
    names: v.array(v.string()),
    audience: v.union(v.literal("member"), v.literal("guest")),
  }),
);

export async function readClearanceHandler(ctx: QueryCtx, args: ObjectType<typeof readClearanceArgs>) {
  if (!TOKEN_HASH_PATTERN.test(args.hashedAccessToken)) return null;
  const live = await resolveLiveGrant(ctx, args.hashedAccessToken);
  if (live === null) return null;
  return gatewayReadClearance(
    { scopes: live.grant.scopes, workspaces: await contextsForGrant(ctx, live) },
    args.expectedWorkspaceId,
  );
}

/** One key the caller may see, as the gateway lists it: a name and a version, never text. */
export interface GatewayManifestEntry {
  path: string;
  etag?: string;
  size?: number;
  updatedAt?: number;
  /** The note's id (`lib/nodes/noteIds.ts`), for a row that has one. A gateway search resolves its hits through it. */
  noteId?: string;
}

export type GatewayManifestPage =
  | { served: true; entries: GatewayManifestEntry[]; cursor: string | null }
  | { served: false };

const NOT_SERVED: GatewayManifestPage = { served: false };

/**
 * One page of the keys `scope` may see in `workspaceId`, from the tree, or
 * `served: false`. `folder` narrows it to one subtree, as a folder List does.
 */
export async function gatewayManifestPage(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  scope: "private" | "team",
  options: { cursor?: string; folder?: string; names?: readonly string[] },
): Promise<GatewayManifestPage> {
  const names = options.names ?? [];
  const store = await servedNodesStore(ctx, workspaceId, NO_BUCKET, audienceOfNames(names));
  if (store === null) return NOT_SERVED;
  const manifest = await syncManifest(store, {
    clearance: names.length === 0 ? { scope, names: NO_NAMES } : clearanceOf(scope, names),
    pageEntries: GATEWAY_PAGE_ENTRIES,
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    ...(options.folder === undefined ? {} : { folder: options.folder }),
  });
  // A walk that stopped short, or rules that do not parse, is not a listing
  // anyone may be answered from: the bucket answers it, as it does today.
  if (manifest.truncated || !manifest.manifestUsable) return NOT_SERVED;
  return {
    served: true,
    entries: manifest.entries.map((entry) => ({
      path: entry.path,
      ...(entry.etag === undefined ? {} : { etag: entry.etag }),
      ...(entry.size === undefined ? {} : { size: entry.size }),
      ...(entry.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt }),
      ...(entry.noteId === undefined ? {} : { noteId: entry.noteId }),
    })),
    cursor: manifest.cursor,
  };
}

/** A request field that is absent, or one path. Anything else is malformed. */
function pathField(body: Record<string, unknown>, key: string): { ok: true; value?: string } | { ok: false } {
  const value = body[key];
  if (value === undefined || value === null) return { ok: true };
  if (typeof value === "string" && value.length <= GATEWAY_PATH_LENGTH) return { ok: true, value };
  return { ok: false };
}

/**
 * `POST /gateway/tree/manifest`. Every refusal is `{ served: false }`, the
 * bytes a workspace the tree does not serve gets, so the route says nothing
 * about which tokens are live or which contexts exist.
 */
export async function gatewayTreeManifestHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  return json(await manifestFor(ctx, body));
}

async function manifestFor(ctx: ActionCtx, body: Record<string, unknown>): Promise<GatewayManifestPage> {
  const accessToken = typeof body.accessToken === "string" && body.accessToken !== "" ? body.accessToken : null;
  const expected = typeof body.expectedWorkspaceId === "string" ? body.expectedWorkspaceId : null;
  const cursor = pathField(body, "cursor");
  const folder = pathField(body, "folder");
  if (accessToken === null || expected === null || !cursor.ok || !folder.ok) return NOT_SERVED;
  try {
    const reader = await ctx.runQuery(internal.functions.nodesGateway.readClearance, {
      hashedAccessToken: await hashToken(accessToken),
      expectedWorkspaceId: expected,
    });
    if (reader === null) return NOT_SERVED;
    return await gatewayManifestPage(ctx, reader.workspaceId, reader.scope, {
      names: reader.names,
      ...(cursor.value === undefined || cursor.value === "" ? {} : { cursor: cursor.value }),
      ...(folder.value === undefined ? {} : { folder: folder.value }),
    });
  } catch {
    // A path the manifest refuses, a page that failed: the bucket answers.
    return NOT_SERVED;
  }
}
