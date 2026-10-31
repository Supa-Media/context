/**
 * The gateway's doors to the id copy and to keyed rows (`functions/noteIds.ts`,
 * `functions/noteIdsKeyed.ts`), registered in `http.ts` through the same
 * `gatewayRoute` factory as every gateway route, so the gateway secret is
 * checked before any handler runs.
 *
 * - `POST /gateway/note-ids/lookup` `{ accessToken, workspaceId, paths }`: answers
 *   `{ copies, keyed, notes }`. `copies` is for each path the reader may see, the
 *   id key its body is copied to, the etag the copy was made from, and whether
 *   that copy is still true (what an older gateway reads). `notes` is for each
 *   path with a row, the reader's view unfiltered (a keyed write resolves the
 *   note whoever reads it: `lib/noteIds/keyed.ts`). `keyed` says whether the
 *   workspace is keyed.
 * - `POST /gateway/note-ids/resolve` `{ accessToken, workspaceId, noteIds }`: answers
 *   `{ paths }`, the path each note id's live row sits at now, or `null` (see
 *   `gatewayNoteIdsResolveHandler`).
 * - `POST /gateway/note-ids/wrote` `{ accessToken, workspaceId, path, key, etag }`:
 *   the gateway wrote the same bytes to the path and to its id key. Records the
 *   copy only when the key is the row's own id key (`recordCopy`), answering
 *   `{ ok: true, recorded }`. With `keyed: true` (plus `at`, and `size` when
 *   known) the write was to a keyed note's key, and is recorded there
 *   (`recordKeyed`).
 * - `POST /gateway/note-ids/adopt` `{ accessToken, workspaceId, path, noteId, key,
 *   etag, at, size? }`: a note the gateway created at its own key gets its row
 *   (`adoptKeyed`), answering `{ ok: true, adopted, taken }`.
 * - `POST /gateway/note-ids/removed` `{ accessToken, workspaceId, path, key, at }`:
 *   a keyed note was removed; its row is retired (`removeKeyed`), answering
 *   `{ ok: true, removed }`.
 *
 * The access token is read the way `/gateway/tree/facts` reads it: the reader's
 * clearance comes off the grant the token resolves to, and `workspaceId` is
 * checked against that grant's own set, never used to pick a row. Lookup needs
 * a read grant; the writes need a grant with write scope. The keyed writes
 * accept any live member (members write form answers, and the gateway has
 * already decided the write); an unkeyed copy record stays owner-or-editor. A
 * refusal is `{ served: false }`, the same bytes for a workspace that is not the
 * caller's as for one that does not exist. A malformed body is a 400.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { clearanceOf } from "../clearance";
import { loadPrivacyState } from "../fileOps";
import { hashToken } from "../crypto";
import { badRequest, json, stringField } from "../gatewayAuth";
import { memberWritableWorkspace, writableWorkspace } from "../nodes/gatewayNames";
import { GATEWAY_PATH_LENGTH } from "../nodes/gatewayManifest";
import { isNoteId } from "../nodes/noteIds";
import { NO_BUCKET, servedNodesStore } from "../nodes/manifestStore";
import { canSee } from "../privacy";

const NOT_SERVED = { served: false } as const;

/** Paths one lookup may name. */
export const NOTE_IDS_LOOKUP_PATHS = 200;

/** A non-empty list of at most `NOTE_IDS_LOOKUP_PATHS` paths, each one path; `null` for anything else. */
export function pathList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > NOTE_IDS_LOOKUP_PATHS) return null;
  if (!value.every((entry) => typeof entry === "string" && entry !== "" && entry.length <= GATEWAY_PATH_LENGTH)) return null;
  return value as string[];
}

/**
 * A number field: its value, `undefined` when absent, and `null` when present
 * but not a finite number (a malformed body).
 */
