/**
 * Moving existing Tex notes from the bucket into their person's Durable Object
 * (`functions/texMigration.ts`, `lib/texMigration/`; decided by the owner,
 * 2026-10-31; `docs/decisions/texting-assistant/tex-durable-objects.md`).
 *
 * Each live keyed row under a personal workspace's Tex folder whose key is its
 * bucket id key has its body copied to the object at the same id key, read back
 * and compared, and only then has its key switched to the Tex form. The bucket
 * copy goes last. The bucket is the in-memory store the rest of the suite uses;
 * the object is the real `texObjects` behind the real gateway wire
 * (`serveTexStore`/`texBucket`) and the real key routing (`withTexRouting`).
 *
 * Sabotage, each confirmed to fail a case here: switch the key before the copy
 * is read back, delete the bucket copy before the switch, let a dry run write,
 * let the switch ignore the row's etag, or let a shared workspace's rows in.
 */

import { createRequire } from "node:module";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PINNED_CONTEXT_SLUG } from "@context/shared";
import type { Id } from "../_generated/dataModel";
import { R2Store } from "../../mcp/src/store/r2.js";
import { texKeyFor, withTexRouting } from "../../mcp/src/store/texRouting.js";
import { texObjects } from "../../mcp/src/texStore/objects.js";
import { serveTexStore, texBucket } from "../../mcp/src/texStore/wire.js";
import { idKeyFor } from "../functions/lib/nodes/noteIds";
import { migrateTexNotes, type TexMigrationOptions } from "../functions/lib/texMigration/run";
import { bridge, fixture, type Fixture } from "./nodes/moveFixture.helpers";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const NOTE_ABOUT = "0199a000-0000-7000-8000-00000000000a";
const NOTE_TASKS = "0199a000-0000-7000-8000-00000000000b";
const NOTE_DONE = "0199a000-0000-7000-8000-00000000000c";
const NOTE_KEEP = "0199a000-0000-7000-8000-00000000000d";
const NOTE_SHARED = "0199a000-0000-7000-8000-00000000000e";
const NOTE_FOREIGN = "0199a000-0000-7000-8000-00000000000f";
const NOTE_LEFT = "0199a000-0000-7000-8000-000000000010";
const NOTE_FILE = "0199a000-0000-7000-8000-000000000011";
const NOTE_OUTSIDE = "0199a000-0000-7000-8000-000000000012";
const NOTE_US = "0199a000-0000-7000-8000-000000000013";
const NOTE_STRAY = "0199a000-0000-7000-8000-000000000014";
const NOTE_PIN_OTHER = "0199a000-0000-7000-8000-000000000015";
const CHAT_KEY = "a".repeat(64);
const HOME = "tex/groups/blue-river-lamp";
const STAFF_EMAIL = "staff@example.invalid";
const MARKDOWN = "text/markdown; charset=utf-8";

function durableSql() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...binds: unknown[]) {
      const statement = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        const all = statement.all(...(binds as never[]));
        return { toArray: () => all };
      }
      statement.run(...(binds as never[]));
      return { toArray: () => [] };
    },
  };
}

interface Row {
  _id: Id<"nodes">;
  path: string;
  storageKey?: string;
  etag?: string;
  goneAt?: number;
}

/** A bucket copy's write, answering its etag. */
async function seedBucket(store: MemoryStore, key: string, body: string): Promise<string> {
  return (await store.put(key, body, { contentType: MARKDOWN }))!.etag;
}

async function seedRow(f: Fixture, workspaceId: Id<"workspaces">, path: string, noteId: string, storageKey?: string, etag?: string) {
  await f.t.run(async (ctx) => {
    await ctx.db.insert("nodes", {
      workspaceId,
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
      kind: "file",
      etag: etag ?? `etag-${noteId.slice(-4)}`,
      size: 10,
      observedAt: 1,
      noteId,
      storageKey: storageKey ?? idKeyFor(noteId, path),
    });
  });
}

