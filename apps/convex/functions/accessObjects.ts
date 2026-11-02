/**
 * Copying who may reach what into the objects, comparing the two, and the
 * switches that say which one decides (decided by the owner, 2026-11-01, plan
 * "Access lives in the objects": access has one copy, in the objects; Convex
 * keeps sign-in, client registration, billing and audit).
 *
 * Two scopes, each with its own switch on the workspace's record
 * (`lib/accessObjects/home.ts`) and in its object (`lib/accessObjects/door.ts`):
 * `workspace` (members and invites, in every workspace's object) and `person`
 * (reach, "shared with me" and connections, in a personal workspace's object).
 *
 * - `backfill`: run by the "Access objects backfill" workflow. Step `arm` puts
 *   every scope still at `convex` on `dual`: Convex decides and its access
 *   writers mirror every change into the objects (thread E). Step `copy` then
 *   writes every table whole (`snapshot`, `replace`), with the copy's clock as
 *   each row's `at`, so a newer mirrored change the object already took is
 *   never rolled back. A scope at `object` is never copied into: the object
 *   decides there, and Convex's copy is the older one.
 * - `parity`: run by the "Access objects parity" workflow over every scope not
 *   at `convex`: each table's `accessDigest` on both sides (the contract's one
 *   function, imported, never copied). A difference is asked again before it
 *   counts, so a change in flight is not one.
 * - `setAccess`: the switch, object first, then the record. `object` is
 *   refused unless the scope's last parity check, within the hour, matched
 *   every table. `dual` is always allowed: it is the one-step rollback (the
 *   object stops deciding; Convex, written behind meanwhile, decides again).
 *
 * Every answer is counts, never an id, a handle, an address or a hash: the
 * workflows' logs are public, and so is this repository. Internal only.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { accessDigest } from "../../mcp/src/workspaceStore/access.js";
import { consoleWorkspaceClient } from "./lib/workspaceObjects/door";
import { accessDoor, type AccessDoor, type AccessScope } from "./lib/accessObjects/door";
import { PERSON_TABLES, WORKSPACE_TABLES, type AccessTable } from "./lib/accessObjects/expected";
import type { AccessHome } from "./lib/accessObjects/home";
import { failureOf } from "./workspaceObjects";
import { accessValidator, scopeValidator } from "./accessObjectsRows";

/** Rows per snapshot call: half the contract's `MAX_ROWS_PER_CALL`. */
const SNAPSHOT_CHUNK = 1000;
/** How long one page of a run may work before it hands back its cursor. */
const PAGE_BUDGET_MS = 2 * 60 * 1000;
/** How recent a clean parity check must be for a scope to be read from its object. */
const PARITY_FRESH_MS = 60 * 60 * 1000;
/** A difference is asked again after this long: a mirrored change in flight has landed by then. */
const RECHECK_MS = 5_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Tables = Partial<Record<AccessTable, unknown[]>>;
/** One scope's expected rows, and how many Convex rows the contract could not hold. */
export interface Expected {
  tables: Tables;
  skipped: number;
}

export const TABLES_OF: Record<AccessScope, readonly AccessTable[]> = { workspace: WORKSPACE_TABLES, person: PERSON_TABLES };

/** The scopes `workspaceId`'s object holds, and its person when it has one. `null` for a workspace that is gone. */
async function scopesOf(ctx: ActionCtx, workspaceId: Id<"workspaces">): Promise<{ scopes: AccessScope[]; personId: Id<"users"> | null } | null> {
  const facts = await ctx.runQuery(internal.functions.accessObjectsRows.workspaceFacts, { workspaceId });
  if (facts === null) return null;
  return { scopes: facts.personId === null ? ["workspace"] : ["workspace", "person"], personId: facts.personId };
}

/** Everything one scope of `workspaceId`'s object should hold, read from Convex. */
export async function expectedFor(ctx: ActionCtx, workspaceId: Id<"workspaces">, scope: AccessScope, personId: Id<"users"> | null, now: number): Promise<Expected> {
  if (scope === "person") {
    if (personId === null) throw new Error("access copy: a person scope needs its person");
    const person = await ctx.runQuery(internal.functions.accessObjectsExpected.person, { userId: personId, now });
    return {
      tables: { reach: person.reach.rows, sharedToMe: person.sharedToMe.rows, connections: person.connections.rows },
      skipped: person.reach.skipped + person.sharedToMe.skipped + person.connections.skipped,
    };
  }
  const members: unknown[] = [];
  let skipped = 0;
  let cursor: string | null = null;
  for (let pages = 0; pages < 10_000; pages += 1) {
    const page: { rows: unknown[]; skipped: number; next: string | null } = await ctx.runQuery(internal.functions.accessObjectsExpected.membersPageOf, { workspaceId, cursor, now });
    members.push(...page.rows);
    skipped += page.skipped;
    if (page.next === null) break;
    cursor = page.next;
  }
  const invites = await ctx.runQuery(internal.functions.accessObjectsExpected.invites, { workspaceId, now });
  return { tables: { members, invites: invites.rows }, skipped: skipped + invites.skipped };
}

