/**
 * Live rows that share one noteId (`functions/noteIds.ts`: `sharedIdReport`,
 * `repairSharedIds`, and the internal page `repairSharedIdsPage`).
 *
 * What is proved:
 *  - the report finds a pair and a triple, reads every page of a large
 *    workspace, and ignores trashed rows, plumbing rows and folders;
 *  - the repair keeps the id on the row whose copy is fresh (not the newest, not
 *    simply the oldest), gives each other row a new id, clears its copy record,
 *    and carries the id change into the access snapshot; a second run changes nothing;
 *  - another workspace's rows are untouched, and a stranger is refused by both
 *    public functions with nothing scheduled;
 *  - in a keyed workspace a group whose re-id'd row sits at the shared key is
 *    reported as needing a look, with every path in it, and left untouched;
 *  - a copy page still in flight when the id changes cannot mark the new id's
 *    copy as made (`recordCopyPage` checks the key the page copied to).
 *
 * Sabotage (temporary local edit, reverted): keeping the newest row instead of
 * the fresh copy in `keeperOf` fails "keeps the id on the row whose copy is fresh".
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { ADMIN_EMAILS_ENV_VAR } from "../../functions/lib/admin";
import { idKeyFor, newNoteId } from "../../functions/lib/nodes/noteIds";
import { recordCopyPage } from "../../functions/lib/noteIds/copyRecord";
import { ADMIN, boundWorkspace, tester, user, type T } from "./noteIds.helpers";
import { withSession } from "../session.helpers";

let previous: string | undefined;
beforeEach(() => {
  previous = process.env[ADMIN_EMAILS_ENV_VAR];
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
});
afterEach(() => {
  if (previous === undefined) delete process.env[ADMIN_EMAILS_ENV_VAR];
  else process.env[ADMIN_EMAILS_ENV_VAR] = previous;
});

const PAIR = "0190a000-0000-7000-8000-00000000aaaa";
const TRIPLE = "0190a000-0000-7000-8000-00000000bbbb";
const LONE = "0190a000-0000-7000-8000-00000000cccc";
const OTHER = "0190a000-0000-7000-8000-00000000dddd";

type Fields = {
  noteId?: string;
  etag?: string;
  goneAt?: number;
  storageKey?: string;
  idCopy?: { key: string; etag: string; copiedAt: number; keyEtag?: string };
};

/** Insert a file (or folder) row directly. Creation order is insertion order. */
async function row(t: T, workspaceId: Id<"workspaces">, path: string, fields: Fields = {}, kind: "file" | "folder" = "file") {
  return await t.run((ctx) =>
    ctx.db.insert("nodes", {
      workspaceId,
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
      kind,
      observedAt: 1,
      etag: `e-${path}`,
      ...fields,
    }),
  );
}

/** A copy record that is fresh for the etag given and for its own id key. */
function freshCopy(noteId: string, path: string, etag: string) {
  return { key: idKeyFor(noteId, path), etag, copiedAt: 1, keyEtag: "key-etag" };
}

async function staffIdentity(t: T) {
  return withSession(t, await user(t, ADMIN));
}

type Group = { noteId: string; paths: string[]; needsLook: boolean; copies: string[] };
type ReportPage = {
  groups: { noteId: string; needsLook: boolean; rows: { path: string; copy: string }[] }[];
  next: string | null;
};

/** Every page of the report, flattened, each group's paths sorted. */
async function allGroups(t: T, workspaceId: Id<"workspaces">): Promise<Group[]> {
  const staff = await staffIdentity(t);
  const out: Group[] = [];
  let after: string | undefined = undefined;
  for (let guard = 0; guard < 200; guard += 1) {
    const page: ReportPage = await staff.query(api.functions.noteIds.sharedIdReport, { workspaceId, after });
    for (const group of page.groups) {
      out.push({
        noteId: group.noteId,
        paths: group.rows.map((r) => r.path).sort(),
        needsLook: group.needsLook,
        copies: group.rows.map((r) => r.copy),
      });
    }
    if (page.next === null) return out;
    after = page.next;
  }
  throw new Error("the report did not end");
}

