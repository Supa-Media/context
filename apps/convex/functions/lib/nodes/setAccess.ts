/**
 * Setting one tree row's access in rows mode (`nodeMigration.accessSource` =
 * `rows`), where the rows are the truth (`docs/decisions/app-and-console/
 * convex-tree.md`, privacy-rows plan PR 3).
 *
 * A row's base is `nodes.access` (`private` or `team`, or unset to inherit);
 * its list is the `nodeAccess` grants whose source is `owner` (an owner set
 * them here). `share` grants are an owner's share of their own and are never
 * touched. In rows mode the `privacy.md` derived grants are dropped too,
 * since nothing derives them any more.
 *
 * Never creates a row. A path with no row takes a base as pending access
 * (`pendingAccess.ts`), which the row gets when it is born at that path; a list
 * on such a path is `NOT_FOUND`. Every change bumps `nodeAccessState.version`
 * and rebuilds the snapshot readers answer from (a pending change rebuilds nothing:
 * readers render pending access from the state itself).
 *
 * A private <-> team change with no `grantees` keeps the owner's list: a list that is
 * given (`[]` and `"inherit"` included) replaces it, and a reset of the base to
 * `inherit` clears it. Every change of the owner's
 * list writes one `access.list` audit row; a refused change writes none.
 */

import { normalizeEmail } from "@context/shared";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { effectiveVisibility, visibilityOf, narrowerVisibility, type Visibility } from "../privacy";
import { refreshSnapshot } from "./accessBackfill";
import { pinnedContextWorkspace } from "../pinnedContext";
import { scanAccessRows } from "./accessRows";
import { livePending, PENDING_MAX } from "./pendingAccess";
import { renderAccess } from "./rowAccess";
import { recordRouteChangeAtHandler } from "../websites/routeChangeAt";
import { treeAudiences } from "../treeAudiences";
import { stampTreeAudiences } from "../../treeSignals";
import { rulesForReaders } from "./readerRules";

export type Role = "view" | "edit";
export type Base = "private" | "team" | "inherit";

/** The most grantees one row's list may hold. Past it a list is refused (`INVALID`), and nothing is written. */
export const MAX_GRANTEES = 100;

/** One grantee the owner names. Users and groups by id; emails are normalized here. */
export type GranteeInput =
  | { kind: "user"; userId: Id<"users">; role: Role }
  | { kind: "group"; groupId: Id<"workspaceGroups">; role: Role }
  | { kind: "email"; email: string; role: Role }
  /** Every real member of the workspace (`rowAccess.ts`). */
  | { kind: "members"; role: Role }
  /** Every signed-in Context account (`rowAccess.ts`): written in the pinned workspace only (`wantedOf`). */
  | { kind: "accounts"; role: Role };

/**
 * One grant already on a row, as the grantee a list write takes back: a write that rebuilds a list from what is
 * there must carry every kind, `members` included, or it drops that grant without anybody asking. `null` for a
 * grant missing the id its kind needs.
 */
export function granteeInputOf(grant: Doc<"nodeAccess">): GranteeInput | null {
  if (grant.granteeKind === "user" && grant.granteeUserId !== undefined) {
    return { kind: "user", userId: grant.granteeUserId, role: grant.role };
  }
  if (grant.granteeKind === "group" && grant.granteeGroupId !== undefined) {
    return { kind: "group", groupId: grant.granteeGroupId, role: grant.role };
  }
  if (grant.granteeKind === "email" && grant.granteeEmail !== undefined) {
    return { kind: "email", email: grant.granteeEmail, role: grant.role };
  }
  if (grant.granteeKind === "members") return { kind: "members", role: grant.role };
  if (grant.granteeKind === "accounts") return { kind: "accounts", role: grant.role };
  return null;
}

/** Who asks. Changing a list is the owner's; a base alone may be an editor's (`/gateway/privacy` checks the grant). */
export interface Actor {
  userId: Id<"users">;
  role: "owner" | "editor" | "member";
  /**
   * The OAuth client that acted, where the change is made under somebody's
   * authority rather than by their own hand (`bugNotes.shareWithTeam` names
   * the team under the owner). Audited beside them, so the trail does not
   * read as a grant they sat down and made.
   */
  clientId?: string;
}

