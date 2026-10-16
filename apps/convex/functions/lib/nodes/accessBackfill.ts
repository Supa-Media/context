/**
 * The tree's access rows, derived from a workspace's privacy rules (PR 1 of
 * the privacy-rows plan, `docs/decisions/app-and-console/convex-tree.md`).
 *
 * Inert: nothing reads `nodes.access` or `nodeAccess` yet, and nothing writes
 * them unless the deployment's `nodeMigration.accessSource` is `shadow` or
 * `rows` (`refreshAccess`). The rules keep deciding (`canSee`,
 * `effectiveVisibility`); this writes the same decisions onto the rows so PR 2
 * can read them and a parity check can compare the two.
 *
 * ## What each row carries
 *
 * - A folder rule names a folder row that exists: `access.base` is the rule's
 *   tier. A group or a person names it too: base `private`, plus a view grant.
 * - A note override names its note row, resolved through `overrideFor`, so a
 *   `private` override reaches its case-fold twins and a `team` one does not
 *   (`privacy.ts`). A folder rule that names a file row (a move's carry rule)
 *   names that row the same way. A row nothing names carries nothing and
 *   inherits.
 * - A handle (`@name`) that resolves to nobody, or to a group of another
 *   workspace, is base `private` with no grant: fail closed, and reported as
 *   an orphan in `nodeAccessState`.
 * - A folder rule with no row at its path creates nothing. It is an orphan
 *   (`kind: "folder"`): an empty folder row would show in people's file trees.
 *
 * ## Derived rows are replaced, owned rows are not
 *
 * A grant written here has `source: "privacy.md"`, and every derivation
 * replaces those and only those. A `share` grant is an owner's explicit act
 * and is never touched by one.
 *
 * ## Paged, and inline for small trees
 *
 * `deriveAccessPage` walks the workspace's rows by path, a page at a time, so
 * a large tree never has to be read in one transaction. The last page reports
 * the orphans and bumps the version. `deriveAccess` is the whole walk in one
 * call. `backfillAccess` runs it inline for a small tree and schedules the
 * paged walk for a large one, by the live file count.
 */

import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { DatabaseReader, MutationCtx, QueryCtx } from "../../../_generated/server";
import { PrivacyOverrides, isGroupScope, overrideFor, type Visibility } from "../privacy";
import { resolveAddressedUser } from "../identities";
import { privacyRowOf } from "./privacyAuthority";
import { scanAccessRows } from "./accessRows";
import type { AccessRow } from "./rowAccess";

/** The `source` every derived grant carries. */
export const ACCESS_SOURCE = "privacy.md" as const;

/** A tree at or under this many live files derives in the write's own transaction; larger ones are scheduled. */
export const INLINE_DERIVE_MAX_FILES = 2_000;

/** Rows one page of the walk reads. */
export const DERIVE_PAGE = 500;

/**
 * The most rows the snapshot holds. Past this (or `SNAPSHOT_MAX_BYTES`, which
 * a document also has to fit under) the snapshot is not stored and readers
 * scan the rows, as they did before there was one.
 */
export const SNAPSHOT_MAX_ROWS = 4_000;

/** The most bytes of JSON the snapshot may be; a Convex document is capped well above this. */
export const SNAPSHOT_MAX_BYTES = 800_000;

/** The deployment's access switch: `file` (the default) derives nothing. */
export type AccessSource = "file" | "shadow" | "rows";

/** A grant the rules name, resolved to the fact behind the name. */
export type Grant = { kind: "user"; userId: Id<"users"> } | { kind: "group"; groupId: Id<"workspaceGroups"> };

/** What a row should carry: its base, and the grants on it. */
interface Desired {
  base: "private" | "team";
  grants: Grant[];
}

/** A rule the derivation could not make use of: reported, and never granted. */
export interface Orphan {
  kind: "override" | "unresolved" | "folder";
  path: string;
  handle?: string;
  visibility?: string;
}

/** One page's answer: where the next page starts, and whether the walk is over. */
export interface DerivePage {
  next: string | null;
  done: boolean;
}

