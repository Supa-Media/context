/**
 * The address of a note or folder an outsider was granted, in @shared.
 *
 * `?grant=<workspaceId>.<noteId>` names a granted row by its stable note id, the
 * way `shares.readGrantedNote` and `shares.listGrantedFolder` take it. A note
 * reached from a granted folder's listing names its path instead:
 * `?grant=<workspaceId>.<path>&by=path`. `&kind=folder` says the row is a folder.
 *
 * It is a different parameter from `?note=`, which carries a share token, so
 * the two are never confused. Pure, so the address is testable without the
 * router: the router hands back decoded values, one per key, and `parseGrant`
 * takes exactly that.
 */

/** The parameter a granted row's address lives in. */
export const GRANT_PARAM = "grant";

export type GrantRef = { by: "id"; noteId: string } | { by: "path"; path: string };

/** A granted row the reader has asked to open, as the address names it. */
export interface GrantTarget {
  workspaceId: string;
  ref: GrantRef;
  folder: boolean;
}

/** A workspace id is letters, digits and the two separators an id uses; never a dot or a slash. */
const WORKSPACE_ID = /^[A-Za-z0-9_-]+$/;

/** The first value of a parameter the router may give as a list. */
export function firstOf(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The value of `?grant=`: the workspace, a dot, then the note id or the path. */
function grantValue(target: GrantTarget): string {
  const ref = target.ref.by === "id" ? target.ref.noteId : target.ref.path;
  return `${target.workspaceId}.${ref}`;
}

/**
 * The query string that opens a granted row: `?grant=…`, with `&by=path` and
 * `&kind=folder` where they apply. Every value is percent-encoded, so a path
 * with `&`, `?` or spaces comes back whole.
 */
export function grantQuery(target: GrantTarget): string {
  const parts = [`${GRANT_PARAM}=${encodeURIComponent(grantValue(target))}`];
  if (target.ref.by === "path") parts.push("by=path");
  if (target.folder) parts.push("kind=folder");
  return `?${parts.join("&")}`;
}

/**
 * The address's grant, or `null` for any address that does not name one.
 *
 * `null` is the answer for a missing value, a value with no workspace or no
 * reference, a workspace that is not an id, and an unknown `by` or `kind`. The
 * caller shows the list, as it does for any address it cannot read.
 */
export function parseGrant(params: Record<string, unknown>): GrantTarget | null {
  const value = firstOf(params.grant as string | string[] | undefined);
  if (typeof value !== "string" || value === "") return null;
  const dot = value.indexOf(".");
  if (dot <= 0) return null;
  const workspaceId = value.slice(0, dot);
  const reference = value.slice(dot + 1);
  if (!WORKSPACE_ID.test(workspaceId) || reference === "") return null;

  const by = firstOf(params.by as string | string[] | undefined);
  const kind = firstOf(params.kind as string | string[] | undefined);
  if (by !== undefined && by !== "path") return null;
  if (kind !== undefined && kind !== "folder") return null;

  const ref: GrantRef = by === "path" ? { by: "path", path: reference } : { by: "id", noteId: reference };
  return { workspaceId, ref, folder: kind === "folder" };
}

/**
 * The key a grant item is listed and selected under: its workspace and note id.
 * A share's key is its token, so the two never collide.
 */
export function grantItemKey(workspaceId: string, noteId: string): string {
  return `grant:${workspaceId}.${noteId}`;
}

/** The key of the row an address has open, or `null` when it names a path rather than a listed item. */
export function openKeyOf(target: GrantTarget): string | null {
  return target.ref.by === "id" ? grantItemKey(target.workspaceId, target.ref.noteId) : null;
}