/** Writes `rows` whole into one table: chunks under one epoch, the last marked, so rows Convex no longer has are dropped. */
export async function writeTable(door: AccessDoor, table: AccessTable, rows: readonly unknown[], epoch: number): Promise<void> {
  if (rows.length === 0) {
    await door.table(table).snapshot({ epoch, rows: [], last: true, mode: "replace" });
    return;
  }
  for (let start = 0; start < rows.length; start += SNAPSHOT_CHUNK) {
    await door.table(table).snapshot({ epoch, rows: rows.slice(start, start + SNAPSHOT_CHUNK), last: start + SNAPSHOT_CHUNK >= rows.length, mode: "replace" });
  }
}

/** One table's comparison: counts on each side and whether the digests match. */
export interface TableParity {
  table: string;
  convex: number;
  object: number;
  match: boolean;
}

/** Compares one scope's tables; a table that differs is read again on both sides after `recheckMs` before it counts. */
export async function compareTables(
  scope: AccessScope,
  read: () => Promise<Expected>,
  door: AccessDoor,
  options: { recheckMs: number; wait: (ms: number) => Promise<void> },
): Promise<TableParity[]> {
  const once = async (expected: Expected, table: AccessTable): Promise<TableParity> => {
    const mine = await accessDigest(table, expected.tables[table] ?? []);
    const theirs = await door.table(table).digest();
    return { table, convex: mine.count, object: theirs.count, match: mine.count === theirs.count && mine.sha === theirs.sha };
  };
  const first = await read();
  const results: TableParity[] = [];
  for (const table of TABLES_OF[scope]) results.push(await once(first, table));
  if (results.every((result) => result.match)) return results;
  await options.wait(options.recheckMs);
  const again = await read();
  const settled: TableParity[] = [];
  for (const result of results) settled.push(result.match ? result : await once(again, result.table as AccessTable));
  return settled;
}

/** Where a run stands: the workspace page, and the workspaces left in it. */
interface RunCursor {
  page: string | null;
  queue: string[];
  exhausted: boolean;
}

async function nextWorkspace(ctx: ActionCtx, state: RunCursor): Promise<Id<"workspaces"> | null> {
  while (state.queue.length === 0) {
    if (state.exhausted) return null;
    const page = await ctx.runQuery(internal.functions.accessObjectsRows.workspacesPage, { cursor: state.page });
    state.queue = page.ids.map(String);
    state.page = page.cursor;
    state.exhausted = page.done;
  }
  return state.queue.shift() as Id<"workspaces">;
}

async function startState(ctx: ActionCtx, cursor: string | undefined, only: string | undefined): Promise<RunCursor | "NO_WORKSPACE"> {
  if (cursor) return JSON.parse(cursor) as RunCursor;
  if (only === undefined || only === "") return { page: null, queue: [], exhausted: false };
  const id = await ctx.runQuery(internal.functions.workspaceObjectsRows.workspaceBySlug, { slug: only });
  return id === null ? "NO_WORKSPACE" : { page: null, queue: [String(id)], exhausted: true };
}

/** The door for one scope: `"unreachable"` without a gateway, `"notReady"` when the object does not offer the scope yet. */
export function doorFor(ctx: ActionCtx, workspaceId: Id<"workspaces">, scope: AccessScope): AccessDoor | "unreachable" | "notReady" {
  const client = consoleWorkspaceClient(ctx, workspaceId);
  if (client === null) return "unreachable";
  return accessDoor(client, scope) ?? "notReady";
}

const homeOf = async (ctx: ActionCtx, workspaceId: Id<"workspaces">, scope: AccessScope): Promise<AccessHome> =>
  await ctx.runQuery(internal.functions.accessObjectsRows.accessOf, { workspaceId, scope });

const backfillCounts = v.object({
  workspaces: v.number(),
  /** Scopes (a workspace's members, a person) armed, already past `convex`, copied or that would be. */
  armed: v.number(),
  alreadyArmed: v.number(),
  copied: v.number(),
  wouldCopy: v.number(),
  people: v.number(),
  rows: v.number(),
  /** Convex rows the contract cannot hold (a member with no personal workspace, a grant with no scopes, a share whose note is gone). */
  skippedRows: v.number(),
  skippedObject: v.number(),
  notReady: v.number(),
  unreachable: v.number(),
  failed: v.number(),
  refused: v.optional(v.string()),
  cursor: v.string(),
  done: v.boolean(),
});