interface Rules {
  /** Folder rules by prefix. Where a prefix is named twice, the first stands (`visibilityOf`). */
  folders: Map<string, Visibility>;
  /** Note overrides, with the case-fold lookup `overrideFor` needs. */
  overrides: PrivacyOverrides;
  /** The `privacy.md` version these rules were read from. */
  etag: string | undefined;
}

/** Handles resolved within one page, so a name that many rows name is looked up once. */
type Cache = Map<string, Grant | null>;

/** The deployment's access switch (`nodeMigration.accessSource`); unset means `file`. */
export async function accessSourceOf(db: DatabaseReader): Promise<AccessSource> {
  const row = await db.query("nodeMigration").first();
  return row?.accessSource ?? "file";
}

/** Whether a switch setting derives rows at all. */
export function accessDerived(source: AccessSource): boolean {
  return source === "shadow" || source === "rows";
}

async function rowAt(ctx: MutationCtx, workspaceId: Id<"workspaces">, path: string): Promise<Doc<"nodes"> | null> {
  return await ctx.db
    .query("nodes")
    .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", path))
    .unique();
}

async function rulesOf(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<Rules> {
  const row = await privacyRowOf(ctx, workspaceId);
  const folders = new Map<string, Visibility>();
  for (const rule of row?.folders ?? []) {
    if (!folders.has(rule.prefix)) folders.set(rule.prefix, rule.visibility as Visibility);
  }
  const overrides = new PrivacyOverrides();
  for (const note of row?.notes ?? []) overrides.set(note.path, note.visibility as Visibility);
  return { folders, overrides, etag: row?.etag };
}

/**
 * The fact behind an `@name`, in this workspace, or `null`.
 *
 * A group is looked up first: group names are unique across the `names`
 * table, so a group of another workspace is found here and resolves to
 * nothing, rather than falling through to a person of the same name. A
 * person resolves the way every addressed share does (`resolveAddressedUser`).
 */
export async function resolveHandle(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  visibility: Visibility,
  cache: Cache,
): Promise<Grant | null> {
  const cached = cache.get(visibility);
  if (cached !== undefined) return cached;
  const name = visibility.slice(1);
  const group = await ctx.db
    .query("workspaceGroups")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
  let grant: Grant | null;
  if (group !== null) {
    grant = group.workspaceId === workspaceId ? { kind: "group", groupId: group._id } : null;
  } else {
    const userId = await resolveAddressedUser(ctx, { kind: "name", value: name });
    grant = userId === null ? null : { kind: "user", userId };
  }
  cache.set(visibility, grant);
  return grant;
}

/** What a row should carry, given the visibility a rule gives it; `null` for nothing (it inherits). */
async function desiredFor(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  visibility: Visibility | undefined,
  cache: Cache,
): Promise<Desired | null> {
  if (visibility === undefined) return null;
  if (visibility === "team" || visibility === "private") return { base: visibility, grants: [] };
  const grant = await resolveHandle(ctx, workspaceId, visibility, cache);
  return { base: "private", grants: grant === null ? [] : [grant] };
}

/**
 * The visibility a rule names for this row: an override that reaches it (`overrideFor`, the nearest
 * setting), else a folder rule whose prefix is exactly this path. A move writes its carry rule under the
 * name a note lands at, so a file can be named by a folder rule; `effectiveVisibility` reads it the same way.
 */
function visibilityOfRow(row: Doc<"nodes">, rules: Rules): Visibility | undefined {
  return overrideFor(rules.overrides, row.path) ?? rules.folders.get(row.path);
}

function grantKey(grant: { granteeKind: string; granteeUserId?: string; granteeGroupId?: string; granteeEmail?: string }): string {
  return `${grant.granteeKind}:${grant.granteeUserId ?? grant.granteeGroupId ?? grant.granteeEmail ?? ""}`;
}

/** Make the derived grants on one row exactly `grants`. Share grants on the row are left as they are. */
async function syncGrants(ctx: MutationCtx, workspaceId: Id<"workspaces">, nodeId: Id<"nodes">, grants: Grant[]): Promise<void> {
  const existing = await ctx.db
    .query("nodeAccess")
    .withIndex("by_node", (q) => q.eq("nodeId", nodeId))
    .collect();
  const derived = existing.filter((row) => row.source === ACCESS_SOURCE);
  const want = grants.map((grant) => (grant.kind === "user" ? `user:${grant.userId}` : `group:${grant.groupId}`)).sort();
  const have = derived.map(grantKey).sort();
  if (want.length === have.length && want.every((key, index) => key === have[index])) return;
  for (const row of derived) await ctx.db.delete(row._id);
  const at = Date.now();
  for (const grant of grants) {
    await ctx.db.insert("nodeAccess", {
      workspaceId,
      nodeId,
      granteeKind: grant.kind,
      granteeUserId: grant.kind === "user" ? grant.userId : undefined,
      granteeGroupId: grant.kind === "group" ? grant.groupId : undefined,
      role: "view",
      at,
      source: ACCESS_SOURCE,
    });
  }
}

/**
 * The snapshot a finished derivation leaves: every row that carries a setting or a grant. Read after the
 * walk's writes, so it sees this derivation's rows. `undefined` when it is too large to store.
 */
export async function snapshotOf(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<AccessRow[] | undefined> {
  const rows = await scanAccessRows(ctx, workspaceId);
  const bytes = JSON.stringify(rows).length;
  if (rows.length > SNAPSHOT_MAX_ROWS || bytes > SNAPSHOT_MAX_BYTES) {
    console.log(JSON.stringify({ event: "access.snapshot_too_large", workspaceId, count: rows.length }));
    return undefined;
  }
  return rows;
}

/**
 * Drop the snapshot while a walk runs. Its rows are being rewritten page by page, so a snapshot left from
 * before would name paths the rows no longer hold; readers scan until the walk finishes and rebuilds it.
 */
async function clearSnapshot(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<void> {
  const state = await ctx.db
    .query("nodeAccessState")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  if (state !== null && state.snapshot !== undefined) await ctx.db.patch(state._id, { snapshot: undefined });
}

/**
 * Rebuild the snapshot from the rows as they are, and bump the version. The rows mode's refresh (and the
 * owner's own writes): nothing is derived from the rules, so an owner's list is never clobbered.
 */
export async function refreshSnapshot(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<number> {
  const state = await ctx.db
    .query("nodeAccessState")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  const snapshot = await snapshotOf(ctx, workspaceId);
  const version = (state?.version ?? 0) + 1;
  if (state === null) await ctx.db.insert("nodeAccessState", { workspaceId, version, orphans: [], snapshot });
  else await ctx.db.patch(state._id, { version, snapshot });
  return version;
}

/** The orphans of these rules, the snapshot of the rows, and the version bump that closes a finished walk. */
async function finishDerivation(ctx: MutationCtx, workspaceId: Id<"workspaces">, rules: Rules): Promise<void> {
  const cache: Cache = new Map();
  const orphans: Orphan[] = [];
  for (const path of rules.overrides.keys()) {
    if ((await rowAt(ctx, workspaceId, path)) === null) orphans.push({ kind: "override", path });
  }
  for (const [prefix, visibility] of rules.folders) {
    // No row at all: a folder the bucket does not hold. Nothing is made for it (an empty row would show in the tree).
    if ((await rowAt(ctx, workspaceId, prefix)) === null) orphans.push({ kind: "folder", path: prefix, visibility });
    if (isGroupScope(visibility) && (await resolveHandle(ctx, workspaceId, visibility, cache)) === null) {
      orphans.push({ kind: "unresolved", path: prefix, handle: visibility });
    }
  }
  for (const [path, visibility] of rules.overrides) {
    if (isGroupScope(visibility) && (await resolveHandle(ctx, workspaceId, visibility, cache)) === null) {
      orphans.push({ kind: "unresolved", path, handle: visibility });
    }
  }
  const state = await ctx.db
    .query("nodeAccessState")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  const snapshot = await snapshotOf(ctx, workspaceId);
  const fields = {
    version: (state?.version ?? 0) + 1,
    migratedFromEtag: rules.etag,
    migratedAt: Date.now(),
    orphans,
    snapshot,
  };
  if (state === null) await ctx.db.insert("nodeAccessState", { workspaceId, ...fields });
  else await ctx.db.patch(state._id, fields);
}

/**
 * A row an owner (or a share) has already decided: a base of its own, or a grant made by hand. `onlyUnset`
 * derivation leaves these as they are.
 */
async function ownerDecided(ctx: MutationCtx, row: Doc<"nodes">): Promise<boolean> {
  if (row.access !== undefined) return true;
  const grants = await ctx.db
    .query("nodeAccess")
    .withIndex("by_node", (q) => q.eq("nodeId", row._id))
    .collect();
  return grants.some((grant) => grant.source !== ACCESS_SOURCE);
}

/**
 * One page of the derivation: the rows after `after` (`null` for the first
 * page), at most `pageSize` of them. Rules are read afresh on each page, so a
 * walk that spans a rules change finishes on the newer rules. `onlyUnset` leaves
 * the rows an owner has decided (`ownerDecided`) as they are.
 */
export async function deriveAccessPage(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  options: { after: string | null; pageSize?: number; onlyUnset?: boolean },
): Promise<DerivePage> {
  const size = options.pageSize ?? DERIVE_PAGE;
  const after = options.after;
  if (after === null) await clearSnapshot(ctx, workspaceId);
  const rules = await rulesOf(ctx, workspaceId);
  const cache: Cache = new Map();
  const rows = await ctx.db
    .query("nodes")
    .withIndex("by_workspace_path", (q) =>
      after === null ? q.eq("workspaceId", workspaceId) : q.eq("workspaceId", workspaceId).gt("path", after),
    )
    .take(size);
  for (const row of rows) {
    if (options.onlyUnset === true && (await ownerDecided(ctx, row))) continue;
    const desired = await desiredFor(ctx, workspaceId, visibilityOfRow(row, rules), cache);
    const base = desired === null ? undefined : desired.base;
    if (row.access?.base !== base) {
      await ctx.db.patch(row._id, { access: desired === null ? undefined : { base: desired.base } });
    }
    if (row.access !== undefined || desired !== null) {
      await syncGrants(ctx, workspaceId, row._id, desired === null ? [] : desired.grants);
    }
  }
  const done = rows.length < size;
  const next = rows.length > 0 ? rows[rows.length - 1].path : after;
  if (done) await finishDerivation(ctx, workspaceId, rules);
  return { next, done };
}

/** The whole derivation in one call: every page, then the version bump. */
export async function deriveAccess(ctx: MutationCtx, workspaceId: Id<"workspaces">, options: { onlyUnset?: boolean } = {}): Promise<void> {
  let after: string | null = null;
  for (;;) {
    const step = await deriveAccessPage(ctx, workspaceId, { after, onlyUnset: options.onlyUnset });
    if (step.done) return;
    after = step.next;
  }
}

/**
 * Derive a workspace's rows now: in this transaction for a small tree, or by a
 * chain of scheduled pages (`nodesPrivacy.backfillAccessPage`) for a large one,
 * so the caller never reads a whole big tree in one go.
 */
export async function backfillAccess(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<void> {
  const tree = await ctx.db
    .query("nodeTrees")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  if ((tree?.files ?? 0) > INLINE_DERIVE_MAX_FILES) {
    await ctx.scheduler.runAfter(0, internal.functions.nodesPrivacy.backfillAccessPage, { workspaceId, after: null });
    return;
  }
  await deriveAccess(ctx, workspaceId);
}

/**
 * The dual write: called in the same mutation that writes the rules or moves
 * rows. Does nothing unless the deployment's switch is `shadow` or `rows`, so
 * a deployment that has not turned access on pays one read here and nothing else.
 */
export async function refreshAccess(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<void> {
  const source = await accessSourceOf(ctx.db);
  // In `rows` the rows are the truth: nothing is derived from the rules (that would clobber an owner's list).
  // The snapshot is rebuilt from the rows as they are, so a move's new paths are what readers see.
  if (source === "rows") {
    await refreshSnapshot(ctx, workspaceId);
    return;
  }
  if (!accessDerived(source)) return;
  await backfillAccess(ctx, workspaceId);
}