export interface SetAccessArgs {
  workspaceId: Id<"workspaces">;
  path: string;
  base: Base;
  /**
   * The list that replaces the owner's. Omitted keeps the owner's list as it is;
   * `[]` or `"inherit"` clears it.
   */
  grantees?: GranteeInput[] | "inherit";
  /** The `nodeAccessState.version` the caller read; a different one is a `CONFLICT`. */
  expectedVersion?: number;
  /** Only for a path with no row yet: which row the pending access is for. A file unless said. */
  kind?: "file" | "folder";
  actor: Actor;
}

export type SetAccessCode = "CONFLICT" | "NOT_FOUND" | "FORBIDDEN" | "PENDING_FULL" | "INVALID";
export type SetAccessAnswer = { ok: true; version: number } | { ok: false; code: SetAccessCode };

/** A grant's identity for comparing two lists: who, and at what role. */
function keyOf(grant: { granteeKind: string; granteeUserId?: string; granteeGroupId?: string; granteeEmail?: string; role: string }): string {
  return `${grant.granteeKind}:${grant.granteeUserId ?? grant.granteeGroupId ?? grant.granteeEmail ?? ""}:${grant.role}`;
}

interface Wanted {
  kind: "user" | "group" | "email" | "members" | "accounts";
  granteeUserId?: Id<"users">;
  granteeGroupId?: Id<"workspaceGroups">;
  granteeEmail?: string;
  role: Role;
}

/**
 * The grantees as rows: each id must be real here (a group of this workspace,
 * a user who exists), and an email is normalized. `null` for a grantee that
 * resolves to nothing, which is refused as one.
 *
 * `accounts` resolves only in the pinned workspace. Anywhere else "every signed-in Context account" would be a
 * setting that publishes a note to anyone who signs up, which non-negotiable #5 rules out, so it resolves to
 * nothing there and the whole write is refused (`docs/decisions/privacy-and-sharing/all-context-users.md`).
 */
async function wantedOf(ctx: MutationCtx, workspaceId: Id<"workspaces">, grantees: GranteeInput[]): Promise<Wanted[] | null> {
  const out: Wanted[] = [];
  const seen = new Set<string>();
  for (const grantee of grantees) {
    let wanted: Wanted;
    if (grantee.kind === "user") {
      if ((await ctx.db.get(grantee.userId)) === null) return null;
      wanted = { kind: "user", granteeUserId: grantee.userId, role: grantee.role };
    } else if (grantee.kind === "members") {
      wanted = { kind: "members", role: grantee.role };
    } else if (grantee.kind === "accounts") {
      const pinned = await pinnedContextWorkspace(ctx);
      // Read only: a sign-up must never be enough to change a note.
      if (pinned === null || pinned._id !== workspaceId || grantee.role !== "view") return null;
      wanted = { kind: "accounts", role: grantee.role };
    } else if (grantee.kind === "group") {
      const group = await ctx.db.get(grantee.groupId);
      if (group === null || group.workspaceId !== workspaceId) return null;
      wanted = { kind: "group", granteeGroupId: grantee.groupId, role: grantee.role };
    } else {
      const email = normalizeEmail(grantee.email);
      if (email.length === 0) return null;
      wanted = { kind: "email", granteeEmail: email, role: grantee.role };
    }
    const key = keyOf({
      granteeKind: wanted.kind,
      granteeUserId: wanted.granteeUserId,
      granteeGroupId: wanted.granteeGroupId,
      granteeEmail: wanted.granteeEmail,
      role: wanted.role,
    });
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(wanted);
  }
  return out;
}

/**
 * A base on a path with no row yet: kept as pending access until the row is born at that path
 * (`pendingAccess.ts`). Only a base can wait; a list needs its row, so it is `NOT_FOUND`, as it always was.
 * `inherit` drops a waiting entry. Every change moves the version, as a row's change does.
 */
async function setPendingAccess(
  ctx: MutationCtx,
  args: SetAccessArgs,
  state: Doc<"nodeAccessState"> | null,
): Promise<SetAccessAnswer> {
  const { workspaceId, path, base } = args;
  if (args.grantees !== undefined && args.grantees !== "inherit" && args.grantees.length > 0) {
    return { ok: false, code: "NOT_FOUND" };
  }
  const now = Date.now();
  const version = state?.version ?? 0;
  const waiting = livePending(state?.pending, now);
  const had = waiting.find((entry) => entry.path === path);
  const others = waiting.filter((entry) => entry.path !== path);
  const expired = (state?.pending?.length ?? 0) !== waiting.length;
  let next = others;
  if (base !== "inherit") {
    if (had === undefined && others.length >= PENDING_MAX) return { ok: false, code: "PENDING_FULL" };
    next = [...others, { path, kind: args.kind ?? "file", base, at: now }];
  } else if (had === undefined && !expired) {
    return { ok: true, version };
  }
  const nextVersion = version + 1;
  if (state === null) await ctx.db.insert("nodeAccessState", { workspaceId, version: nextVersion, orphans: [], pending: next });
  else await ctx.db.patch(state._id, { version: nextVersion, pending: next });
  return { ok: true, version: nextVersion };
}

