/**
 * Every write a mutation makes to a workspace's tree rows or their access, noticed where it happens.
 *
 * A workspace whose notes live in its object (`workspaceObjectHomes.home === "object"`) is judged there: the
 * object holds a copy of its rows and access rules and decides every read by them
 * (`docs/decisions/storage-and-credentials/workspace-objects.md`). Convex still takes the writes, from 30-odd
 * places, and a query or mutation cannot call the object. So no writer is trusted to remember to tell it: every
 * mutation's database is wrapped (`./mutations.ts`), each write to `nodes`, `nodeAccess` or `nodeAccessState` is
 * recorded here, and when the mutation's handler returns, one outbox entry per object-mode workspace it touched is
 * written in the same transaction and a push to the object is scheduled (`../../workspaceObjectPush.ts`). A write
 * that rolls back takes its entry with it.
 *
 * A CI test (`__tests__/rowWatchGuard.test.ts`) refuses any file that builds a mutation from `_generated/server`
 * directly, so a new writer cannot step around this.
 */

import type { GenericId } from "convex/values";
import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { ACCESS_TABLES, mayMatter, type AccessSource, type AccessWrite } from "../accessHandOff/record";

/** The tables whose writes change what a workspace object must hold. */
export const WATCHED_TABLES = ["nodes", "nodeAccess", "nodeAccessState"] as const;
type Watched = (typeof WATCHED_TABLES)[number];

/**
 * The tables a workspace's storage binding is made of: the bucket and its credential, managed encryption, the data keys and their rotations, and where
 * the notes live. A write to one clears the binding the workspace's object keeps (`apps/mcp/src/workspaceStore/
 * bindingRows.js`), so a request never opens a store from a binding older than the change.
 */
export const BINDING_TABLES = ["storageBindings", "managedEncryptionWorkspaces", "workspaceObjectHomes", "workspaceDataKeys", "workspaceKeyRotations"] as const;
type BindingTable = (typeof BINDING_TABLES)[number];
/** Fields of a binding row that no request's store is built from. */
const BINDING_QUIET = new Set(["scaffoldQueuedAt", "leftBehind"]);

/** Fields of a `nodes` row that only say which version of the bytes it is at: no rule changes with them. */
const BYTES_ONLY = new Set(["etag", "size", "uploaded", "observedAt", "objectAt", "idCopy", "keyedFrom", "storageKey", "noteId"]);

/**
 * Fields of a `nodes` row that place it or decide who sees it: a patch naming one may narrow. Everything else on the
 * row (its bytes' version, parsed facts, order, chaos flag) never hides anything from anyone. `sealed` is a parsed
 * fact too (the note's text could not be read, so it keeps no props or links: `lib/nodes/facts.ts` `writeFacts`), not
 * the sealed chat homes, which are a rule (`lib/nodes/sealedChats.ts`); the object's row does not carry it.
 */
const PLACES_OR_JUDGES = new Set(["workspaceId", "path", "parentId", "name", "kind", "goneAt", "access", "role", "archiveOf"]);

/** What one workspace's writes in this mutation amount to. */
export type WorkspaceChange = {
  /** `nodes` rows written: pushed as they stand when the push reads them, or removed if gone. */
  nodeIds: Set<Id<"nodes">>;
  /** Whether the access rules may have changed, so the push renders and sends them. */
  access: boolean;
  /**
   * Whether the write may narrow what someone sees: an access row written, or a row changed beyond its bytes,
   * replaced or deleted. A new row never narrows. Such a write opens a mark in the object first (`./objectFirst.ts`).
   */
  narrows: boolean;
  /** Whether the storage binding may have changed, so the object's kept copy is cleared. */
  binding: boolean;
  /** `nodes` rows inserted by this mutation: nobody saw them before it, so setting them up narrows nothing. */
  born: Set<string>;
  /** Their paths, as inserted. */
  bornPaths: Set<string>;
};

export type RowWatch = {
  db: MutationCtx["db"];
  changes: Map<Id<"workspaces">, WorkspaceChange>;
  /** Writes to who may reach what (`../accessHandOff/record.ts`), for `../accessHandOff/flush.ts`. */
  accessWrites: AccessWrite[];
};

function tableOf(db: MutationCtx["db"], id: string): Watched | null {
  for (const table of WATCHED_TABLES) {
    if (db.normalizeId(table, id) !== null) return table;
  }
  return null;
}

function accessTableOf(db: MutationCtx["db"], id: string): AccessSource | null {
  for (const table of ACCESS_TABLES) {
    if (db.normalizeId(table, id) !== null) return table;
  }
  return null;
}

function changeFor(changes: Map<Id<"workspaces">, WorkspaceChange>, workspaceId: Id<"workspaces">): WorkspaceChange {
  let change = changes.get(workspaceId);
  if (change === undefined) {
    change = { nodeIds: new Set(), access: false, narrows: false, binding: false, born: new Set(), bornPaths: new Set() };
    changes.set(workspaceId, change);
  }
  return change;
}

type Doc = Record<string, unknown> & { workspaceId?: Id<"workspaces"> };