/** Every row of a workspace, by path. */
async function rowsOf(t: T, workspaceId: Id<"workspaces">): Promise<Record<string, Doc<"nodes">>> {
  return await t.run(async (ctx) => {
    const rows = (await ctx.db.query("nodes").collect()).filter((r) => r.workspaceId === workspaceId);
    return Object.fromEntries(rows.map((r) => [r.path, r]));
  });
}

/** Staff starts the repair; every page it schedules runs until none is left. */
async function repair(t: T, workspaceId: Id<"workspaces">) {
  const staff = await staffIdentity(t);
  await staff.mutation(api.functions.noteIds.repairSharedIds, { workspaceId });
  await t.finishAllScheduledFunctions(() => {}, 200);
}

describe("sharedIdReport: finding the groups", () => {
  test("finds a pair and a triple, and ignores trashed rows, plumbing and folders", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "alpha");
    await row(t, ws, "1-projects/a.md", { noteId: PAIR });
    await row(t, ws, "1-projects/b.md", { noteId: PAIR });
    await row(t, ws, "2-areas/x.md", { noteId: TRIPLE });
    await row(t, ws, "2-areas/y.md", { noteId: TRIPLE });
    await row(t, ws, "2-areas/z.md", { noteId: TRIPLE });
    // Trashed holders of PAIR do not make it a triple.
    await row(t, ws, "3-resources/gone.md", { noteId: PAIR, goneAt: 6 });
    // A plumbing row beside the one live note with LONE's id is not a second holder.
    await row(t, ws, "1-projects/q.md", { noteId: LONE });
    await row(t, ws, ".context/q-copy.md", { noteId: LONE });
    // A folder sharing an id with a file is not a file group.
    await row(t, ws, "1-projects", { noteId: OTHER }, "folder");
    await row(t, ws, "1-projects/o.md", { noteId: OTHER });

    expect(await allGroups(t, ws)).toEqual([
      { noteId: PAIR, paths: ["1-projects/a.md", "1-projects/b.md"], needsLook: false, copies: ["none", "none"] },
      { noteId: TRIPLE, paths: ["2-areas/x.md", "2-areas/y.md", "2-areas/z.md"], needsLook: false, copies: ["none", "none", "none"] },
    ]);
  });

  test("reports each row's copy as fresh, stale or none", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "beta");
    await row(t, ws, "a.md", { noteId: PAIR, etag: "v2", idCopy: freshCopy(PAIR, "a.md", "v2") });
    await row(t, ws, "b.md", { noteId: PAIR, etag: "v2", idCopy: freshCopy(PAIR, "b.md", "v1") });
    expect(await allGroups(t, ws)).toEqual([{ noteId: PAIR, paths: ["a.md", "b.md"], needsLook: false, copies: ["fresh", "stale"] }]);
  });

  test("reads every page of a large workspace and finds groups past the first page", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "gamma");
    for (let i = 0; i < 1100; i += 1) {
      await row(t, ws, `bulk/${i}.md`, { noteId: `0190b000-0000-7000-8000-${String(i).padStart(12, "0")}` });
    }
    const late = ["0190f000-0000-7000-8000-000000000001", "0190f000-0000-7000-8000-000000000002"];
    for (const id of late) {
      await row(t, ws, `late/${id}-1.md`, { noteId: id });
      await row(t, ws, `late/${id}-2.md`, { noteId: id });
    }
    const groups = await allGroups(t, ws);
    expect(groups.map((group) => group.noteId)).toEqual(late);
    expect(groups.every((group) => group.paths.length === 2)).toBe(true);
  });

  test("another workspace's rows are never listed, and a stranger is refused", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "delta");
    const other = await boundWorkspace(t, "epsilon");
    await row(t, other, "p.md", { noteId: PAIR });
    await row(t, other, "q.md", { noteId: PAIR });
    expect(await allGroups(t, ws)).toEqual([]);
    const stranger = withSession(t, await user(t, "someone@example.com"));
    await expect(stranger.query(api.functions.noteIds.sharedIdReport, { workspaceId: ws })).rejects.toThrow();
  });
});