async function world() {
  const f: Fixture = await fixture();
  const personal = f.ws;
  const owner = `person:${personal}`;
  const shared = await f.t.run(
    async (ctx) =>
      await ctx.db.insert("workspaces", {
        slug: "shared-tex",
        displayName: "Shared",
        createdBy: f.ownerId,
        kind: "shared",
        structureTemplate: "para",
        createdAt: 1,
        updatedAt: 1,
      }),
  );
  await f.t.run(async (ctx) => {
    await ctx.db.patch(personal, { kind: "personal" });
  });
  const foreignOwner = `person:${shared}`;

  const stores = new Map<Id<"workspaces">, MemoryStore>([
    [personal, f.store],
    [shared, memoryStore({ conditional: true })],
  ]);
  const objects = new Map<string, ReturnType<typeof texObjects>>();
  const failing = { puts: false, corrupt: false };
  const objectsFor = (name: string) => {
    if (!objects.has(name)) objects.set(name, texObjects(durableSql()));
    return objects.get(name)!;
  };
  // The object's bucket-shaped client over the real wire. A failing put answers the gateway's own 500; a corrupt one keeps other bytes.
  const texBucketFor = (name: string) =>
    new R2Store(
      texBucket({
        async fetch(request: Request) {
          const call = decodeURIComponent(request.headers.get("x-tex-call") ?? "");
          const isPut = call.includes('"op":"put"');
          if (failing.puts && isPut) return new Response("down", { status: 500 });
          if (failing.corrupt && isPut) {
            const garbled = new Request(request.url, { method: "POST", headers: request.headers, body: new TextEncoder().encode("garbled\n") });
            return await serveTexStore(objectsFor(name), garbled);
          }
          return await serveTexStore(objectsFor(name), request);
        },
      }),
    );
  const opened: string[] = [];
  // As the console opens it: a store reaches only the one object it was opened for.
  const openStore = async (workspaceId: Id<"workspaces">, owner: string) => {
    const store = stores.get(workspaceId);
    if (store === undefined) return null;
    opened.push(owner);
    const chats = owner.startsWith("chat:") ? [owner.slice("chat:".length)] : [];
    return withTexRouting(store, {
      workspaceId: String(workspaceId),
      chats,
      texStore: (name: string) => (name === owner ? texBucketFor(name) : null),
    }) as never;
  };

  // The bucket copies first: each keyed row takes the etag its copy has, which is the version the seam records for it.
  const etagOf = {
    about: await seedBucket(f.store, idKeyFor(NOTE_ABOUT, "tex/about-me.md"), "# About me\n\nLikes tea.\n"),
    tasks: await seedBucket(f.store, idKeyFor(NOTE_TASKS, "tex/tasks.md"), "- [ ] write it up\n"),
    keep: await seedBucket(f.store, idKeyFor(NOTE_KEEP, "tex/keep.md"), "# Keep\n"),
    file: (await f.store.put(idKeyFor(NOTE_FILE, "tex/file.png"), "png-bytes"))!.etag,
    outside: await seedBucket(f.store, idKeyFor(NOTE_OUTSIDE, "1-projects/outside.md"), "# Outside\n"),
    shared: await seedBucket(stores.get(shared)!, idKeyFor(NOTE_SHARED, "tex/shared.md"), "# Shared, not Tex\n"),
    // Already in the Tex form: its object holds the note, and no bucket copy is left.
    done: (await texBucketFor(owner).put(idKeyFor(NOTE_DONE, "tex/done.md"), "already here\n", { contentType: MARKDOWN }))!.etag,
  };

  // The personal workspace's Tex folder, with its notes keyed at their bucket id keys.
  await f.t.run(async (ctx) => {
    await ctx.db.insert("nodes", { workspaceId: personal, path: "tex", name: "tex", kind: "folder", observedAt: 1 });
  });
  await seedRow(f, personal, "tex/about-me.md", NOTE_ABOUT, undefined, etagOf.about);
  await seedRow(f, personal, "tex/tasks.md", NOTE_TASKS, undefined, etagOf.tasks);
  await seedRow(f, personal, "tex/keep.md", NOTE_KEEP, undefined, etagOf.keep);
  await seedRow(f, personal, "tex/file.png", NOTE_FILE, undefined, etagOf.file);
  await seedRow(f, personal, "tex/done.md", NOTE_DONE, texKeyFor(owner, idKeyFor(NOTE_DONE, "tex/done.md")), etagOf.done);
  // A keyed row outside the Tex folder, and an unkeyed row inside it.
  await seedRow(f, personal, "1-projects/outside.md", NOTE_OUTSIDE, undefined, etagOf.outside);
  await f.t.run(async (ctx) => {
    await ctx.db.insert("nodes", {
      workspaceId: personal,
      path: "tex/unkeyed.md",
      name: "unkeyed.md",
      kind: "file",
      etag: "u",
      observedAt: 1,
      noteId: NOTE_LEFT,
    });
  });
  // Another owner's Tex form, filed under this workspace's Tex folder: never this workspace's to move.
  await seedRow(f, personal, "tex/foreign.md", NOTE_FOREIGN, texKeyFor(foreignOwner, idKeyFor(NOTE_FOREIGN, "tex/foreign.md")));

  // A shared workspace with a keyed note under a `tex` folder of its own.
  await f.t.run(async (ctx) => {
    await ctx.db.insert("nodes", { workspaceId: shared, path: "tex", name: "tex", kind: "folder", observedAt: 1 });
  });
  await seedRow(f, shared, "tex/shared.md", NOTE_SHARED, undefined, etagOf.shared);

  const options = (dryRun: boolean, extra: Partial<TexMigrationOptions> = {}): TexMigrationOptions => ({ dryRun, openStore, ...extra });
  const run = (dryRun: boolean, extra: Partial<TexMigrationOptions> = {}) => migrateTexNotes(bridge(f.t), options(dryRun, extra));
  const objectText = async (name: string, key: string) => {
    const object = await texBucketFor(name).get(key);
    return object === null ? null : await object.text();
  };
  const rowAt = async (path: string): Promise<Row> =>
    await f.t.run(async (ctx) => {
      const rows = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", personal)).collect();
      const row = rows.find((candidate) => candidate.path === path);
      if (row === undefined) throw new Error("no row");
      return row as Row;
    });
  const snapshotAll = async () => {
    const rows = await f.t.run(async (ctx) => await ctx.db.query("nodes").collect());
    return {
      rows: rows.map((row) => [row.workspaceId, row.path, row.storageKey, row.etag, row.goneAt ?? null]),
      bucket: { ...f.store.snapshot() },
      sharedBucket: { ...stores.get(shared)!.snapshot() },
    };
  };
  return { f, personal, shared, owner, foreignOwner, stores, failing, objectsFor, texBucketFor, objectText, run, rowAt, snapshotAll, opened };
}

