/**
 * What an outsider reaches: an account that is not a member of a workspace, but
 * that a row's access list names, by account or by a confirmed address.
 *
 * ## The rule, in one line
 *
 * A path is open to an outsider exactly when the **guest** rendering of the
 * workspace's **live** access rows says so, for the names the outsider holds
 * there (`canSee` at `team` scope with those names). Nothing else decides it.
 *
 * ## Why the candidate row is not the authority
 *
 * `nodeAccess` is found through two global indexes (`by_grantee_user`,
 * `by_grantee_email`), which are how an account finds its grants across every
 * workspace. A candidate is only a candidate. Its workspace's rows are read
 * again (`accessRowsOf`), the names are derived from those rows
 * (`accessNamesFor`), and the node has to be live. A grant row the rows no longer
 * name — a removed grant, a snapshot that has moved on, an address two accounts
 * now hold — grants nothing, however the row itself looks.
 *
 * ## Why the guest rendering, not the member one
 *
 * `renderAccess(rows, "member")` lets a `team` row reach every member, and the
 * outsider is not one. `renderAccess(rows, "guest")` never shows `team`: a row
 * with no list is `private` to an outsider, and a listed row is its token. So
 * the same `canSee` the engine runs decides for an outsider exactly what it
 * decides for everybody else, with the outsider's own rendering of the rows.
 *
 * ## What is not here
 *
 * Members never take this path: their reach is `grantedNamesFor`, unchanged.
 *
 * ## Edit
 *
 * An outsider may write a note's body when the row that governs it
 * (`governingRowOf`, the walk `canSee` makes) names them with `edit`, the same
 * rule a member's edit grant follows (`lib/filesFns/memberWrite.ts`). Only a
 * body write over a version they read: never a create, a move, a rename or a
 * form block. `canEdit` on a `GrantedNode` is that answer; the write itself is
 * `writeGrantedNote` in `lib/shares/grantedRead.ts`.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { clearanceOf } from "../clearance";
import { normalizePath } from "../fileOps";
import { accessSourceOf } from "../nodes/accessBackfill";
import { isCanonicalPath } from "../filesFns/memberWrite";
import { accessRowsOf } from "../nodes/accessRows";
import { governingRowOf } from "../nodes/governingRow";
import { accessNamesFor, editNameFor, renderAccess, viewNameFor, type AccessRow } from "../nodes/rowAccess";
import { canSee, type PrivacyOverrides, type PrivacyRule } from "../privacy";
import { ownedConfirmedEmailsOf } from "../signInEmails";
import { getMembership } from "../workspaceAuth";

/**
 * The most grant rows one lookup reads, across both indexes.
 *
 * An outsider with more grants than this reaches the first two hundred, which
 * is a ceiling no real account meets rather than a policy. Mirrors
 * `MAX_NAMES_SCANNED` in `grantedNames.ts`.
 */
export const MAX_OUTSIDER_GRANTS_SCANNED = 200;

/** One outsider's view of one workspace: the names they hold there, and the guest rendering of its rows. */
export interface GuestView {
  workspaceId: Id<"workspaces">;
  names: readonly string[];
  rules: PrivacyRule[];
  overrides: PrivacyOverrides;
  /** The workspace's live access rows the view was rendered from, for the edit walk. */
  rows: readonly AccessRow[];
}

/** A row an outsider may read, as the live rows say it is. */
export interface GrantedNode {
  path: string;
  kind: "file" | "folder";
  names: string[];
  /** Whether the outsider holds `edit` on the row that governs this note (`guestCanEdit`). Never for a folder. */
  canEdit: boolean;
}

/**
 * One grant the caller holds, as the live rows confirm it.
 *
 * `at` and `grantedBy` come from the grant row itself, and `props` from the
 * live node: what the Shared with me list titles it with (`./../shares/inboxTitle.ts`).
 * Reading them does not widen anything: the node is already judged by `guestCanSee`.
 */