/** One page of the backfill. Counts only. `dryRun` writes nothing, the switches included. */
export const backfill = internalAction({
  args: {
    step: v.union(v.literal("arm"), v.literal("copy")),
    dryRun: v.boolean(),
    cursor: v.optional(v.string()),
    /** A handle: this workspace alone. */
    only: v.optional(v.string()),
  },
  returns: backfillCounts,
  handler: async (ctx, { step, dryRun, cursor, only }) => {
    const counts = { workspaces: 0, armed: 0, alreadyArmed: 0, copied: 0, wouldCopy: 0, people: 0, rows: 0, skippedRows: 0, skippedObject: 0, notReady: 0, unreachable: 0, failed: 0 };
    const state = await startState(ctx, cursor, only);
    if (state === "NO_WORKSPACE") return { ...counts, refused: "NO_WORKSPACE", cursor: "", done: true };
    const started = Date.now();
    while (Date.now() - started < PAGE_BUDGET_MS) {
      const workspaceId = await nextWorkspace(ctx, state);
      if (workspaceId === null) return { ...counts, cursor: "", done: true };
      const found = await scopesOf(ctx, workspaceId).catch(() => null);
      if (found === null) continue;
      counts.workspaces += 1;
      for (const scope of found.scopes) {
        try {
          const home = await homeOf(ctx, workspaceId, scope);
          if (step === "arm") {
            if (home !== "convex") counts.alreadyArmed += 1;
            else if (dryRun) counts.armed += 1;
            else {
              const result = await setAccessFor(ctx, workspaceId, scope, "dual", false);
              if (result.ok) counts.armed += 1;
              else if (result.reason === "NOT_READY") counts.notReady += 1;
              else counts.unreachable += 1;
            }
            continue;
          }
          if (home === "object") {
            counts.skippedObject += 1;
            continue;
          }
          const now = Date.now();
          const expected = await expectedFor(ctx, workspaceId, scope, found.personId, now);
          const rows = TABLES_OF[scope].reduce((sum, table) => sum + (expected.tables[table]?.length ?? 0), 0);
          if (dryRun) {
            counts.wouldCopy += 1;
          } else {
            const door = doorFor(ctx, workspaceId, scope);
            if (door === "unreachable" || door === "notReady") {
              counts[door] += 1;
              continue;
            }
            for (const table of TABLES_OF[scope]) await writeTable(door, table, expected.tables[table] ?? [], now);
            await ctx.runMutation(internal.functions.accessObjectsRows.recordAccessCopy, { workspaceId, scope, at: now });
            counts.copied += 1;
          }
          counts.rows += rows;
          counts.skippedRows += expected.skipped;
          if (scope === "person") counts.people += 1;
        } catch (error) {
          counts.failed += 1;
          console.warn(JSON.stringify({ event: "access_backfill_failed", step, scope, ...failureOf(error) }));
        }
      }
    }
    return { ...counts, cursor: JSON.stringify(state), done: false };
  },
});

const parityCounts = v.object({
  scopes: v.number(),
  clean: v.number(),
  differing: v.number(),
  notReady: v.number(),
  unreachable: v.number(),
  /** Per table: how many scopes differ there. */
  tablesDiffer: v.object({ members: v.number(), invites: v.number(), reach: v.number(), sharedToMe: v.number(), connections: v.number() }),
  refused: v.optional(v.string()),
  cursor: v.string(),
  done: v.boolean(),
});

