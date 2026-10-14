/**
 * `POST /gateway/privacy`: the gateway's half of the privacy authority
 * (phase 3, `functions/nodesPrivacy.ts`). The gateway's store writes
 * `privacy.md` through `apps/mcp/src/store/privacyAuthority.js`, and each of
 * that store's calls to the control plane arrives here.
 *
 * Both proofs, as `/gateway/binding`: the gateway secret (the factory) and the
 * person's access token, or, for a queued move, its job ticket while the job
 * holds its lease. The workspace is the grant's (or the job's), compared with the one
 * the gateway names and used only after it matches, so no request can change
 * the rules of a workspace its token does not reach. The rules themselves are
 * checked for shape and size; which rules a person may write is the privacy
 * code's decision, made in the gateway before it renders the file, exactly as
 * it is made before it writes the file to the bucket.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, nullableStringField, stringField } from "../gatewayAuth";

/** The grant scope that may change a workspace's notes, and so its rules. */
const SCOPE_WRITE = "context:write";

/** Rules one request may carry: far above any manifest we have, and a bound on a mutation. */
export const PRIVACY_ROUTE_RULES = 5_000;
const MAX_NAME = 1_024;

type FolderRule = { prefix: string; visibility: string };
type NoteRule = { path: string; visibility: string };

function rulesOf(body: Record<string, unknown>): { folders: FolderRule[]; notes: NoteRule[] } | null {
  const { folders, notes } = body;
  if (!Array.isArray(folders) || !Array.isArray(notes)) return null;
  if (folders.length > PRIVACY_ROUTE_RULES || notes.length > PRIVACY_ROUTE_RULES) return null;
  const text = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= MAX_NAME;
  const outFolders: FolderRule[] = [];
  for (const rule of folders) {
    if (!rule || typeof rule !== "object") return null;
    const { prefix, visibility } = rule as Record<string, unknown>;
    if (!text(prefix) || !text(visibility)) return null;
    outFolders.push({ prefix: prefix as string, visibility: visibility as string });
  }
  const outNotes: NoteRule[] = [];
  for (const rule of notes) {
    if (!rule || typeof rule !== "object") return null;
    const { path, visibility } = rule as Record<string, unknown>;
    if (!text(path) || !text(visibility)) return null;
    outNotes.push({ path: path as string, visibility: visibility as string });
  }
  return { folders: outFolders, notes: outNotes };
}

export async function gatewayPrivacyHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const refused = () => json({ ok: false });
  const accessToken = stringField(body, "accessToken");
  const ticket = stringField(body, "ticket");
  const expected = stringField(body, "expectedWorkspaceId");
  const op = stringField(body, "op");
  if ((accessToken === null) === (ticket === null) || expected === null || op === null) return refused();
  // The id the gateway named is compared, never looked up: it must be the one the proof reaches.
  let reached: string | undefined;
  if (accessToken !== null) {
    const session = await ctx.runQuery(internal.functions.controlPlane.resolveGrantByAccessToken, {
      hashedAccessToken: await hashToken(accessToken),
    });
    const entry = session?.workspaces.find((workspace) => workspace.workspaceId === expected);
    // Only a grant that may write the workspace ever writes its `privacy.md`
    // (a move carries its exceptions): the gateway decides which rules, and
    // this refuses everyone else, so a gateway bug is never a member
    // rewriting who sees what.
    const writes = entry !== undefined && (entry.role === "owner" || entry.role === "editor") &&
      (session?.scopes ?? []).includes(SCOPE_WRITE);
    reached = writes ? entry.workspaceId : undefined;
  } else {
    // A queued move holds a ticket, not a person's token: it counts while its lease does.
    const leased = await ctx.runQuery(internal.functions.nodesPrivacy.jobWorkspace, {
      hashedTicket: await hashToken(ticket as string),
    });
    reached = leased === expected ? leased : undefined;
  }
  if (reached === undefined) return refused();
  const workspaceId = reached as Id<"workspaces">;

  if (op === "owed") {
    await ctx.runMutation(internal.functions.nodesPrivacy.owed, { workspaceId });
    return json({ ok: true });
  }
  if (op === "exported") {
    const rendered = stringField(body, "rendered");
    const etag = nullableStringField(body, "etag");
    if (rendered === null || !etag.ok) return refused();
    await ctx.runMutation(internal.functions.nodesPrivacy.exported, { workspaceId, rendered, etag: etag.value });
    return json({ ok: true });
  }
  const rules = rulesOf(body);
  if (rules === null) return refused();
  if (op === "write") {
    const previous = nullableStringField(body, "expected");
    if (!previous.ok) return refused();
    const swapped = await ctx.runMutation(internal.functions.nodesPrivacy.write, {
      workspaceId,
      expected: previous.value,
      ...rules,
    });
    return json({ ok: true, swapped });
  }
  if (op === "written") {
    const previous = nullableStringField(body, "previous");
    const etag = stringField(body, "etag");
    if (!previous.ok || etag === null) return refused();
    await ctx.runMutation(internal.functions.nodesPrivacy.written, {
      workspaceId,
      previous: previous.value,
      etag,
      at: Date.now(),
      ...rules,
    });
    return json({ ok: true });
  }
  return refused();
}