/**
 * Keep notes about to arrive private, in rows mode: a move from another workspace lands each note at a path with no
 * row yet, and its row is born private (`pendingAccess.ts`). A path that already has a row is left alone, since the
 * landing refuses it. `false` when the pending list is full: the caller must not land anything then.
 */
export async function pendPrivateArrivals(ctx: MutationCtx, workspaceId: Id<"workspaces">, paths: readonly string[]): Promise<boolean> {
  for (const path of paths) {
    const row = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", path))
      .unique();
    if (row !== null) continue;
    const state = await ctx.db
      .query("nodeAccessState")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    const answer = await setPendingAccess(ctx, { workspaceId, path, base: "private", kind: "file" } as SetAccessArgs, state);
    if (!answer.ok) return false;
  }
  return true;
}

/** The token a grant is audited by: its kind, its id and its role. An email is audited only as its SHA-256. */
async function auditToken(grant: { kind: string; userId?: string; groupId?: string; email?: string; role: string }): Promise<string> {
  let id: string;
  if (grant.kind === "email") {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode((grant.email ?? "").toLowerCase()));
    id = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } else {
    id = grant.userId ?? grant.groupId ?? "";
  }
  return `${grant.kind}:${id}:${grant.role}`;
}

/** Set one row's base and list, from the version the caller read (`expectedVersion`, when given). */
export async function setAccessRow(ctx: MutationCtx, args: SetAccessArgs): Promise<SetAccessAnswer> {
  const { workspaceId, path, base, actor } = args;
  // Refused before anything is read or written: a list over the cap is never partly applied.
  const listed = args.grantees === undefined || args.grantees === "inherit" ? 0 : args.grantees.length;
  if (listed > MAX_GRANTEES) return { ok: false, code: "INVALID" };

  const row = await ctx.db
    .query("nodes")
    .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", path))
    .unique();

  const state = await ctx.db
    .query("nodeAccessState")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  if (args.expectedVersion !== undefined && args.expectedVersion !== (state?.version ?? 0)) {
    return { ok: false, code: "CONFLICT" };
  }
  if (row === null) return await setPendingAccess(ctx, args, state);

  const grants = await ctx.db
    .query("nodeAccess")
    .withIndex("by_node", (q) => q.eq("nodeId", row._id))
    .collect();
  const held = grants.filter((grant) => grant.source !== "share");
  // A given list, `[]` included, replaces the owner's. Without one, only a base of `inherit` replaces it (with none):
  // inherit means "as the parent", so a list left behind would be a hidden grant. private <-> team keeps the list.
  const replaces = args.grantees !== undefined || base === "inherit";
  const wanted = await wantedOf(ctx, workspaceId, args.grantees === undefined || args.grantees === "inherit" ? [] : args.grantees);
  if (wanted === null) return { ok: false, code: "NOT_FOUND" };

  const before = held.map(keyOf).sort().join("|");
  const after = wanted.map((grant) => keyOf({ granteeKind: grant.kind, granteeUserId: grant.granteeUserId, granteeGroupId: grant.granteeGroupId, granteeEmail: grant.granteeEmail, role: grant.role })).sort().join("|");
  const listChanges = replaces && before !== after;
  if (listChanges && actor.role !== "owner") return { ok: false, code: "FORBIDDEN" };

  // Every refusal is above this line: a refused change writes nothing, not even the pending entry it would clear.
  // A row stands at the path now: an access still waiting for it is answered by the row's own base from here on.
  if (state !== null && state.pending?.some((entry) => entry.path === path)) {
    await ctx.db.patch(state._id, { pending: state.pending.filter((entry) => entry.path !== path) });
  }
  // Who could see the path before, for the tree hint below: a narrowing is news to the readers who lose it.
  const seenBefore = await rulesForReaders(ctx, workspaceId, "member");
  const nextBase = base === "inherit" ? undefined : base;
  if (row.access?.base !== nextBase) {
    await ctx.db.patch(row._id, { access: nextBase === undefined ? undefined : { base: nextBase } });
  }
  // A replaced list drops the owner's grants and the derived ones; a kept list drops only the derived ones.
  // A share is left as it is.
  for (const grant of held) {
    if (replaces || grant.source === "privacy.md") await ctx.db.delete(grant._id);
  }
  const at = Date.now();
  for (const grant of wanted) {
    await ctx.db.insert("nodeAccess", {
      workspaceId,
      nodeId: row._id,
      granteeKind: grant.kind,
      granteeUserId: grant.granteeUserId,
      granteeGroupId: grant.granteeGroupId,
      granteeEmail: grant.granteeEmail,
      role: grant.role,
      grantedBy: actor.userId,
      at,
      source: "owner",
    });
  }

  if (listChanges) {
    const heldTokens = await Promise.all(
      held.map((grant) => auditToken({ kind: grant.granteeKind, userId: grant.granteeUserId, groupId: grant.granteeGroupId, email: grant.granteeEmail, role: grant.role })),
    );
    const wantedTokens = await Promise.all(
      wanted.map((grant) => auditToken({ kind: grant.kind, userId: grant.granteeUserId, groupId: grant.granteeGroupId, email: grant.granteeEmail, role: grant.role })),
    );
    const heldSet = new Set(heldTokens);
    const wantedSet = new Set(wantedTokens);
    const added = [...new Set(wantedTokens.filter((token) => !heldSet.has(token)))];
    const removed = [...new Set(heldTokens.filter((token) => !wantedSet.has(token)))];
    await recordAudit(ctx, {
      workspaceId,
      actorUserId: actor.userId,
      actorClientId: actor.clientId,
      action: "access.list",
      details: {
        nodeId: String(row._id),
        addedCount: added.length,
        removedCount: removed.length,
        added: added.join(","),
        removed: removed.join(","),
      },
    });
  }

  // A narrowing the published site reaches withholds its menu until the index is rebuilt, as a `privacy.md`
  // change did (`markWebsiteAfterOperation`); every access writer comes through here.
  await recordRouteChangeAtHandler(ctx, { workspaceId, paths: [path], unsafe: true });
  const version = await refreshSnapshot(ctx, workspaceId);
  // The tree hint (`treeSignals.ts`) of everyone who could see the path before or can now, as a rules write told them
  // (`audiencesForChange`): their open trees walk again, and a note narrowed away from them leaves it.
  const seenAfter = await rulesForReaders(ctx, workspaceId, "member");
  await stampTreeAudiences(ctx, workspaceId, [
    ...treeAudiences([path], seenBefore.rules, seenBefore.overrides),
    ...treeAudiences([path], seenAfter.rules, seenAfter.overrides),
  ]);
  return { ok: true, version };
}

