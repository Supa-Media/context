/**
 * Shadow parity for the access rows (PR 1 of the privacy-rows plan).
 *
 * For every live row, under each clearance the rules can name, the answer the
 * engine gives from the rules (`canSee` over `privacy.md`'s rules, as
 * `mirrorRules` reads them) is set against the answer it gives from the rows
 * (`canSee` over `renderAccess(rows, "member")`, with names from
 * `accessNamesFor`). Any diff is a bug in the derivation, not a policy choice.
 *
 * Clearances:
 *  - `owner`: private scope. Every row is visible to both sides.
 *  - `member`: team scope, no names.
 *  - `member:@name`: team scope, holding one name. A group name is held by a
 *    member of that group; a person's name only by a live member of this
 *    workspace (`grantedNamesFor` intersects with membership, and so does the
 *    caller here). A name nobody in the workspace can hold has no clearance:
 *    a clearance that nobody can be given is not a comparison.
 *
 * Reports diffs by path and clearance only. No note content is read.
 *
 * The rows are read whole on every page, because a row's answer depends on
 * the folder rows above it and on case-fold twins; only the page's own rows
 * are judged. This is a staff check, not a request path.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { clearanceOf, NO_NAMES } from "../clearance";
import { canSee, isGroupScope, type Scope, type Visibility } from "../privacy";
import { resolveHandle, type Grant } from "./accessBackfill";
import { readMirror } from "./listing";
import { mirrorRules, type Rules } from "./log";
import { accessNamesFor, renderAccess, type AccessRow, type Caller, type Grantee } from "./rowAccess";

/** Rows judged per page. */
export const PARITY_PAGE = 200;

export interface ParityDiff {
  path: string;
  clearance: string;
  old: boolean;
  new: boolean;
}

export interface ParityPage {
  diffs: ParityDiff[];
  /** Where the next page starts, or `null` when this page reached the end. */
  next: string | null;
  /** Live rows judged on this page. */
  checked: number;
}

/** One clearance the rows are compared under. */
interface Holder {
  label: string;
  scope: Scope;
  oldNames: ReadonlySet<string>;
  caller: Caller;
}

function granteeOf(grant: Doc<"nodeAccess">): Grantee | null {
  if (grant.granteeKind === "user" && grant.granteeUserId !== undefined) {
    return { kind: "user", id: grant.granteeUserId, role: grant.role };
  }
  if (grant.granteeKind === "group" && grant.granteeGroupId !== undefined) {
    return { kind: "group", id: grant.granteeGroupId, role: grant.role };
  }
  if (grant.granteeKind === "email" && grant.granteeEmail !== undefined) {
    return { kind: "email", id: grant.granteeEmail, role: grant.role };
  }
  return null;
}

/** Every row that carries an access setting, as the renderer takes them. Tombstones included: the derivation covers them too. */
export async function accessRowsOf(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<AccessRow[]> {
  const rows = await ctx.db
    .query("nodes")
    .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  const grants = await ctx.db
    .query("nodeAccess")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  const granteesByNode = new Map<string, Grantee[]>();
  for (const grant of grants) {
    const grantee = granteeOf(grant);
    if (grantee === null) continue;
    const list = granteesByNode.get(grant.nodeId) ?? [];
    list.push(grantee);
    granteesByNode.set(grant.nodeId, list);
  }
  const out: AccessRow[] = [];
  for (const row of rows) {
    const grantees = granteesByNode.get(row._id) ?? [];
    if (row.access === undefined && grantees.length === 0) continue;
    out.push({
      path: row.path,
      noteId: row.noteId ?? row._id,
      kind: row.kind,
      base: row.access?.base,
      grantees,
    });
  }
  return out;
}

/**
 * The caller a resolved handle stands for, or `null` when nobody in this
 * workspace can hold it. A person's grant counts only while they are a live
 * member of the workspace.
 */
async function callerFor(ctx: QueryCtx, workspaceId: Id<"workspaces">, grant: Grant | null): Promise<Caller | null> {
  if (grant === null) return null;
  if (grant.kind === "group") return { groupIds: [grant.groupId] };
  const member = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace_user", (q) => q.eq("workspaceId", workspaceId).eq("userId", grant.userId))
    .unique();
  return member === null ? null : { userId: grant.userId };
}

/** The clearances to compare under: owner, member with no names, and each name a member can hold. */
async function holdersOf(ctx: QueryCtx, workspaceId: Id<"workspaces">, rules: Rules): Promise<Holder[]> {
  const holders: Holder[] = [
    { label: "owner", scope: "private", oldNames: NO_NAMES, caller: {} },
    { label: "member", scope: "team", oldNames: NO_NAMES, caller: {} },
  ];
  const handles = new Set<string>();
  for (const rule of rules.rules) if (isGroupScope(rule.vis)) handles.add(rule.vis);
  for (const vis of rules.overrides.values()) if (isGroupScope(vis)) handles.add(vis);
  const cache = new Map<string, Grant | null>();
  for (const handle of [...handles].sort()) {
    const grant = await resolveHandle(ctx, workspaceId, handle as Visibility, cache);
    const caller = await callerFor(ctx, workspaceId, grant);
    if (caller === null) continue;
    holders.push({ label: `member:${handle}`, scope: "team", oldNames: clearanceOf("team", [handle]).names, caller });
  }
  return holders;
}

/** One page of the parity check: the live rows after `cursor` (`null` for the first page). */
export async function accessParityPage(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  cursor: string | null,
  pageSize: number = PARITY_PAGE,
): Promise<ParityPage> {
  const old = await mirrorRules(await readMirror(ctx.db, workspaceId));
  const accessRows = await accessRowsOf(ctx, workspaceId);
  const fresh = renderAccess(accessRows, "member");
  const holders = await holdersOf(ctx, workspaceId, old);
  const newNames = holders.map((holder) => new Set(accessNamesFor(holder.caller, accessRows)));
  const page = await ctx.db
    .query("nodes")
    .withIndex("by_workspace_path", (q) =>
      cursor === null ? q.eq("workspaceId", workspaceId) : q.eq("workspaceId", workspaceId).gt("path", cursor),
    )
    .take(pageSize);

  const diffs: ParityDiff[] = [];
  let checked = 0;
  for (const row of page) {
    if (row.goneAt !== undefined) continue;
    checked += 1;
    holders.forEach((holder, index) => {
      const oldAnswer = canSee(row.path, holder.scope, old.rules, old.overrides, holder.oldNames);
      const newAnswer = canSee(row.path, holder.scope, fresh.rules, fresh.overrides, newNames[index]);
      if (oldAnswer !== newAnswer) diffs.push({ path: row.path, clearance: holder.label, old: oldAnswer, new: newAnswer });
    });
  }
  const last = page.length === pageSize ? page[page.length - 1].path : null;
  return { diffs, next: last, checked };
}
