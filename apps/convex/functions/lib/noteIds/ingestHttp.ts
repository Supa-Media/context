/**
 * The email worker's doors to the id layer, for a keyed workspace: the same
 * answers as the gateway's `/gateway/note-ids/*` routes (`./http.ts`), reached by
 * the ticket a capture was minted with rather than by a grant.
 *
 * A capture (`infra/email-worker/src/index.ts`) reads, writes and adopts only
 * under the inbox folder its ticket opened, and never removes a note: there is
 * no `removed` route for mail. The ticket names the workspace, so no body field
 * can select one, and it is checked by `ticketInbox`, which needs the credential
 * route to have been spent on it first.
 *
 * - `lookup` `{ ticket, paths }` -> `{ copies, keyed, notes }`
 * - `wrote` `{ ticket, path, key, etag, keyed: true, at, size? }` -> `{ ok, recorded }`
 * - `adopt` `{ ticket, path, noteId, key, etag, at, size? }` -> `{ ok, adopted, taken }`
 *
 * Every refusal is `{ served: false }`, the same bytes for an unknown ticket as
 * for a path outside the inbox. A malformed body is a 400. Registered in
 * `http.ts` through `emailWorkerRoute`, which checks the email worker's secret
 * before any of these run.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { badRequest, json, stringField } from "../gatewayAuth";
import { GATEWAY_PATH_LENGTH } from "../nodes/gatewayManifest";
import { isPlumbing } from "../privacy";
import { numberField, pathList, timeField } from "./http";

const NOT_SERVED = { served: false } as const;

/**
 * Whether `path` is one a mail capture may write: under the inbox `folder`
 * (`0-inbox/`, as the ticket recorded it), with every segment a plain name, and
 * not plumbing. The folder is the bound ingest itself uses to decide where mail
 * lands (`infra/email-worker/src/ingest.ts`, `key = ${targetFolder}email/...`).
 */
export function isInboxPath(folder: string, path: string): boolean {
  if (!folder.endsWith("/") || !path.startsWith(folder) || path.length > GATEWAY_PATH_LENGTH) return false;
  const folderSegments = folder.slice(0, -1).split("/");
  if (folderSegments.some((segment) => segment === "" || segment.startsWith("."))) return false;
  const rest = path.slice(folder.length);
  if (rest === "" || isPlumbing(path)) return false;
  return rest.split("/").every((segment) => segment !== "" && !segment.startsWith("."));
}

/** The workspace and inbox a live ticket opens, or `null` for any ticket that does not. */
async function inboxFor(ctx: ActionCtx, body: Record<string, unknown>) {
  const ticket = stringField(body, "ticket");
  if (ticket === null) return null;
  return await ctx.runQuery(internal.functions.ingestionGateway.ticketInbox, { hashedTicket: await hashToken(ticket) });
}

export async function ingestNoteIdsLookupHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const paths = pathList(body.paths);
  if (paths === null) return badRequest();
  const inbox = await inboxFor(ctx, body);
  if (inbox === null || !paths.every((path) => isInboxPath(inbox.targetFolder, path))) return json(NOT_SERVED);
  try {
    const distinct = [...new Set(paths)];
    const found = await ctx.runQuery(internal.functions.noteIds.copiesFor, { workspaceId: inbox.workspaceId, paths: distinct });
    // The owner's own capture: the whole tree is visible to it, so no clearance filter applies.
    const noted = await ctx.runQuery(internal.functions.noteIdsKeyed.notesFor, { workspaceId: inbox.workspaceId, paths: distinct });
    return json({
      copies: Object.fromEntries(found.map(({ path, key, etag, keyEtag, fresh }) => [path, { key, etag, keyEtag, fresh }])),
      keyed: noted.keyed,
      notes: Object.fromEntries(noted.notes.map((entry) => [entry.path, entry])),
    });
  } catch {
    return json(NOT_SERVED);
  }
}

export async function ingestNoteIdsWroteHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const path = stringField(body, "path");
  const key = stringField(body, "key");
  const etag = stringField(body, "etag");
  const size = numberField(body, "size");
  const at = timeField(body);
  if (path === null || path.length > GATEWAY_PATH_LENGTH || key === null || etag === null || size === null || at === null) {
    return badRequest();
  }
  const inbox = await inboxFor(ctx, body);
  if (inbox === null || !isInboxPath(inbox.targetFolder, path)) return json(NOT_SERVED);
  // Mail only ever writes a keyed note. A copy record means nothing for a capture, so the control plane keeps none.
  if (body.keyed !== true) return json({ ok: true, recorded: false });
  try {
    const recorded = await ctx.runMutation(internal.functions.noteIdsKeyed.recordKeyed, {
      workspaceId: inbox.workspaceId,
      path,
      key,
      etag,
      ...(size === undefined ? {} : { size }),
      at,
    });
    return json({ ok: true, recorded });
  } catch {
    return json(NOT_SERVED);
  }
}

export async function ingestNoteIdsAdoptHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
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
  const inbox = await inboxFor(ctx, body);
  if (inbox === null || !isInboxPath(inbox.targetFolder, path)) return json(NOT_SERVED);
  try {
    const answer = await ctx.runMutation(internal.functions.noteIdsKeyed.adoptKeyed, {
      workspaceId: inbox.workspaceId,
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