export interface OutsiderGrant {
  workspaceId: Id<"workspaces">;
  nodeId: Id<"nodes">;
  noteId: string;
  path: string;
  kind: "file" | "folder";
  props: string | undefined;
  at: number;
  /** The account that wrote the row, where the row records one. */
  grantedBy: Id<"users"> | null;
}

/**
 * Whether the guest view opens `path`. The only test an outsider's read or
 * listing is judged by: `canSee` at `team` scope, with the names the guest holds
 * and the guest rendering of the live rows. Plumbing (`.context/`, `privacy.md`)
 * is refused by `canSee` itself.
 */
export function guestCanSee(view: GuestView, path: string): boolean {
  return canSee(path, "team", view.rules, view.overrides, clearanceOf("team", view.names).names);
}

/**
 * Whether the guest view lets its holder write `path`'s body: the path opens to
 * them, it is a canonical note path, and the row that governs it names them with
 * `edit`. A view grant is not enough, and an edit grant on some other row (a
 * folder whose note sets its own list) is not enough: a note's list replaces its
 * folder's.
 */
export function guestCanEdit(view: GuestView, path: string): boolean {
  if (!isCanonicalPath(path) || !guestCanSee(view, path)) return false;
  const governing = governingRowOf(view.rows, path);
  return governing !== null && view.names.includes(editNameFor(governing.noteId));
}

/**
 * The caller's guest view of one workspace, or `null` when they have no place there.
 *
 * `null` for: rows mode not on (grants are read from rows only), a workspace
 * that does not exist, a caller who is a member (they take `grantedNamesFor`),
 * and a caller who holds no name in it. Every one of those is the same refusal
 * upstream, so none is told apart.
 */
export async function guestViewOf(
  ctx: QueryCtx,
  userId: Id<"users">,
  workspaceId: Id<"workspaces">,
  emails?: readonly string[],
): Promise<GuestView | null> {
  if ((await accessSourceOf(ctx.db)) !== "rows") return null;
  if ((await ctx.db.get(workspaceId)) === null) return null;
  if ((await getMembership(ctx, workspaceId, userId)) !== null) return null;
  const rows = await accessRowsOf(ctx, workspaceId);
  const held = emails ?? (await ownedConfirmedEmailsOf(ctx, userId));
  const names = accessNamesFor({ userId, emails: held }, rows);
  if (names.length === 0) return null;
  const { rules, overrides } = renderAccess(rows, "guest");
  return { workspaceId, names, rules, overrides, rows };
}

/**
 * The node a locator names, if it is live: by its stable note id, or by a path.
 *
 * Exactly one of the two. An id that names two rows (a duplicate the repair
 * tool has not yet fixed) names neither, so it is refused rather than guessed.
 * A trashed row is not live: trashing moves it under `.context/`, and a row
 * carrying a `goneAt` tombstone is already gone.
 */
async function liveNodeFor(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  locator: { noteId?: string; path?: string },
): Promise<Doc<"nodes"> | null> {
  if ((locator.noteId === undefined) === (locator.path === undefined)) return null;
  let node: Doc<"nodes"> | null;
  if (locator.noteId !== undefined) {
    const found = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_noteId", (q) => q.eq("workspaceId", workspaceId).eq("noteId", locator.noteId as string))
      .take(2);
    if (found.length !== 1) return null;
    node = found[0];
  } else {
    const normalized = normalizePath(locator.path as string);
    if (normalized === null) return null;
    node = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", normalized))
      .unique();
  }
  if (node === null || node.goneAt !== undefined) return null;
  return node;
}

/**
 * The one node an outsider may read or list, or `null` for every refusal.
 *
 * `null` is the answer for a path that is not there, a node that is trashed, a
 * note that exists and is not granted, a grant in another workspace, and a
 * caller who is a member or a stranger. The caller cannot tell those apart, and
 * the caller of this function does not need to.
 */