function bindingTableOf(db: MutationCtx["db"], id: string): BindingTable | null {
  for (const table of BINDING_TABLES) {
    if (db.normalizeId(table, id) !== null) return table;
  }
  return null;
}

/** Record a write to a binding table; `fields` as `record` takes them. */
function recordBinding(changes: Map<Id<"workspaces">, WorkspaceChange>, doc: Doc | null, fields: string[] | null): void {
  const workspaceId = doc?.workspaceId;
  if (typeof workspaceId !== "string") return;
  if (fields !== null && fields.every((field) => BINDING_QUIET.has(field))) return;
  changeFor(changes, workspaceId).binding = true;
}

/**
 * Record one write. `fields` is what a patch named (`null` for an insert, a replace or a delete, which may change
 * anything). A row with no workspace is not a workspace's and is ignored.
 */
function record(
  changes: Map<Id<"workspaces">, WorkspaceChange>,
  table: Watched,
  id: string,
  doc: Doc | null,
  fields: string[] | null,
  op: "insert" | "patch" | "replace" | "delete",
  before: Doc | null = null,
): void {
  const workspaceId = doc?.workspaceId;
  if (typeof workspaceId !== "string") return;
  const change = changeFor(changes, workspaceId);
  if (table === "nodeAccess" || table === "nodeAccessState") {
    change.access = true;
    if (!(table === "nodeAccessState" && op === "patch" && pendingLanded(change, before, doc, fields))) change.narrows = true;
    return;
  }
  const nodeId = id as Id<"nodes">;
  change.nodeIds.add(nodeId);
  if (op === "insert") {
    change.born.add(id);
    if (typeof doc?.path === "string") change.bornPaths.add(doc.path);
  }
  // A row born in this mutation, set up after its insert (the access asked for it before it existed:
  // `lib/nodes/pendingAccess.ts`), was seen by nobody before it.
  if (op === "patch" && change.born.has(id)) {
    if (fields === null || fields.some((field) => !BYTES_ONLY.has(field))) change.access = true;
    return;
  }
  // A folder whose path changed is pushed as one row; the object rewrites everything under it (`ws.rows.put`).
  // Rules are keyed by path and carry each row's own access, so anything but a bytes-only patch may change them.
  if (fields === null || fields.some((field) => !BYTES_ONLY.has(field))) change.access = true;
  if (op === "delete" || op === "replace" || (op === "patch" && (fields === null || fields.some((field) => PLACES_OR_JUDGES.has(field))))) {
    if (!bringsBackOrClears(doc, fields, op)) change.narrows = true;
  }
}

/** One entry of a workspace's access snapshot, as far as this check reads it. */
type SnapshotEntry = { path: string };

/**
 * Whether a patch of `nodeAccessState` is only a row born in this mutation taking the access asked for it before it
 * existed (`lib/nodes/pendingAccess.ts` `applyPendingAccess`): `pending` loses entries and `snapshot` gains entries
 * for born rows' paths, nothing else. A private pending entry already closed its path for every reader
 * (`withPendingPrivate`), and a born row was seen by nobody, so this hides nothing. Any other change, the version
 * included, is a narrowing as before.
 */
function pendingLanded(change: WorkspaceChange, before: Doc | null, after: Doc | null, fields: string[] | null): boolean {
  if (before === null || after === null || fields === null || change.born.size === 0) return false;
  if (!fields.every((field) => field === "pending" || field === "snapshot")) return false;
  const pendingBefore = (before.pending ?? []) as unknown[];
  const pendingAfter = (after.pending ?? []) as unknown[];
  if (!pendingAfter.every((entry) => pendingBefore.some((was) => JSON.stringify(was) === JSON.stringify(entry)))) return false;
  const snapBefore = before.snapshot as SnapshotEntry[] | undefined;
  const snapAfter = after.snapshot as SnapshotEntry[] | undefined;
  // Grown past its cap, the snapshot is dropped and readers scan the rows, which hold the same rules.
  if (snapAfter === undefined) return true;
  if (snapBefore === undefined || snapAfter.length < snapBefore.length) return false;
  if (!snapBefore.every((entry, index) => JSON.stringify(entry) === JSON.stringify(snapAfter[index]))) return false;
  return snapAfter.slice(snapBefore.length).every((entry) => change.bornPaths.has(entry.path));
}

/**
 * The two writes of a new note's path (`lib/nodes/observeRows.ts`) that touch a placing field and hide nothing:
 * a gone row brought back where it was (its `goneAt` cleared and no other place or rule named), and a tombstone
 * folder that names no rule removed. A gone row is seen by nobody, and a folder is gone only while nothing live is
 * under it, so bringing one back or clearing one away takes nothing from anyone. A tombstone that carries a rule
 * (`access`) still judges, and its removal stays a narrowing.
 */
function bringsBackOrClears(doc: Doc | null, fields: string[] | null, op: "insert" | "patch" | "replace" | "delete"): boolean {
  if (doc === null) return false;
  if (op === "delete") return doc.goneAt !== undefined && doc.access === undefined;
  if (op !== "patch" || fields === null || doc.goneAt !== undefined) return false;
  return fields.includes("goneAt") && fields.every((field) => field === "goneAt" || !PLACES_OR_JUDGES.has(field));
}

