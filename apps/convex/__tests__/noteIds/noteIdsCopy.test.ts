/**
 * The id copy (phase "copy" of the move from path keys to id keys): what a
 * copy is, when it is still true, and what a pass records. Run through the
 * real functions with the bucket as the memory store.
 *
 * Sabotage: make `copyIsFresh` ignore the etag and the stale-after-edit case
 * fails; drop the `runId` check in `recordCopyPage` and the restart case
 * fails; drop the `leaseHeld` guard in `claimCopyRun` and the double-claim
 * case fails.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "../../_generated/api";
import { ADMIN_EMAILS_ENV_VAR } from "../../functions/lib/admin";
import { copyIsFresh, ID_COPY_MAX_BYTES, idKeyFor, newNoteId } from "../../functions/lib/nodes/noteIds";
import { nodePath } from "../../functions/lib/nodes/table";
import { beginCopyPass, copyRowOf } from "../../functions/lib/noteIds/state";
import { runIdCopyPage } from "../../../mcp/src/moves/idCopyPage.js";
import {
  ADMIN,
  boundWorkspace,
  bucket,
  chain,
  drain,
  observeBucket,
  observeKeys,
  pass,
  rowAt,
  runPass,
  storeWithHead,
  tester,
  user,
} from "./noteIds.helpers";

let previous: string | undefined;
beforeEach(() => {
  previous = process.env[ADMIN_EMAILS_ENV_VAR];
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
  // The origin is unset: every page runs here, through the fallback.
  delete process.env.STORAGE_MOVER_ORIGIN;
});
afterEach(() => {
  if (previous === undefined) delete process.env[ADMIN_EMAILS_ENV_VAR];
  else process.env[ADMIN_EMAILS_ENV_VAR] = previous;
});

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("ids and keys", () => {
  test("a note id is a UUIDv7 whose prefix is the time it was made", () => {
    const at = Date.UTC(2026, 9, 15, 12, 0, 0);
    const id = newNoteId(at);
    expect(id).toMatch(UUID_V7);
    const millis = parseInt(id.replace(/-/g, "").slice(0, 12), 16);
    expect(millis).toBe(at);
    expect(newNoteId(at)).not.toBe(id);
  });

  test("a note's body goes to notes/, anything else to files/ with its lowercased extension", () => {
    const id = "0190c0de-0000-7000-8000-000000000001";
    expect(idKeyFor(id, "1-projects/a.md")).toBe(`notes/${id}.md`);
    expect(idKeyFor(id, "1-projects/A.MD")).toBe(`notes/${id}.md`);
    expect(idKeyFor(id, "2-areas/pic.PNG")).toBe(`files/${id}.png`);
    expect(idKeyFor(id, "2-areas/archive.tar.gz")).toBe(`files/${id}.gz`);
    expect(idKeyFor(id, "2-areas/README")).toBe(`files/${id}`);
    expect(idKeyFor(id, "2-areas/.env")).toBe(`files/${id}`);
  });

  test("a copy is fresh only while its etag is the row's etag, and only for a live file", () => {
    const row = { kind: "file" as const, goneAt: undefined, etag: "e2", idCopy: { key: "k", etag: "e1", copiedAt: 1, keyEtag: "k1" } };
    expect(copyIsFresh(row)).toBe(false);
    expect(copyIsFresh({ ...row, idCopy: { ...row.idCopy, etag: "e2" } })).toBe(true);
    expect(copyIsFresh({ ...row, idCopy: { ...row.idCopy, etag: "e2" }, goneAt: 5 })).toBe(false);
    expect(copyIsFresh({ ...row, kind: "folder", idCopy: { ...row.idCopy, etag: "e2" } })).toBe(false);
    // A record that does not name the key's version is never trusted.
    expect(copyIsFresh({ ...row, idCopy: { key: "k", etag: "e2", copiedAt: 1 } })).toBe(false);
    expect(ID_COPY_MAX_BYTES).toBe(20 * 1024 * 1024);
  });
});

describe("rows and backfill", () => {
  test("a row the tree inserts has its id from the start", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "fresh");
    await t.mutation(internal.functions.nodes.observe, {
      workspaceId: ws,
      at: 10,
      rows: [{ path: "1-projects/a.md", etag: "e1" }, { path: "1-projects/b.md", etag: "e2" }],
      gone: [],
      vanishedUnder: [],
    });
    const a = await rowAt(t, ws, "1-projects/a.md");
    const b = await rowAt(t, ws, "1-projects/b.md");
    expect(a?.noteId).toMatch(UUID_V7);
    expect(b?.noteId).toMatch(UUID_V7);
    expect(a?.noteId).not.toBe(b?.noteId);
  });

  test("the backfill gives rows that predate ids one, a batch at a time, and keeps the ones they have", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "legacy");
    const existing = await t.run(async (ctx) => {
      const now = Date.now();
      for (let index = 0; index < 510; index += 1) {
        await ctx.db.insert("nodes", {
          workspaceId: ws,
          path: `legacy/p${String(index).padStart(4, "0")}.md`,
          name: `p${String(index).padStart(4, "0")}.md`,
          kind: "file",
          etag: "e",
          observedAt: now,
        });
      }
      return await ctx.db.insert("nodes", {
        workspaceId: ws,
        path: "legacy/keeper.md",
        name: "keeper.md",
        kind: "file",
        etag: "e",
        observedAt: now,
        noteId: "0190c0de-0000-7000-8000-00000000beef",
      });
    });
    await t.mutation(internal.functions.noteIdsCopy.backfill, { workspaceId: ws });
    const missingAfterFirst = await t.run(async (ctx) =>
      (await ctx.db.query("nodes").collect()).filter((row) => row.workspaceId === ws && row.noteId === undefined).length,
    );
    // The first batch took the first 500 rows in path order: `keeper.md` and p0000 to p0498.
    expect(missingAfterFirst).toBe(11);
    await t.mutation(internal.functions.noteIdsCopy.backfill, { workspaceId: ws, after: "legacy/p0498.md" });
    const all = await t.run(async (ctx) => (await ctx.db.query("nodes").collect()).filter((row) => row.workspaceId === ws));
    expect(all.every((row) => row.noteId !== undefined)).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(existing)))?.noteId).toBe("0190c0de-0000-7000-8000-00000000beef");
  });
});

describe("the copy pass", () => {
  test("every live file is copied to its id key, and every copy is fresh afterwards", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "copied");
    const store = bucket({
      "1-projects/a.md": "# A\n",
      "2-areas/pic.png": "png-bytes",
      "1-projects/nested/B.MD": "# B\n",
    });
    await observeBucket(t, ws, store);
    const c = chain(t, ws, store);
    await runPass(c);

    const a = await rowAt(t, ws, "1-projects/a.md");
    const pic = await rowAt(t, ws, "2-areas/pic.png");
    const b = await rowAt(t, ws, "1-projects/nested/B.MD");
    expect(a?.idCopy?.key).toBe(`notes/${a?.noteId}.md`);
    expect(pic?.idCopy?.key).toBe(`files/${pic?.noteId}.png`);
    expect(b?.idCopy?.key).toBe(`notes/${b?.noteId}.md`);
    expect(new TextDecoder().decode(store.bytesOf(`notes/${a?.noteId}.md`)!)).toBe("# A\n");
    expect(new TextDecoder().decode(store.bytesOf(`files/${pic?.noteId}.png`)!)).toBe("png-bytes");
    for (const row of [a, pic, b]) expect(copyIsFresh(row!)).toBe(true);
    // The key's own etag is kept, so a save that lands on the key out of order is told apart.
    expect(a?.idCopy?.keyEtag).toBe((await store.get(`notes/${a?.noteId}.md`))?.etag);

    const state = await pass(c);
    expect(state).toMatchObject({ status: "done", files: 3, copied: 3, failed: 0, failures: [] });
  });

  test("an edit makes the copy stale, and the next pass copies it again and counts it", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "edited");
    const store = bucket({ "1-projects/a.md": "# A\n", "1-projects/b.md": "# B\n" });
    await observeKeys(t, ws, store, ["1-projects/a.md", "1-projects/b.md"]);
    const c = chain(t, ws, store);
    await runPass(c);

    store.seed("1-projects/a.md", "# A, edited\n");
    await observeKeys(t, ws, store, ["1-projects/a.md", "1-projects/b.md"], Date.now() + 1_000);
    const stale = await t.query(internal.functions.noteIdsCopy.copyPage, { workspaceId: ws, limit: 200 });
    expect(stale.items.map((item) => item.path)).toEqual(["1-projects/a.md"]);
    expect(stale.fresh).toBe(1);

    await runPass(c);
    const a = await rowAt(t, ws, "1-projects/a.md");
    expect(copyIsFresh(a!)).toBe(true);
    expect(new TextDecoder().decode(store.bytesOf(`notes/${a?.noteId}.md`)!)).toBe("# A, edited\n");
  });

  test("a row edited while its copy was in flight is not marked, and the pass goes round again", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "inflight");
    const store = bucket({ "1-projects/a.md": "# A\n" });
    await observeBucket(t, ws, store);
    const buckets = storeWithHead(store) as never;
    let copies = 0;
    const c = chain(t, ws, store, {
      copyHere: async (page) => {
        copies += 1;
        const result = await runIdCopyPage(page, { buildStore: () => buckets });
        if (copies === 1) {
          // The copy was made from the old version; the person edits the note before it is recorded.
          store.seed("1-projects/a.md", "# A, changed in flight\n");
          await observeKeys(t, ws, store, ["1-projects/a.md"], Date.now() + 1_000);
        }
        return result;
      },
    });
    await runPass(c);
    expect(copies).toBeGreaterThanOrEqual(2);
    const a = await rowAt(t, ws, "1-projects/a.md");
    expect(copyIsFresh(a!)).toBe(true);
    expect(new TextDecoder().decode(store.bytesOf(`notes/${a?.noteId}.md`)!)).toBe("# A, changed in flight\n");
  });

  test("a record whose etag no longer matches marks nothing and asks for another pass", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "record");
    const store = bucket({ "1-projects/a.md": "# A\n" });
    await observeBucket(t, ws, store);
    await t.run((ctx) => beginCopyPass(ctx, ws, { force: false }));
    const current = await t.run((ctx) => copyRowOf(ctx.db, ws));
    const step = await t.mutation(internal.functions.noteIdsCopy.recordCopy, {
      workspaceId: ws,
      runId: current!.runId,
      done: true,
      found: false,
      files: 1,
      fresh: 0,
      refused: [],
      results: [{ path: "1-projects/a.md", ok: true, etag: "not-the-etag-it-has" }],
    });
    expect(step).toEqual({ next: "restart", found: true });
    expect((await rowAt(t, ws, "1-projects/a.md"))?.idCopy).toBeUndefined();
  });

  test("a page recorded for a run that moved on changes nothing", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "oldrun");
    const store = bucket({ "1-projects/a.md": "# A\n" });
    await observeBucket(t, ws, store);
    await t.run((ctx) => beginCopyPass(ctx, ws, { force: false }));
    const oldRun = (await t.run((ctx) => copyRowOf(ctx.db, ws)))!.runId;
    await t.run((ctx) => beginCopyPass(ctx, ws, { force: true }));
    const node = await rowAt(t, ws, "1-projects/a.md");
    const step = await t.mutation(internal.functions.noteIdsCopy.recordCopy, {
      workspaceId: ws,
      runId: oldRun,
      done: true,
      found: false,
      files: 1,
      fresh: 0,
      refused: [],
      results: [{ path: "1-projects/a.md", ok: true, etag: node!.etag! }],
    });
    expect(step).toEqual({ next: "stale", found: false });
    expect((await rowAt(t, ws, "1-projects/a.md"))?.idCopy).toBeUndefined();
  });

  test("a file over the copy limit is refused as too_large without being read, and the report stays path-free", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "huge");
    const store = bucket({ "2-areas/movie.mp4": "x" });
    await t.mutation(internal.functions.nodes.observe, {
      workspaceId: ws,
      at: Date.now(),
      rows: [{ path: "2-areas/movie.mp4", etag: "big", size: ID_COPY_MAX_BYTES + 1 }],
      gone: [],
      vanishedUnder: [],
    });
    const c = chain(t, ws, store, {
      copyHere: async () => {
        throw new Error("a file over the limit must not be read");
      },
    });
    await runPass(c);
    const state = await pass(c);
    const movie = await rowAt(t, ws, "2-areas/movie.mp4");
    expect(movie?.idCopy).toBeUndefined();
    expect(state).toMatchObject({ status: "done", failed: 1, copied: 0 });
    expect(state?.failures).toEqual([{ noteId: movie?.noteId, reason: "too_large" }]);
    expect(JSON.stringify(state)).not.toContain("movie");
    // Staff see why, by id, on the report: still no path.
    const staff = t.withIdentity({ subject: await user(t, ADMIN) });
    const report = await staff.query(api.functions.noteIds.report, {});
    const row = report.workspaces.find((entry) => entry.handle === "huge");
    expect(row?.failures).toEqual([{ noteId: movie?.noteId, reason: "too_large" }]);
    expect(JSON.stringify(report)).not.toContain("movie");
  });

  test("a copy the bucket refuses is counted and listed by id, and the pass still finishes", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "refused");
    const store = bucket({ "1-projects/a.md": "# A\n", "1-projects/b.md": "# B\n" });
    await observeBucket(t, ws, store);
    const c = chain(t, ws, store, {
      copyHere: async (page) => ({
        results: page.items.map((item) =>
          item.path === "1-projects/a.md"
            ? { path: item.path, ok: false, reason: "copy_failed" }
            : { path: item.path, ok: true, etag: item.etag, copiedEtag: "key-etag" },
        ),
      }),
    });
    await runPass(c);
    const state = await pass(c);
    const a = await rowAt(t, ws, "1-projects/a.md");
    expect(state).toMatchObject({ status: "done", failed: 1, copied: 1 });
    expect(state?.failures).toEqual([{ noteId: a?.noteId, reason: "copy_failed" }]);
    expect(JSON.stringify(state)).not.toMatch(/1-projects|\.md/);
  });

  test("a page that keeps failing is shown as failed after three tries, with a fixed label", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "stuck");
    const store = bucket({ "1-projects/a.md": "# A\n" });
    await observeBucket(t, ws, store);
    const c = chain(t, ws, store, {
      copyHere: async () => {
        throw new Error("storage refused, with a provider text naming 1-projects/a.md");
      },
    });
    await t.run((ctx) => beginCopyPass(ctx, ws, { force: false }));
    const runId = (await t.run((ctx) => copyRowOf(ctx.db, ws)))!.runId;
    c.pending.push({ name: "functions/noteIdsCopy:run", args: { workspaceId: ws, runId } });
    await drain(c);
    const state = await pass(c);
    expect(state).toMatchObject({ status: "failed" });
    expect(state?.error).toMatch(/keeps failing/);
    expect(JSON.stringify(state)).not.toContain("1-projects");
  });

  test("a paused switch stops a pass before it reads anything", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "paused");
    const store = bucket({ "1-projects/a.md": "# A\n" });
    await observeBucket(t, ws, store);
    await t.run((ctx) => ctx.db.insert("noteIdLayout", { paused: true, mode: "paths", updatedAt: Date.now() }));
    const c = chain(t, ws, store, {
      copyHere: async () => {
        throw new Error("a paused pass must not copy");
      },
    });
    await t.run((ctx) => beginCopyPass(ctx, ws, { force: false }));
    const runId = (await t.run((ctx) => copyRowOf(ctx.db, ws)))!.runId;
    c.pending.push({ name: "functions/noteIdsCopy:run", args: { workspaceId: ws, runId } });
    await drain(c);
    expect((await rowAt(t, ws, "1-projects/a.md"))?.idCopy).toBeUndefined();
    expect((await pass(c))?.status).toBe("copying");
  });

  test("two claims on one page: only the first holds the lease", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "lease");
    await t.run((ctx) => beginCopyPass(ctx, ws, { force: false }));
    const row = await t.run((ctx) => copyRowOf(ctx.db, ws));
    const first = await t.mutation(internal.functions.noteIdsCopy.claimCopy, { workspaceId: ws, runId: row!.runId, now: Date.now() });
    const second = await t.mutation(internal.functions.noteIdsCopy.claimCopy, { workspaceId: ws, runId: row!.runId, now: Date.now() });
    expect(first).toEqual({});
    expect(second).toBeNull();
  });

  test("a rerun of a finished pass copies nothing and finishes", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "again");
    const store = bucket({ "1-projects/a.md": "# A\n" });
    await observeBucket(t, ws, store);
    const c = chain(t, ws, store);
    await runPass(c);
    const first = await pass(c);
    await runPass(c);
    const second = await pass(c);
    expect(second).toMatchObject({ status: "done", copied: 1, failed: 0 });
    expect(second?.runId).toBeGreaterThan(first!.runId);
  });
});

describe("the diagnosis", () => {
  test("a copy the bucket lost or changed is cleared from its row, so the next pass copies it again", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "diagnosed");
    const store = bucket({ "1-projects/a.md": "# A\n", "1-projects/b.md": "# B\n", "1-projects/c.md": "# C\n" });
    await observeBucket(t, ws, store);
    const c = chain(t, ws, store);
    await runPass(c);
    const a = await rowAt(t, ws, "1-projects/a.md");
    const b = await rowAt(t, ws, "1-projects/b.md");
    store.objects.delete(`notes/${a?.noteId}.md`);
    store.seed(`notes/${b?.noteId}.md`, "# something else\n");
    c.pending.push({
      name: "functions/noteIdsCopy:runCheck",
      args: { workspaceId: ws, runId: 0, checkedAt: Date.now(), checked: 0, missing: 0, differs: 0 },
    });
    await drain(c);
    const state = await pass(c);
    expect(state?.diagnosis).toMatchObject({ checked: 3, missing: 1, differs: 1 });
    expect((await rowAt(t, ws, "1-projects/a.md"))?.idCopy).toBeUndefined();
    expect((await rowAt(t, ws, "1-projects/b.md"))?.idCopy).toBeUndefined();
    expect((await rowAt(t, ws, "1-projects/c.md"))?.idCopy).toBeDefined();
    expect(JSON.stringify(state)).not.toMatch(/1-projects/);
  });
});

describe("the staff surface", () => {
  test("staff read a report with counts and labels only, and a stranger or nobody is refused", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "reported");
    const store = bucket({ "1-projects/secret-plan.md": "# Secret\n" });
    await observeBucket(t, ws, store);
    await runPass(chain(t, ws, store));
    const staff = t.withIdentity({ subject: await user(t, ADMIN) });
    const stranger = t.withIdentity({ subject: await user(t, "someone@example.com") });

    const report = await staff.query(api.functions.noteIds.report, {});
    expect(report).toMatchObject({ paused: false, mode: "paths", truncated: false });
    // Keys fields are counted only in keys mode, so they read zero here (`keyedFlip.test.ts`).
    expect(report.totals).toMatchObject({ files: 1, copied: 1, failed: 0, liveFiles: 0, keyed: 0 });
    expect(report.workspaces.find((row) => row.handle === "reported")).toMatchObject({ status: "done", files: 1, copied: 1 });
    expect(JSON.stringify(report)).not.toMatch(/secret|1-projects|\.md|bucket-/);

    for (const caller of [t, stranger]) {
      await expect(caller.query(api.functions.noteIds.report, {})).rejects.toThrow();
      await expect(caller.mutation(api.functions.noteIds.startAll, {})).rejects.toThrow();
      await expect(caller.mutation(api.functions.noteIds.setPaused, { paused: true })).rejects.toThrow();
      await expect(caller.mutation(api.functions.noteIds.diagnoseAll, {})).rejects.toThrow();
    }
    expect(await t.run((ctx) => ctx.db.query("noteIdLayout").first())).toBeNull();
  });

  test("pausing refuses a start, and resuming starts a fresh pass for what was stopped", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "switch");
    const staff = t.withIdentity({ subject: await user(t, ADMIN) });
    await staff.mutation(api.functions.noteIds.setPaused, { paused: true });
    await expect(staff.mutation(api.functions.noteIds.start, { workspaceId: ws })).rejects.toThrow();
    await expect(staff.mutation(api.functions.noteIds.startAll, {})).rejects.toThrow();
    expect(await t.query(internal.functions.noteIdsCopy.checkPage, { workspaceId: ws, limit: 10 })).toMatchObject({ paused: true });

    const started = await staff.mutation(api.functions.noteIds.setPaused, { paused: false });
    expect(started).toEqual({ started: 0 });
    const resumed = await staff.mutation(api.functions.noteIds.start, { workspaceId: ws });
    expect(resumed).toEqual({ started: 1 });
  });

  test("the cron leaves a finished pass alone while paused, and starts it again when the tree changed", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "cron");
    const store = bucket({ "1-projects/a.md": "# A\n" });
    await observeBucket(t, ws, store);
    await runPass(chain(t, ws, store));
    await t.run((ctx) => ctx.db.insert("noteIdLayout", { paused: true, mode: "paths", updatedAt: Date.now() }));
    expect(await t.mutation(internal.functions.noteIds.keepCurrent, {})).toEqual({ started: 0 });
    await t.run((ctx) => ctx.db.query("noteIdLayout").first().then((row) => ctx.db.patch(row!._id, { paused: false })));
    // Nothing changed since the pass began: reading the whole tree again would find nothing.
    expect(await t.mutation(internal.functions.noteIds.keepCurrent, {})).toEqual({ started: 0 });
    store.seed("1-projects/b.md", "# B\n");
    await observeBucket(t, ws, store);
    expect(await t.mutation(internal.functions.noteIds.keepCurrent, {})).toEqual({ started: 1 });
  });

  test("the cron reads no tree whose rows are all keyed, and retries failed files hourly", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "cronkeyed");
    const store = bucket({ "1-projects/a.md": "# A\n" });
    await observeBucket(t, ws, store);
    await runPass(chain(t, ws, store));
    const row = (await pass(chain(t, ws, store)))!;
    // Its one recheck of keyed rows against their keys already ran (the next test).
    await t.run((ctx) => ctx.db.patch(row._id, { keyedAt: 1, keyedDoneAt: 2, keyedRecheckAt: 3 }));
    store.seed("1-projects/b.md", "# B\n");
    await observeBucket(t, ws, store);
    expect(await t.mutation(internal.functions.noteIds.keepCurrent, {})).toEqual({ started: 0 });

    // Not keyed, nothing changed, but files the last pass failed: tried again once an hour has passed.
    await t.run(async (ctx) => {
      const head = await ctx.db.query("nodeLog").order("desc").first();
      await ctx.db.patch(row._id, { keyedAt: undefined, keyedDoneAt: undefined, passSeq: head!.seq, failed: 1, updatedAt: Date.now() });
    });
    expect(await t.mutation(internal.functions.noteIds.keepCurrent, {})).toEqual({ started: 0 });
    await t.run((ctx) => ctx.db.patch(row._id, { updatedAt: Date.now() - 2 * 60 * 60 * 1000 }));
    expect(await t.mutation(internal.functions.noteIds.keepCurrent, {})).toEqual({ started: 1 });
  });

  test("the cron diagnoses each keyed workspace once, so rows left behind their keys catch up", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "recheck");
    const store = bucket({ "1-projects/a.md": "# A\n" });
    await observeBucket(t, ws, store);
    await runPass(chain(t, ws, store));
    const row = (await pass(chain(t, ws, store)))!;
    // Keyed, with its last diagnosis from before the walks told rows about sealing.
    await t.run((ctx) =>
      ctx.db.patch(row._id, { keyedAt: 1, keyedDoneAt: 2, diagnosis: { checkedAt: 1, checked: 0, missing: 0, differs: 0 } }),
    );

    expect(await t.mutation(internal.functions.noteIds.keepCurrent, {})).toEqual({ started: 1 });
    const after = (await t.run((ctx) => copyRowOf(ctx.db, ws)))!;
    expect(after.keyedRecheckAt).toBeTypeOf("number");
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((job) => job.name.includes("runCheck") && (job.args[0] as { workspaceId: string }).workspaceId === ws)).toHaveLength(1);

    // Once: the next tick starts nothing for it.
    expect(await t.mutation(internal.functions.noteIds.keepCurrent, {})).toEqual({ started: 0 });
  });

  test("a keyed workspace diagnosed since rows could fall behind is not rechecked", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "rechecked");
    const store = bucket({ "1-projects/a.md": "# A\n" });
    await observeBucket(t, ws, store);
    await runPass(chain(t, ws, store));
    const row = (await pass(chain(t, ws, store)))!;
    await t.run((ctx) =>
      ctx.db.patch(row._id, { keyedAt: 1, keyedDoneAt: 2, diagnosis: { checkedAt: Date.now(), checked: 1, missing: 0, differs: 0 } }),
    );

    expect(await t.mutation(internal.functions.noteIds.keepCurrent, {})).toEqual({ started: 0 });
  });

  test("a ticket for a page of a run that moved on opens nothing", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "tickets");
    const store = bucket({ "1-projects/a.md": "# A\n" });
    await observeBucket(t, ws, store);
    await t.run((ctx) => beginCopyPass(ctx, ws, { force: false }));
    const oldRun = (await t.run((ctx) => copyRowOf(ctx.db, ws)))!.runId;
    const node = await rowAt(t, ws, "1-projects/a.md");
    const item = { path: "1-projects/a.md", key: idKeyFor(node!.noteId!, "1-projects/a.md"), etag: node!.etag! };
    expect(await t.query(internal.functions.noteIdsCopy.pageIsCurrent, { workspaceId: ws, runId: oldRun, phase: "id_copy", items: [item] })).toBe(true);

    await t.run((ctx) => beginCopyPass(ctx, ws, { force: true }));
    expect(await t.query(internal.functions.noteIdsCopy.pageIsCurrent, { workspaceId: ws, runId: oldRun, phase: "id_copy", items: [item] })).toBe(false);

    // An edit since the page was handed out makes it stale too.
    const current = (await t.run((ctx) => copyRowOf(ctx.db, ws)))!.runId;
    expect(await t.query(internal.functions.noteIdsCopy.pageIsCurrent, { workspaceId: ws, runId: current, phase: "id_copy", items: [{ ...item, etag: "old" }] })).toBe(false);

    await t.mutation(internal.functions.storageMover.mintPage, {
      hashedTicket: "a".repeat(64),
      workspaceId: ws,
      idRunId: oldRun,
      idItems: [item],
      phase: "id_copy",
      now: Date.now(),
    });
    const opened = await t.action(internal.functions.managedProvisioning.openMoverPage, { hashedTicket: "a".repeat(64) });
    expect(opened).toBeNull();
  });

  test("a ticket must name its items and a phase of its own, or it is not minted", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "mint");
    await expect(
      t.mutation(internal.functions.storageMover.mintPage, {
        hashedTicket: "b".repeat(64),
        workspaceId: ws,
        idRunId: 1,
        phase: "copy",
        now: Date.now(),
      }),
    ).rejects.toThrow();
    await expect(
      t.mutation(internal.functions.storageMover.mintPage, {
        hashedTicket: "c".repeat(64),
        workspaceId: ws,
        idRunId: 1,
        idItems: [{ path: "a.md", key: "notes/x.md", etag: "e" }],
        phase: "verify_source",
        now: Date.now(),
      }),
    ).rejects.toThrow();
  });
});


describe("the copies are not notes", () => {
  test("an id key is never a tree path, but a folder a person named notes/ still is", () => {
    const id = newNoteId();
    expect(nodePath(`notes/${id}.md`)).toBeNull();
    expect(nodePath(`files/${id}.png`)).toBeNull();
    expect(nodePath(`files/${id}`)).toBeNull();
    expect(nodePath("notes/meeting.md")).toBe("notes/meeting.md");
    expect(nodePath(`notes/sub/${id}.md`)).toBe(`notes/sub/${id}.md`);
    expect(nodePath(`1-projects/${id}.md`)).toBe(`1-projects/${id}.md`);
  });

  test("a sweep after a pass makes no rows from the copies, and the next pass copies nothing", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "swept-after");
    const store = bucket({ "1-projects/a.md": "# A\n", "2-areas/pic.png": "png-bytes" });
    await observeBucket(t, ws, store);
    const c = chain(t, ws, store);
    await runPass(c);
    const a = await rowAt(t, ws, "1-projects/a.md");
    expect(store.bytesOf(`notes/${a?.noteId}.md`)).toBeTruthy();

    await observeBucket(t, ws, store);
    expect(await rowAt(t, ws, `notes/${a?.noteId}.md`)).toBeNull();
    expect(await rowAt(t, ws, "notes")).toBeNull();
    await runPass(c);
    expect(await pass(c)).toMatchObject({ status: "done", files: 2, failed: 0 });
    expect((await store.list({ limit: 100 })).objects.map((o) => o.key).filter((k) => /^(notes|files)\//.test(k))).toHaveLength(2);
  });
});

describe("stale rows and shared ids", () => {
  test("a row stale against its bucket object is healed from the bucket, copied, and the pass counts it as found", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "healed");
    const store = bucket({ "1-projects/a.md": "# A\n" });
    await observeBucket(t, ws, store);
    // The bytes changed without the tree hearing of it (a writer that did not report its touch).
    store.seed("1-projects/a.md", "# A, changed without the tree hearing\n");
    const c = chain(t, ws, store);
    await runPass(c);

    const a = await rowAt(t, ws, "1-projects/a.md");
    expect(await pass(c)).toMatchObject({ status: "done", copied: 1, failed: 0, failures: [] });
    expect(a?.etag).toBe((await store.get("1-projects/a.md"))?.etag);
    expect(copyIsFresh(a!)).toBe(true);
    expect(new TextDecoder().decode(store.bytesOf(`notes/${a?.noteId}.md`)!)).toBe("# A, changed without the tree hearing\n");
  });

  test("a note that changes on every pass is healed three times, then listed as changed, and the pass ends", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "churning");
    const store = bucket({ "1-projects/a.md": "# A\n" });
    await observeBucket(t, ws, store);
    const buckets = storeWithHead(store) as never;
    let writes = 0;
    const c = chain(t, ws, store, {
      copyHere: async (page) => {
        writes += 1;
        // Every page: the note is written after the row was read, so the copy finds a version the row does not have.
        store.seed("1-projects/a.md", `# A, write ${writes}\n`);
        return await runIdCopyPage(page, { buildStore: () => buckets });
      },
    });
    await runPass(c);

    // Three heals, then the fourth change is recorded as a failure: no fifth copy.
    expect(writes).toBe(4);
    const state = await pass(c);
    expect(state).toMatchObject({ status: "done", failed: 1, copied: 0 });
    const a = await rowAt(t, ws, "1-projects/a.md");
    expect(state?.failures).toEqual([{ noteId: a?.noteId, reason: "changed" }]);
  });

  test("two rows that name one id are listed once in the report, and both still count as failed", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "shared");
    const store = bucket({ "1-projects/a.md": "# A\n", "1-projects/b.md": "# B\n" });
    await observeBucket(t, ws, store);
    const a = await rowAt(t, ws, "1-projects/a.md");
    const b = await rowAt(t, ws, "1-projects/b.md");
    await t.run((ctx) => ctx.db.patch(b!._id, { noteId: a!.noteId }));
    const c = chain(t, ws, store, {
      copyHere: async (page) => ({ results: page.items.map((item) => ({ path: item.path, ok: false, reason: "copy_failed" })) }),
    });
    await runPass(c);

    const state = await pass(c);
    expect(state).toMatchObject({ status: "done", failed: 2 });
    expect(state?.failures).toEqual([{ noteId: a?.noteId, reason: "copy_failed" }]);
  });

  test("a file that was gone and is seen again keeps its id but not its old copy", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "revived");
    await t.mutation(internal.functions.nodes.observe, { workspaceId: ws, at: 10, rows: [{ path: "1-projects/a.md", etag: "e1" }], gone: [], vanishedUnder: [] });
    const first = await rowAt(t, ws, "1-projects/a.md");
    await t.mutation(internal.functions.nodes.observe, { workspaceId: ws, at: 20, rows: [], gone: ["1-projects/a.md"], vanishedUnder: [] });
    await t.mutation(internal.functions.nodes.observe, { workspaceId: ws, at: 30, rows: [{ path: "1-projects/a.md", etag: "e2" }], gone: [], vanishedUnder: [] });

    const again = await rowAt(t, ws, "1-projects/a.md");
    expect(first?.noteId).toMatch(UUID_V7);
    expect(again?.goneAt).toBeUndefined();
    expect(again?.noteId).toBe(first?.noteId);
    expect(again?.idCopy).toBeUndefined();
  });

  test("a gone row seen again after a live row took its id starts without that id", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "taken");
    await t.mutation(internal.functions.nodes.observe, { workspaceId: ws, at: 10, rows: [{ path: "1-projects/a.md", etag: "e1" }], gone: [], vanishedUnder: [] });
    const first = await rowAt(t, ws, "1-projects/a.md");
    await t.mutation(internal.functions.nodes.observe, { workspaceId: ws, at: 20, rows: [], gone: ["1-projects/a.md"], vanishedUnder: [] });
    // A move handed the id to the note's new place while the old one was gone.
    await t.mutation(internal.functions.nodes.observe, { workspaceId: ws, at: 25, rows: [{ path: "2-areas/a.md", etag: "e1" }], gone: [], vanishedUnder: [] });
    const moved = await rowAt(t, ws, "2-areas/a.md");
    await t.run(async (ctx) => {
      await ctx.db.patch(moved!._id, { noteId: first!.noteId });
    });
    await t.mutation(internal.functions.nodes.observe, { workspaceId: ws, at: 30, rows: [{ path: "1-projects/a.md", etag: "e2" }], gone: [], vanishedUnder: [] });

    const again = await rowAt(t, ws, "1-projects/a.md");
    expect(again?.goneAt).toBeUndefined();
    expect(again?.noteId).not.toBe(first?.noteId);
  });
});