/**
 * The world, plus the pinned workspace with one group chat's home in it: a
 * note in the home, a note in a folder under `tex/groups/` that is no chat's
 * home, and a note elsewhere in the pinned workspace.
 */
async function pinnedWorld() {
  vi.stubEnv("ADMIN_EMAILS", STAFF_EMAIL);
  const w = await world();
  const chatOwner = `chat:${CHAT_KEY}`;
  const pinned = await w.f.t.run(async (ctx) => {
    const staff = await ctx.db.insert("users", { email: STAFF_EMAIL, emailVerificationTime: 1 });
    const id = await ctx.db.insert("workspaces", {
      slug: PINNED_CONTEXT_SLUG,
      displayName: "Context",
      createdBy: staff,
      kind: "shared",
      structureTemplate: "para",
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("textGroups", { groupKey: CHAT_KEY, homeWords: "blue-river-lamp", lastSeenAt: 1 });
    for (const path of ["tex", "tex/groups", HOME, "tex/groups/no-such-chat"]) {
      await ctx.db.insert("nodes", { workspaceId: id, path, name: path.slice(path.lastIndexOf("/") + 1), kind: "folder", observedAt: 1 });
    }
    return id;
  });
  const bucket = memoryStore({ conditional: true });
  w.stores.set(pinned, bucket);
  const paths = { us: `${HOME}/about-us.md`, stray: "tex/groups/no-such-chat/note.md", other: "guides/start.md" };
  const etagOf = {
    us: await seedBucket(bucket, idKeyFor(NOTE_US, paths.us), "# About us\n\nBook club.\n"),
    stray: await seedBucket(bucket, idKeyFor(NOTE_STRAY, paths.stray), "# Stray\n"),
    other: await seedBucket(bucket, idKeyFor(NOTE_PIN_OTHER, paths.other), "# Start\n"),
  };
  await seedRow(w.f, pinned, paths.us, NOTE_US, undefined, etagOf.us);
  await seedRow(w.f, pinned, paths.stray, NOTE_STRAY, undefined, etagOf.stray);
  await seedRow(w.f, pinned, paths.other, NOTE_PIN_OTHER, undefined, etagOf.other);
  const pinnedRow = async (path: string): Promise<Row> =>
    await w.f.t.run(async (ctx) => {
      const rows = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", pinned)).collect();
      const row = rows.find((candidate) => candidate.path === path);
      if (row === undefined) throw new Error("no row");
      return row as Row;
    });
  return { ...w, pinned, bucket, chatOwner, paths, pinnedRow };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a dry run reports what would move and writes nothing", () => {
  test("counts the bucket-keyed rows under a personal Tex folder, and changes no row, bucket or object", async () => {
    const w = await world();
    const before = await w.snapshotAll();

    const page = await w.run(true, { listPaths: true });

    expect(page).toMatchObject({ wouldMove: 4, moved: 0, alreadyMoved: 1, other: 1, done: true, cursor: "" });
    expect([...(page.paths ?? [])].sort()).toEqual(["tex/about-me.md", "tex/file.png", "tex/keep.md", "tex/tasks.md"]);
    expect(await w.snapshotAll()).toEqual(before);
    expect(await w.objectText(w.owner, idKeyFor(NOTE_ABOUT, "tex/about-me.md"))).toBeNull();
  });
});

describe("a run on one workspace first", () => {
  test("only that workspace's notes move; naming another moves nothing here", async () => {
    const w = await world();
    const before = await w.snapshotAll();

    const elsewhere = await w.run(false, { only: w.shared });
    expect(elsewhere).toMatchObject({ moved: 0, wouldMove: 0, done: true });
    expect(await w.snapshotAll()).toEqual(before);

    const mine = await w.run(false, { only: w.personal });
    expect(mine).toMatchObject({ moved: 4, workspaces: 1, done: true });
  });
});

describe("a real run moves each body into the person's object, switches the key, and then deletes the bucket copy", () => {
  test("the body and its content type are copied, read back, the key is switched and the bucket copy is gone", async () => {
    const w = await world();
    const idKey = idKeyFor(NOTE_ABOUT, "tex/about-me.md");
    const old = await w.rowAt("tex/about-me.md");

    const page = await w.run(false);

    expect(page).toMatchObject({ moved: 4, wouldMove: 0, alreadyMoved: 1, swept: 0, refused: {}, done: true });
    const row = await w.rowAt("tex/about-me.md");
    expect(row.storageKey).toBe(texKeyFor(w.owner, idKey));
    expect(row._id).toBe(old._id);
    expect(await w.objectText(w.owner, idKey)).toBe("# About me\n\nLikes tea.\n");
    const copied = await w.texBucketFor(w.owner).get(idKey);
    expect(copied?.httpMetadata?.contentType).toBe(MARKDOWN);
    expect(w.f.store.snapshot()[idKey]).toBeUndefined();
    expect(row.etag).not.toBe(old.etag);
  });

  test("the rows outside the Tex folder, the shared workspace's rows and another owner's Tex form are untouched", async () => {
    const w = await world();
    const outside = await w.rowAt("1-projects/outside.md");
    const foreign = await w.rowAt("tex/foreign.md");

    await w.run(false);

    expect((await w.rowAt("1-projects/outside.md")).storageKey).toBe(outside.storageKey);
    expect((await w.rowAt("tex/foreign.md")).storageKey).toBe(foreign.storageKey);
    expect(w.stores.get(w.shared)!.snapshot()[idKeyFor(NOTE_SHARED, "tex/shared.md")]).toBe("# Shared, not Tex\n");
    expect(w.f.store.snapshot()[idKeyFor(NOTE_OUTSIDE, "1-projects/outside.md")]).toBe("# Outside\n");
    expect(await w.objectText(w.foreignOwner, idKeyFor(NOTE_FOREIGN, "tex/foreign.md"))).toBeNull();
  });

  test("a row whose bucket copy is missing is refused and left as it was", async () => {
    const w = await world();
    const idKey = idKeyFor(NOTE_KEEP, "tex/keep.md");
    await w.f.store.delete(idKey);
    const before = await w.rowAt("tex/keep.md");

    const page = await w.run(false);

    expect(page.refused).toEqual({ missing: 1 });
    expect((await w.rowAt("tex/keep.md")).storageKey).toBe(before.storageKey);
  });
});

describe("a second run is a no-op", () => {
  test("nothing is copied, switched or deleted again", async () => {
    const w = await world();
    await w.run(false);
    const after = await w.snapshotAll();

    const page = await w.run(false);

    expect(page).toMatchObject({ moved: 0, wouldMove: 0, swept: 0, refused: {}, done: true });
    expect(await w.snapshotAll()).toEqual(after);
  });

  test("a bucket copy left behind by a crash after the switch is removed, once its object is there", async () => {
    const w = await world();
    await w.run(false);
    const leftover = idKeyFor(NOTE_ABOUT, "tex/about-me.md");
    await seedBucket(w.f.store, leftover, "# About me\n\nLikes tea.\n");

    const page = await w.run(false);

    expect(page).toMatchObject({ swept: 1, moved: 0 });
    expect(w.f.store.snapshot()[leftover]).toBeUndefined();
    expect(await w.objectText(w.owner, leftover)).toBe("# About me\n\nLikes tea.\n");
  });

  test("a bucket copy is kept while its object is missing, since the bucket copy may be the only one", async () => {
    const w = await world();
    await w.run(false);
    const leftover = idKeyFor(NOTE_DONE, "tex/done.md");
    await seedBucket(w.f.store, leftover, "bucket copy\n");
    w.objectsFor(w.owner).wipe();

    const page = await w.run(false);

    expect(page.refused).toEqual({ tex_missing: 1 });
    expect(w.f.store.snapshot()[leftover]).toBe("bucket copy\n");
  });
});

describe("a failed copy leaves the row and the bucket as they were", () => {
  test("when the object refuses the copy, the bucket copy and its row are untouched", async () => {
    const w = await world();
    const before = await w.snapshotAll();
    w.failing.puts = true;

    const page = await w.run(false);

    expect(page.moved).toBe(0);
    expect(page.refused.FAILED).toBe(4);
    expect(await w.snapshotAll()).toEqual(before);
    expect(await w.objectText(w.owner, idKeyFor(NOTE_ABOUT, "tex/about-me.md"))).toBeNull();
  });

  test("a copy that reads back as other bytes is refused before anything switches", async () => {
    const w = await world();
    const before = await w.snapshotAll();
    w.failing.corrupt = true;

    const page = await w.run(false);

    expect(page.moved).toBe(0);
    expect(page.refused).toEqual({ verify_failed: 4 });
    expect(await w.snapshotAll()).toEqual(before);
  });

  test("a row whose version moves after the copy is not switched, even when its bucket copy did not move", async () => {
    const w = await world();
    const before = await w.rowAt("tex/keep.md");

    const page = await w.run(false, {
      afterCopy: async (row) => {
        if (row.path !== "tex/keep.md") return;
        await w.f.t.run(async (ctx) => {
          await ctx.db.patch(row.id, { etag: "moved-on" });
        });
      },
    });

    expect(page.refused).toEqual({ changed: 1 });
    expect((await w.rowAt("tex/keep.md")).storageKey).toBe(before.storageKey);
    expect(w.f.store.snapshot()[idKeyFor(NOTE_KEEP, "tex/keep.md")]).toBe("# Keep\n");
  });

  test("a crash between the copy and the switch leaves the bucket authoritative, and the next run finishes", async () => {
    const w = await world();
    const idKey = idKeyFor(NOTE_TASKS, "tex/tasks.md");
    const before = await w.rowAt("tex/tasks.md");

    const page = await w.run(false, {
      // Someone edits the note between the copy and the switch: the bucket and the row move on together, as the seam writes them.
      afterCopy: async (row) => {
        if (row.path !== "tex/tasks.md") return;
        const written = await w.f.store.put(idKey, "- [x] changed\n", { contentType: MARKDOWN });
        await w.f.t.run(async (ctx) => {
          await ctx.db.patch(row.id, { etag: written!.etag });
        });
      },
    });

    expect(page.refused).toEqual({ changed: 1 });
    expect(page.moved).toBe(3);
    expect((await w.rowAt("tex/tasks.md")).storageKey).toBe(before.storageKey);
    expect(w.f.store.snapshot()[idKey]).toBe("- [x] changed\n");

    const again = await w.run(false);
    expect(again).toMatchObject({ refused: {}, moved: 1 });
    expect((await w.rowAt("tex/tasks.md")).storageKey).toBe(texKeyFor(w.owner, idKey));
    expect(await w.objectText(w.owner, idKey)).toBe("- [x] changed\n");
  });
});

describe("the run pages through the workspaces and resumes where it stopped", () => {
  test("a small work limit stops mid-folder, and the cursor carries the run on to the end", async () => {
    const w = await world();
    let cursor: string | undefined;
    let pages = 0;
    let moved = 0;
    for (;;) {
      const page = await w.run(false, { limit: 1, ...(cursor === undefined ? {} : { cursor }) });
      pages += 1;
      moved += page.moved;
      if (page.done) break;
      cursor = page.cursor;
      expect(pages).toBeLessThan(20);
    }
    expect(moved).toBe(4);
    expect(pages).toBeGreaterThan(1);
    expect((await w.rowAt("tex/file.png")).storageKey).toBe(texKeyFor(w.owner, idKeyFor(NOTE_FILE, "tex/file.png")));
  });
});

describe("a group chat's home in the pinned workspace moves into that chat's object", () => {
  test("a dry run counts the home's notes and nothing else of the pinned workspace", async () => {
    const w = await pinnedWorld();
    const before = await w.snapshotAll();

    const page = await w.run(true, { only: w.pinned, listPaths: true });

    expect(page).toMatchObject({ wouldMove: 1, other: 1, done: true });
    expect(page.paths).toEqual([w.paths.us]);
    expect(await w.snapshotAll()).toEqual(before);
  });

  test("the home's note is copied to the chat's object, its row keyed there and the bucket copy removed; the rest stays", async () => {
    const w = await pinnedWorld();
    const idKey = idKeyFor(NOTE_US, w.paths.us);
    const old = await w.pinnedRow(w.paths.us);

    const page = await w.run(false, { only: w.pinned });

    expect(page).toMatchObject({ moved: 1, other: 1, refused: {}, done: true });
    const row = await w.pinnedRow(w.paths.us);
    expect(row._id).toBe(old._id);
    expect(row.storageKey).toBe(texKeyFor(w.chatOwner, idKey));
    expect(await w.objectText(w.chatOwner, idKey)).toBe("# About us\n\nBook club.\n");
    expect(w.bucket.snapshot()[idKey]).toBeUndefined();
    // Never the person's object, and never a store opened for anyone but the chat.
    expect(await w.objectText(`person:${w.pinned}`, idKey)).toBeNull();
    expect(w.opened).toEqual([w.chatOwner]);
    // A folder under tex/groups that is no chat's home, and a note outside the homes, are left in the bucket.
    expect((await w.pinnedRow(w.paths.stray)).storageKey).toBe(idKeyFor(NOTE_STRAY, w.paths.stray));
    expect(w.bucket.snapshot()[idKeyFor(NOTE_STRAY, w.paths.stray)]).toBe("# Stray\n");
    expect((await w.pinnedRow(w.paths.other)).storageKey).toBe(idKeyFor(NOTE_PIN_OTHER, w.paths.other));
  });

  test("a second run is a no-op, and the person's notes move on the same run", async () => {
    const w = await pinnedWorld();
    const first = await w.run(false);
    expect(first).toMatchObject({ moved: 5, refused: {}, done: true });
    const after = await w.snapshotAll();

    const again = await w.run(false);

    expect(again).toMatchObject({ moved: 0, alreadyMoved: 6, refused: {} });
    expect(await w.snapshotAll()).toEqual(after);
  });

  test("a workspace with the pinned slug that nobody vouches for has no homes to move", async () => {
    const w = await pinnedWorld();
    vi.stubEnv("ADMIN_EMAILS", "someone-else@example.invalid");
    const before = await w.snapshotAll();

    const page = await w.run(false, { only: w.pinned });

    expect(page).toMatchObject({ moved: 0, wouldMove: 0, rows: 0 });
    expect(await w.snapshotAll()).toEqual(before);
  });
});