/** One page of the parity check over every scope not at `convex` (or one workspace's, by handle). Counts only. */
export const parity = internalAction({
  args: { cursor: v.optional(v.string()), only: v.optional(v.string()) },
  returns: parityCounts,
  handler: async (ctx, { cursor, only }) => {
    const counts = { scopes: 0, clean: 0, differing: 0, notReady: 0, unreachable: 0, tablesDiffer: { members: 0, invites: 0, reach: 0, sharedToMe: 0, connections: 0 } };
    const state = await startState(ctx, cursor, only);
    if (state === "NO_WORKSPACE") return { ...counts, refused: "NO_WORKSPACE", cursor: "", done: true };
    const started = Date.now();
    while (Date.now() - started < PAGE_BUDGET_MS) {
      const workspaceId = await nextWorkspace(ctx, state);
      if (workspaceId === null) return { ...counts, cursor: "", done: true };
      const found = await scopesOf(ctx, workspaceId).catch(() => null);
      if (found === null) continue;
      for (const scope of found.scopes) {
        try {
          if ((await homeOf(ctx, workspaceId, scope)) === "convex") continue;
          counts.scopes += 1;
          const door = doorFor(ctx, workspaceId, scope);
          if (door === "unreachable" || door === "notReady") {
            counts[door] += 1;
            continue;
          }
          const tables = await compareTables(scope, async () => await expectedFor(ctx, workspaceId, scope, found.personId, Date.now()), door, { recheckMs: RECHECK_MS, wait: sleep });
          await ctx.runMutation(internal.functions.accessObjectsRows.recordAccessParity, { workspaceId, scope, parity: { at: Date.now(), tables } });
          for (const table of tables) if (!table.match) counts.tablesDiffer[table.table as AccessTable] += 1;
          if (tables.every((table) => table.match)) counts.clean += 1;
          else counts.differing += 1;
        } catch (error) {
          counts.unreachable += 1;
          console.warn(JSON.stringify({ event: "access_parity_failed", scope, ...failureOf(error) }));
        }
      }
    }
    return { ...counts, cursor: JSON.stringify(state), done: false };
  },
});

/**
 * Why a scope may not be read from its object yet, or `null` when it may: it
 * must be mirroring (`dual`), copied whole, and its last parity check within
 * the hour must have matched every table the scope holds.
 */
export function objectRefusal(
  record: { home: AccessHome; backfilledAt?: number; parity?: { at: number; tables: TableParity[] } },
  scope: AccessScope,
  now: number,
): string | null {
  if (record.home === "convex") return "NOT_ARMED";
  if (record.backfilledAt === undefined) return "NOT_BACKFILLED";
  if (record.parity === undefined || now - record.parity.at > PARITY_FRESH_MS) return "PARITY_STALE";
  const matched = new Set(record.parity.tables.filter((table) => table.match).map((table) => table.table));
  if (!TABLES_OF[scope].every((table) => matched.has(table)) || !record.parity.tables.every((table) => table.match)) return "PARITY_DIFFERS";
  return null;
}

/** The switch for one scope, object first. Answers why it refused, never an id. */
export async function setAccessFor(ctx: ActionCtx, workspaceId: Id<"workspaces">, scope: AccessScope, home: AccessHome, force: boolean): Promise<{ ok: boolean; reason?: string }> {
  const found = await scopesOf(ctx, workspaceId);
  if (found === null) return { ok: false, reason: "NO_WORKSPACE" };
  if (!found.scopes.includes(scope)) return { ok: false, reason: "NO_PERSON" };
  const door = doorFor(ctx, workspaceId, scope);
  if (door === "unreachable") return { ok: false, reason: "OBJECT_UNREACHABLE" };
  if (door === "notReady") return { ok: false, reason: "NOT_READY" };
  if (home === "object" && !force) {
    const refusal = objectRefusal(await ctx.runQuery(internal.functions.accessObjectsRows.accessRecordFor, { workspaceId, scope }), scope, Date.now());
    if (refusal !== null) return { ok: false, reason: refusal };
  }
  // The object knows only who decides: `dual` and `convex` both leave Convex deciding.
  await door.setHome(home === "object" ? "object" : "convex", found.personId === null ? null : String(found.personId));
  await ctx.runMutation(internal.functions.accessObjectsRows.recordAccess, { workspaceId, scope, home, now: Date.now() });
  return { ok: true };
}

const switchResult = v.object({ ok: v.boolean(), reason: v.optional(v.string()) });

/** The switch, by hand. `object` waits for a clean, fresh parity check unless forced. */
export const setAccess = internalAction({
  args: { workspaceId: v.id("workspaces"), scope: scopeValidator, home: accessValidator, force: v.optional(v.boolean()) },
  returns: switchResult,
  handler: async (ctx, { workspaceId, scope, home, force }) => await setAccessFor(ctx, workspaceId, scope, home, force === true),
});

/** The switch by handle, for the "Access objects switch" workflow. */
export const setAccessBySlug = internalAction({
  args: { slug: v.string(), scope: scopeValidator, home: accessValidator, force: v.optional(v.boolean()) },
  returns: switchResult,
  handler: async (ctx, { slug, scope, home, force }): Promise<{ ok: boolean; reason?: string }> => {
    const workspaceId: Id<"workspaces"> | null = await ctx.runQuery(internal.functions.workspaceObjectsRows.workspaceBySlug, { slug });
    if (workspaceId === null) return { ok: false, reason: "NO_WORKSPACE" };
    return await setAccessFor(ctx, workspaceId, scope, home, force === true);
  },
});