export function numberField(body: Record<string, unknown>, key: string): number | undefined | null {
  const value = body[key];
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The time a keyed write carries: required, and a finite number. */
export function timeField(body: Record<string, unknown>): number | null {
  const at = numberField(body, "at");
  return typeof at === "number" ? at : null;
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
    // A pin reader is judged by a guest's rules and names (`lib/pinnedReaders.ts`).
    const served = await servedNodesStore(ctx, reader.workspaceId, NO_BUCKET, reader.audience);
    if (served === null) return json(NOT_SERVED);
    const state = await loadPrivacyState(served);
    if (state.invalid) return json(NOT_SERVED);
    // A path the reader may not see is answered as a path with no row in `copies`: its copy is not named to them.
    const distinct = [...new Set(paths)];
    const seen = distinct.filter((path) => canSee(path, reader.scope, state.rules, state.overrides, clearanceOf(reader.scope, reader.names).names));
    const found =
      seen.length === 0 ? [] : await ctx.runQuery(internal.functions.noteIds.copiesFor, { workspaceId: reader.workspaceId, paths: seen });
    const noted = await ctx.runQuery(internal.functions.noteIdsKeyed.notesFor, { workspaceId: reader.workspaceId, paths: distinct });
    // Object.fromEntries, not an assignment per path: a path named `__proto__` stays a key.
    return json({
      copies: Object.fromEntries(found.map(({ path, key, etag, keyEtag, fresh }) => [path, { key, etag, keyEtag, fresh }])),
      keyed: noted.keyed,
      notes: Object.fromEntries(noted.notes.map((entry) => [entry.path, entry])),
      // Only for paths the reader may see, as `copies`.
      texHomes: Object.fromEntries(noted.texHomes.filter(({ path }) => seen.includes(path)).map(({ path, owner }) => [path, owner])),
    });
  } catch {
    return json(NOT_SERVED);
  }
}

export async function gatewayNoteIdsWroteHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const path = stringField(body, "path");
  const key = stringField(body, "key");
  const etag = stringField(body, "etag");
  const keyEtag = stringField(body, "keyEtag");
  if (path === null || path.length > GATEWAY_PATH_LENGTH || key === null || etag === null) return badRequest();
  const size = numberField(body, "size");
  if (body.keyed === true) return await keyedWrote(ctx, body, { path, key, etag, size: size ?? undefined });
  const accessToken = stringField(body, "accessToken");
  const workspaceId = stringField(body, "workspaceId");
  if (accessToken === null || workspaceId === null) return json(NOT_SERVED);
  try {
    // Recording a copy is a write's bookkeeping, so only a grant that may write this workspace asks for it.
    const writable = await writableWorkspace(ctx, accessToken, workspaceId);
    if (writable === null) return json(NOT_SERVED);
    const recorded = await ctx.runMutation(internal.functions.noteIds.recordCopy, {
      workspaceId: writable,
      path,
      key,
      etag,
      ...(keyEtag === null ? {} : { keyEtag }),
    });
    return json({ ok: true, recorded });
  } catch {
    return json(NOT_SERVED);
  }
}

/** A write the gateway made to a keyed note's key: the row takes its version, size and time. */
async function keyedWrote(
  ctx: ActionCtx,
  body: Record<string, unknown>,
  write: { path: string; key: string; etag: string; size: number | undefined },
): Promise<Response> {
  const at = timeField(body);
  if (at === null || numberField(body, "size") === null) return badRequest();
  const accessToken = stringField(body, "accessToken");
  const workspaceId = stringField(body, "workspaceId");
  if (accessToken === null || workspaceId === null) return json(NOT_SERVED);
  try {
    const writable = await memberWritableWorkspace(ctx, accessToken, workspaceId);
    if (writable === null) return json(NOT_SERVED);
    const recorded = await ctx.runMutation(internal.functions.noteIdsKeyed.recordKeyed, {
      workspaceId: writable,
      path: write.path,
      key: write.key,
      etag: write.etag,
      ...(write.size === undefined ? {} : { size: write.size }),
      at,
    });
    return json({ ok: true, recorded });
  } catch {
    return json(NOT_SERVED);
  }
}

export async function gatewayNoteIdsAdoptHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const path = stringField(body, "path");
  const noteId = stringField(body, "noteId");
  const key = stringField(body, "key");
  const etag = stringField(body, "etag");
  const size = numberField(body, "size");
  const at = timeField(body);
  if (
    path === null ||
    path.length > GATEWAY_PATH_LENGTH ||
    noteId === null ||
    key === null ||
    key.length > GATEWAY_PATH_LENGTH ||
    etag === null ||
    size === null ||
    at === null
  ) {
    return badRequest();
  }
  const accessToken = stringField(body, "accessToken");
  const workspaceId = stringField(body, "workspaceId");
  if (accessToken === null || workspaceId === null) return json(NOT_SERVED);
  try {
    const writable = await memberWritableWorkspace(ctx, accessToken, workspaceId);
    if (writable === null) return json(NOT_SERVED);
    const answer = await ctx.runMutation(internal.functions.noteIdsKeyed.adoptKeyed, {
      workspaceId: writable,
      path,
      noteId,
      key,
      etag,
      ...(size === undefined ? {} : { size }),
      at,
    });
    if (answer.adopted) return json({ ok: true, adopted: true, taken: null });
    return json({ ok: true, adopted: false, taken: answer.taken ?? null });
  } catch {
    return json(NOT_SERVED);
  }
}

export async function gatewayNoteIdsRemovedHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const path = stringField(body, "path");
  const key = stringField(body, "key");
  const at = timeField(body);
  if (path === null || path.length > GATEWAY_PATH_LENGTH || key === null || key.length > GATEWAY_PATH_LENGTH || at === null) {
    return badRequest();
  }
  const accessToken = stringField(body, "accessToken");
  const workspaceId = stringField(body, "workspaceId");
  if (accessToken === null || workspaceId === null) return json(NOT_SERVED);
  try {
    const writable = await memberWritableWorkspace(ctx, accessToken, workspaceId);
    if (writable === null) return json(NOT_SERVED);
    const removed = await ctx.runMutation(internal.functions.noteIdsKeyed.removeKeyed, { workspaceId: writable, path, key, at });
    return json({ ok: true, removed });
  } catch {
    return json(NOT_SERVED);
  }
}

/** Note ids one resolve may name: the same bound as a lookup's paths. */
export const NOTE_IDS_RESOLVE_IDS = 200;

/**
 * A non-empty list of at most `NOTE_IDS_RESOLVE_IDS` note ids (lowercase
 * UUIDv7s), with repeats collapsed; `null` for anything else.
 */
export function noteIdList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > NOTE_IDS_RESOLVE_IDS) return null;
  if (!value.every((entry) => isNoteId(entry))) return null;
  return [...new Set(value as string[])];
}

/**
 * `POST /gateway/note-ids/resolve` `{ accessToken, workspaceId, noteIds }`:
 * answers `{ paths }`, which maps each id asked for to the path its live row
 * sits at now, or `null` where no live row of this workspace holds it or the
 * reader may not see that path (`canSee`, as `copies` filters). The reader's
 * workspace is the grant's own, as for lookup; an id held by another workspace
 * is `null` here.
 */
export async function gatewayNoteIdsResolveHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const noteIds = noteIdList(body.noteIds);
  if (noteIds === null) return badRequest();
  const accessToken = stringField(body, "accessToken");
  const workspaceId = stringField(body, "workspaceId");
  if (accessToken === null || workspaceId === null) return json(NOT_SERVED);
  try {
    const reader = await ctx.runQuery(internal.functions.nodesGateway.readClearance, {
      hashedAccessToken: await hashToken(accessToken),
      expectedWorkspaceId: workspaceId,
    });
    if (reader === null) return json(NOT_SERVED);
    // A pin reader is judged by a guest's rules and names (`lib/pinnedReaders.ts`).
    const served = await servedNodesStore(ctx, reader.workspaceId, NO_BUCKET, reader.audience);
    if (served === null) return json(NOT_SERVED);
    const state = await loadPrivacyState(served);
    if (state.invalid) return json(NOT_SERVED);
    const found = await ctx.runQuery(internal.functions.noteIds.pathsForNoteIds, {
      workspaceId: reader.workspaceId,
      noteIds,
    });
    // Every id asked for is answered; an id with no visible row answers null.
    const paths: Record<string, string | null> = Object.fromEntries(noteIds.map((noteId) => [noteId, null]));
    for (const { noteId, path } of found) {
      if (canSee(path, reader.scope, state.rules, state.overrides, clearanceOf(reader.scope, reader.names).names)) paths[noteId] = path;
    }
    return json({ paths });
  } catch {
    return json(NOT_SERVED);
  }
}