export async function authorizeGrant(
  ctx: QueryCtx,
  args: { userId: Id<"users">; workspaceId: Id<"workspaces">; noteId?: string; path?: string },
): Promise<GrantedNode | null> {
  const view = await guestViewOf(ctx, args.userId, args.workspaceId);
  if (view === null) return null;
  const node = await liveNodeFor(ctx, args.workspaceId, { noteId: args.noteId, path: args.path });
  if (node === null) return null;
  if (!guestCanSee(view, node.path)) return null;
  const canEdit = node.kind === "file" && guestCanEdit(view, node.path);
  return { path: node.path, kind: node.kind, names: [...view.names], canEdit };
}

/**
 * The paths of a listing an outsider may see, out of `paths`, in one workspace.
 *
 * A listing comes from the engine at `team` scope with the outsider's names,
 * which applies the member rendering. This is the guest rendering's answer for
 * each entry, so a `team` subfolder inside a granted folder, which a member would
 * see, is left out for the outsider.
 */
export async function visibleGrantedPaths(
  ctx: QueryCtx,
  args: { userId: Id<"users">; workspaceId: Id<"workspaces">; paths: readonly string[] },
): Promise<string[]> {
  const view = await guestViewOf(ctx, args.userId, args.workspaceId);
  if (view === null) return [];
  return args.paths.filter((path) => guestCanSee(view, path));
}

/**
 * Every grant this account holds in a workspace it is not a member of, as the
 * live rows confirm it. Bounded by `MAX_OUTSIDER_GRANTS_SCANNED`.
 *
 * Candidates come from `by_grantee_user` and from `by_grantee_email`, once per
 * address `ownedConfirmedEmailsOf` gives this account. Each candidate is kept
 * only if its workspace's live rows still name this caller on that row and the
 * node is live and open to them (`guestCanSee`).
 */
export async function outsiderGrantsFor(ctx: QueryCtx, userId: Id<"users">): Promise<OutsiderGrant[]> {
  if ((await accessSourceOf(ctx.db)) !== "rows") return [];
  const emails = await ownedConfirmedEmailsOf(ctx, userId);
  const candidates = await candidateGrants(ctx, userId, emails);

  // A grant can be found by both indexes (an account, and an address it also holds), so each row is judged once.
  const byWorkspace = new Map<Id<"workspaces">, Doc<"nodeAccess">[]>();
  const seen = new Set<string>();
  for (const grant of candidates) {
    if (seen.has(grant._id)) continue;
    seen.add(grant._id);
    const list = byWorkspace.get(grant.workspaceId) ?? [];
    list.push(grant);
    byWorkspace.set(grant.workspaceId, list);
  }

  const out: OutsiderGrant[] = [];
  for (const [workspaceId, grants] of byWorkspace) {
    const view = await guestViewOf(ctx, userId, workspaceId, emails);
    if (view === null) continue;
    for (const grant of grants) {
      const node = await ctx.db.get(grant.nodeId);
      if (node === null || node.workspaceId !== workspaceId || node.goneAt !== undefined) continue;
      const noteId = node.noteId ?? node._id;
      // The live rows must still name this caller on this very row, and the path must still open to them.
      if (!view.names.includes(viewNameFor(noteId))) continue;
      if (!guestCanSee(view, node.path)) continue;
      out.push({
        workspaceId,
        nodeId: node._id,
        noteId,
        path: node.path,
        kind: node.kind,
        props: node.props,
        at: grant.at,
        grantedBy: grant.grantedBy ?? null,
      });
    }
  }
  return out;
}

/** The grant rows an account is named on, found through the two global indexes and bounded. */
async function candidateGrants(
  ctx: QueryCtx,
  userId: Id<"users">,
  emails: readonly string[],
): Promise<Doc<"nodeAccess">[]> {
  const found = await ctx.db
    .query("nodeAccess")
    .withIndex("by_grantee_user", (q) => q.eq("granteeUserId", userId))
    .take(MAX_OUTSIDER_GRANTS_SCANNED);
  for (const email of emails) {
    const room = MAX_OUTSIDER_GRANTS_SCANNED - found.length;
    if (room <= 0) break;
    const byEmail = await ctx.db
      .query("nodeAccess")
      .withIndex("by_grantee_email", (q) => q.eq("granteeEmail", email))
      .take(room);
    found.push(...byEmail);
  }
  return found;
}