/**
 * The mutation's database, with every write to a watched table recorded in `changes`. Reads, `system`, and writes
 * to any other table pass straight through.
 */
export function watchDb(db: MutationCtx["db"]): RowWatch {
  const changes = new Map<Id<"workspaces">, WorkspaceChange>();
  const accessWrites: AccessWrite[] = [];
  const watched = Object.create(db) as MutationCtx["db"];
  const noteAccess = (table: AccessSource, id: string, doc: unknown, op: AccessWrite["op"]) => {
    if (doc !== null && typeof doc === "object") accessWrites.push({ table, id, op, doc: doc as Record<string, unknown> });
  };
  // Before and after: a patch that moves a row to another person or workspace changes both.
  const accessBefore = async (id: string, fields: string[] | null) => {
    const table = accessTableOf(db, id);
    if (table === null || !mayMatter(table, fields)) return null;
    noteAccess(table, id, await db.get(id as GenericId<AccessSource>), "before");
    return table;
  };

  // Both of Convex's call shapes: `(table, id, value)` and `(id, value)`.
  const split = (args: unknown[]): { id: string; rest: unknown[] } =>
    args.length >= 3 || (args.length === 2 && typeof args[1] === "string")
      ? { id: args[1] as string, rest: args.slice(2) }
      : { id: args[0] as string, rest: args.slice(1) };

  Object.assign(watched, {
    async insert(table: string, value: Doc) {
      const id = await (db.insert as (table: string, value: unknown) => Promise<GenericId<string>>)(table, value);
      if ((WATCHED_TABLES as readonly string[]).includes(table)) record(changes, table as Watched, id, value, null, "insert");
      if ((BINDING_TABLES as readonly string[]).includes(table)) recordBinding(changes, value, null);
      if ((ACCESS_TABLES as readonly string[]).includes(table)) noteAccess(table as AccessSource, String(id), value, "insert");
      return id;
    },
    async patch(...args: unknown[]) {
      const { id, rest } = split(args);
      const value = rest[0];
      const fields = value !== null && typeof value === "object" ? Object.keys(value) : null;
      const access = await accessBefore(id, fields);
      const stateBefore = db.normalizeId("nodeAccessState", id) === null ? null : ((await db.get(id as GenericId<"nodeAccessState">)) as Doc | null);
      await (db.patch as (...a: unknown[]) => Promise<void>)(...args);
      if (access !== null) noteAccess(access, id, await db.get(id as GenericId<AccessSource>), "after");
      if (bindingTableOf(db, id) !== null) recordBinding(changes, (await db.get(id as GenericId<BindingTable>)) as Doc | null, fields);
      const table = tableOf(db, id);
      if (table === null) return;
      record(changes, table, id, (await db.get(id as GenericId<Watched>)) as Doc | null, fields, "patch", stateBefore);
    },
    async replace(...args: unknown[]) {
      const { id } = split(args);
      const access = await accessBefore(id, null);
      const bindingBefore = bindingTableOf(db, id) === null ? null : ((await db.get(id as GenericId<BindingTable>)) as Doc | null);
      await (db.replace as (...a: unknown[]) => Promise<void>)(...args);
      if (access !== null) noteAccess(access, id, await db.get(id as GenericId<AccessSource>), "after");
      // Before and after: a replace that moves a binding to another workspace changes both.
      if (bindingBefore !== null) {
        recordBinding(changes, bindingBefore, null);
        recordBinding(changes, (await db.get(id as GenericId<BindingTable>)) as Doc | null, null);
      }
      const table = tableOf(db, id);
      if (table === null) return;
      record(changes, table, id, (await db.get(id as GenericId<Watched>)) as Doc | null, null, "replace");
    },
    async delete(...args: unknown[]) {
      const { id } = split(args);
      const table = tableOf(db, id);
      // Read before it goes: the workspace, and the access row's note, are on the row.
      const before = table === null ? null : ((await db.get(id as GenericId<Watched>)) as Doc | null);
      const bindingBefore = bindingTableOf(db, id) === null ? null : ((await db.get(id as GenericId<BindingTable>)) as Doc | null);
      await accessBefore(id, null);
      await (db.delete as (...a: unknown[]) => Promise<void>)(...args);
      if (table !== null) record(changes, table, id, before, null, "delete");
      if (bindingBefore !== null) recordBinding(changes, bindingBefore, null);
    },
    // `db.table(name)`'s writers go through the same four, so its shape is no way around them.
    table(name: string) {
      const inner = (db as unknown as { table: (name: string) => object }).table(name);
      const self = watched as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
      return Object.assign(Object.create(inner), {
        insert: (value: unknown) => self.insert(name, value),
        patch: (id: string, value: unknown) => self.patch(name, id, value),
        replace: (id: string, value: unknown) => self.replace(name, id, value),
        delete: (id: string) => self.delete(name, id),
      });
    },
  });
  return { db: watched, changes, accessWrites };
}