describe("repairSharedIds: the repair", () => {
  test("keeps the id on the row whose copy is fresh, re-ids the others, and clears their copy records", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "zeta");
    // The oldest row has no copy; the newer one holds a fresh copy under PAIR's key.
    await row(t, ws, "a.md", { noteId: PAIR });
    await row(t, ws, "b.md", { noteId: PAIR, idCopy: freshCopy(PAIR, "b.md", "e-b.md") });
    await repair(t, ws);

    const rows = await rowsOf(t, ws);
    expect(rows["b.md"].noteId).toBe(PAIR);
    expect(rows["b.md"].idCopy).toMatchObject({ key: idKeyFor(PAIR, "b.md") });
    expect(rows["a.md"].noteId).not.toBe(PAIR);
    expect(rows["a.md"].noteId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(rows["a.md"].idCopy).toBeUndefined();
  });

  test("keeps the id on the fresh copy even when that row is the oldest and the newer one has no copy", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "rho");
    await row(t, ws, "old.md", { noteId: PAIR, idCopy: freshCopy(PAIR, "old.md", "e-old.md") });
    await row(t, ws, "new.md", { noteId: PAIR });
    await repair(t, ws);
    const rows = await rowsOf(t, ws);
    expect(rows["old.md"].noteId).toBe(PAIR);
    expect(rows["new.md"].noteId).not.toBe(PAIR);
    expect(rows["new.md"].idCopy).toBeUndefined();
  });

  test("a triple with no fresh copy keeps the oldest row's id and re-ids the other two, all distinct", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "eta");
    await row(t, ws, "x.md", { noteId: TRIPLE });
    await row(t, ws, "y.md", { noteId: TRIPLE });
    await row(t, ws, "z.md", { noteId: TRIPLE });
    await repair(t, ws);
    const rows = await rowsOf(t, ws);
    expect(rows["x.md"].noteId).toBe(TRIPLE);
    expect(new Set([TRIPLE, rows["y.md"].noteId, rows["z.md"].noteId]).size).toBe(3);
    expect(await allGroups(t, ws)).toEqual([]);
  });

  test("a second run changes nothing", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "theta");
    await row(t, ws, "a.md", { noteId: PAIR });
    await row(t, ws, "b.md", { noteId: PAIR });
    await repair(t, ws);
    const ids = async () => Object.fromEntries(Object.entries(await rowsOf(t, ws)).map(([path, r]) => [path, r.noteId]));
    const first = await ids();
    await repair(t, ws);
    expect(await ids()).toEqual(first);
  });

  test("the access snapshot follows the id change for the row it names", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "iota");
    await row(t, ws, "a.md", { noteId: PAIR });
    await row(t, ws, "b.md", { noteId: PAIR, idCopy: freshCopy(PAIR, "b.md", "e-b.md") });
    await t.run((ctx) =>
      ctx.db.insert("nodeAccessState", {
        workspaceId: ws,
        version: 1,
        orphans: [],
        snapshot: [
          { path: "a.md", noteId: PAIR, kind: "file", grantees: [] },
          { path: "b.md", noteId: PAIR, kind: "file", grantees: [] },
        ],
      }),
    );
    await repair(t, ws);
    const rows = await rowsOf(t, ws);
    const state: { snapshot?: { path: string; noteId: string }[] } | undefined = await t.run(async (ctx) =>
      (await ctx.db.query("nodeAccessState").collect()).find((s) => s.workspaceId === ws),
    );
    const snapshot = state?.snapshot ?? [];
    expect(snapshot.find((entry) => entry.path === "a.md")?.noteId).toBe(rows["a.md"].noteId);
    expect(snapshot.find((entry) => entry.path === "b.md")?.noteId).toBe(PAIR);
  });

  test("another workspace's rows with the same id are untouched", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "kappa");
    const other = await boundWorkspace(t, "lambda");
    await row(t, ws, "a.md", { noteId: PAIR });
    await row(t, ws, "b.md", { noteId: PAIR });
    await row(t, other, "p.md", { noteId: PAIR });
    await row(t, other, "q.md", { noteId: PAIR });
    await repair(t, ws);
    const theirs = await rowsOf(t, other);
    expect(theirs["p.md"].noteId).toBe(PAIR);
    expect(theirs["q.md"].noteId).toBe(PAIR);
    expect(theirs["p.md"].idCopy).toBeUndefined();
  });

  test("a stranger is refused, and nothing is scheduled", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "mu");
    await row(t, ws, "a.md", { noteId: PAIR });
    await row(t, ws, "b.md", { noteId: PAIR });
    const stranger = withSession(t, await user(t, "someone@example.com"));
    await expect(stranger.mutation(api.functions.noteIds.repairSharedIds, { workspaceId: ws })).rejects.toThrow();
    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(jobs.filter((job) => job.name.endsWith("repairSharedIdsPage"))).toEqual([]);
    const rows = await rowsOf(t, ws);
    expect(rows["a.md"].noteId).toBe(PAIR);
    expect(rows["b.md"].noteId).toBe(PAIR);
  });
});

