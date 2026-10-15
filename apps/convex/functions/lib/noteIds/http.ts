/**
 * The gateway's two doors to the id copy (`functions/noteIds.ts`), registered
 * in `http.ts` through the same `gatewayRoute` factory as every gateway route,
 * so the gateway secret is checked before either handler runs.
 *
 * - `POST /gateway/note-ids/lookup` `{ accessToken, workspaceId, paths }`: for
 *   each path the reader may see, the id key the note's body is copied to, the
 *   etag its copy was made from, and whether that copy is still true. Answers
 *   `{ copies }`; a path with no live file or no id is left out.
 * - `POST /gateway/note-ids/wrote` `{ accessToken, workspaceId, path, key, etag }`:
 *   the gateway wrote the same bytes to the path and to its id key. Records the
 *   copy only when the key is the row's own id key (`recordCopy`), and answers
 *   `{ ok: true, recorded }`.
 *
 * The access token is read the way `/gateway/tree/facts` reads it: the reader's
 * clearance comes off the grant the token resolves to, and `workspaceId` is
 * checked against that grant's own set, never used to pick a row. A refusal is
 * `{ served: false }`, the same bytes for a workspace that is not the caller's
 * as for one that does not exist. A malformed body is a 400.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { NO_NAMES } from "../clearance";
import { loadPrivacyState } from "../fileOps";
import { hashToken } from "../crypto";
import { badRequest, json, stringField } from "../gatewayAuth";
import { writableWorkspace } from "../nodes/gatewayNames";
import { GATEWAY_PATH_LENGTH, NO_BUCKET } from "../nodes/gatewayManifest";
import { servedNodesStore } from "../nodes/manifestStore";
import { canSee } from "../privacy";

const NOT_SERVED = { served: false } as const;

/** Paths one lookup may name. */
export const NOTE_IDS_LOOKUP_PATHS = 200;

/** A non-empty list of at most `NOTE_IDS_LOOKUP_PATHS` paths, each one path; `null` for anything else. */
function pathList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > NOTE_IDS_LOOKUP_PATHS) return null;
  if (!value.every((entry) => typeof entry === "string" && entry !== "" && entry.length <= GATEWAY_PATH_LENGTH)) return null;
  return value as string[];
}

export async function gatewayNoteIdsLookupHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const paths = pathList(body.paths);
  if (paths === null) return badRequest();
  const accessToken = stringField(body, "accessToken");
  const workspaceId = stringField(body, "workspaceId");
  if (accessToken === null || workspaceId === null) return json(NOT_SERVED);
  try {
    const reader = await ctx.runQuery(internal.functions.nodesGateway.readClearance, {
      hashedAccessToken: await hashToken(accessToken),
      expectedWorkspaceId: workspaceId,
    });
    if (reader === null) return json(NOT_SERVED);
    const served = await servedNodesStore(ctx, reader.workspaceId, NO_BUCKET);
    if (served === null) return json(NOT_SERVED);
    const state = await loadPrivacyState(served);
    if (state.invalid) return json(NOT_SERVED);
    // A path the reader may not see is answered as a path with no row: its copy is not named to them.
    const seen = [...new Set(paths)].filter((path) => canSee(path, reader.scope, state.rules, state.overrides, NO_NAMES));
    const found =
      seen.length === 0 ? [] : await ctx.runQuery(internal.functions.noteIds.copiesFor, { workspaceId: reader.workspaceId, paths: seen });
    // Object.fromEntries, not an assignment per path: a path named `__proto__` stays a key.
    return json({ copies: Object.fromEntries(found.map(({ path, key, etag, fresh }) => [path, { key, etag, fresh }])) });
  } catch {
    return json(NOT_SERVED);
  }
}

export async function gatewayNoteIdsWroteHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const path = stringField(body, "path");
  const key = stringField(body, "key");
  const etag = stringField(body, "etag");
  if (path === null || path.length > GATEWAY_PATH_LENGTH || key === null || etag === null) return badRequest();
  const accessToken = stringField(body, "accessToken");
  const workspaceId = stringField(body, "workspaceId");
  if (accessToken === null || workspaceId === null) return json(NOT_SERVED);
  try {
    // Recording a copy is a write's bookkeeping, so only a grant that may write this workspace asks for it.
    const writable = await writableWorkspace(ctx, accessToken, workspaceId);
    if (writable === null) return json(NOT_SERVED);
    const recorded = await ctx.runMutation(internal.functions.noteIds.recordCopy, { workspaceId: writable, path, key, etag });
    return json({ ok: true, recorded });
  } catch {
    return json(NOT_SERVED);
  }
}