/** The tier a member's answer is judged by: a list's token counts as private, the narrower answer. */
function tierOf(visibility: Visibility): "private" | "team" {
  return visibility === "team" ? "team" : "private";
}

/**
 * A folder moved into a wider folder keeps its narrowing (`movePrivacy.ts`,
 * `carriedRules`): where the folder was private and the new parent is team,
 * the moved row itself gets base `private`, which the file carried as a
 * private rule at the new name. Written at the old path, before the rows move,
 * so the move carries it; an undone move keeps it, which is only ever narrower.
 *
 * Nothing else is rewritten: a row with its own base keeps it, as the file
 * kept an explicit exception, and a child that inherits follows its parent.
 */
export async function narrowRowForMove(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  from: string,
  to: string,
): Promise<void> {
  const rows = await scanAccessRows(ctx, workspaceId);
  const { rules, overrides } = renderAccess(rows, "member");
  const was = tierOf(effectiveVisibility(from, rules, overrides));
  const there = tierOf(visibilityOf(to, rules));
  // `narrowerVisibility` of two tiers is the narrower one; a move narrows only where it would widen.
  const carry = tierOf(narrowerVisibility(was, there) ?? "private");
  if (carry === there) return;
  const row = await ctx.db
    .query("nodes")
    .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", from))
    .unique();
  if (row === null || row.access?.base === carry) return;
  await ctx.db.patch(row._id, { access: { base: carry } });
  await refreshSnapshot(ctx, workspaceId);
}