describe("repairSharedIds in a keyed workspace", () => {
  test("a group whose re-id'd row sits at the shared key needs a look, and is left untouched", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "nu");
    await t.run(async (ctx) => {
      await ctx.db.insert("noteIdLayout", { paused: false, mode: "keys", updatedAt: 1 });
      await ctx.db.insert("noteIdCopies", {
        workspaceId: ws,
        status: "done",
        runId: 1,
        files: 2,
        copied: 2,
        failed: 0,
        failures: [],
        keyedAt: 1,
        updatedAt: 1,
      });
    });
    // The keeper is the fresh copy; the newer row is keyed at the shared key, so its bytes live only there.
    await row(t, ws, "keep.md", { noteId: PAIR, idCopy: freshCopy(PAIR, "keep.md", "e-keep.md") });
    await row(t, ws, "keyed.md", { noteId: PAIR, storageKey: idKeyFor(PAIR, "keyed.md") });
    // An unrelated pair in the same workspace is repaired as usual.
    await row(t, ws, "c.md", { noteId: LONE });
    await row(t, ws, "d.md", { noteId: LONE });

    expect(await allGroups(t, ws)).toEqual([
      { noteId: PAIR, paths: ["keep.md", "keyed.md"], needsLook: true, copies: ["fresh", "keyed"] },
      { noteId: LONE, paths: ["c.md", "d.md"], needsLook: false, copies: ["none", "none"] },
    ]);

    await repair(t, ws);
    const rows = await rowsOf(t, ws);
    expect(rows["keep.md"].noteId).toBe(PAIR);
    expect(rows["keyed.md"].noteId).toBe(PAIR);
    expect(rows["keyed.md"].storageKey).toBe(idKeyFor(PAIR, "keyed.md"));
    expect(rows["c.md"].noteId).toBe(LONE);
    expect(rows["d.md"].noteId).not.toBe(LONE);
  });
});

describe("a copy page still in flight when the id changed", () => {
  test("a copy made to the old key does not mark the new key as copied", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "xi");
    const rowId = await row(t, ws, "b.md", { noteId: PAIR, etag: "v1" });
    const current = newNoteId();
    await t.run((ctx) => ctx.db.patch(rowId, { noteId: current }));
    await t.run((ctx) =>
      ctx.db.insert("noteIdCopies", { workspaceId: ws, status: "copying", runId: 1, files: 1, copied: 0, failed: 0, failures: [], updatedAt: 1 }),
    );
    const base = { workspaceId: ws, runId: 1, done: false, found: false, files: 1, fresh: 0, refused: [] };
    const copied = (key: string) => ({ path: "b.md", ok: true, etag: "v1", keyEtag: "key-etag", key });

    // The page copied the bytes to the old shared key: the row must not take that as its own copy.
    await t.run((ctx) => recordCopyPage(ctx, { ...base, results: [copied(idKeyFor(PAIR, "b.md"))] }));
    expect((await rowsOf(t, ws))["b.md"].idCopy).toBeUndefined();

    // A copy made to the row's own key is recorded.
    await t.run((ctx) => recordCopyPage(ctx, { ...base, results: [copied(idKeyFor(current, "b.md"))] }));
    expect((await rowsOf(t, ws))["b.md"].idCopy?.key).toBe(idKeyFor(current, "b.md"));
  });
});
