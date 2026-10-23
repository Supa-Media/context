/**
 * A share follows its note by the note's stable id (`lib/shares/entryNote.ts`).
 *
 * The same bucket-backed fixture as `shareSurvivesMove.test.ts`, with the
 * access rows judging, and with the forwarding ledger wiped where a test says
 * so: what these pin is that the id alone carries a link to its note, and that
 * nothing at the old path can borrow it.
 *
 * Sabotage (run by hand, each must fail a test here):
 *  - resolve by `entryPath` again in `authorizeShareReadHandler` (ignore the
 *    id): "a renamed note opens with no forwarding left" fails;
 *  - forward the id-resolved path through the ledger anyway: "a note that moved
 *    away does not lend its old path's ledger entry to the note now there" fails;
 *  - drop the stamp at mint: "a new link carries its note's id" fails.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

// Each test builds a workspace with a bucket and a copied tree, which takes longer than the default five seconds.
vi.setConfig({ testTimeout: 30_000 });
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { memoryS3, type MemoryS3 } from "./storeStub.helpers";
import {
  FAKE_STORAGE,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
  type TestConvex,
  copyTree,
} from "./fixtures.helpers";
import { renderPrivacyManifest } from "./seededRules.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

const ENTRY = "1-projects/transition/overview.md";
const LINKED = "1-projects/transition/proposal.md";
const IMPOSTOR_MARKER = "zzq-impostor-body-marker-7c02-never-shared";

interface Fixture {
  t: TestConvex;
  owner: Id<"users">;
  lk: Id<"users">;
  workspaceId: Id<"workspaces">;
  backend: MemoryS3;
}

async function fixture(): Promise<Fixture> {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const lk = await createUser(t, "lk@example.invalid");

  const workspaceId = await createWorkspace(t, owner, "atlas");
  await createWorkspace(t, lk, "lk");

  const backend = memoryS3(FAKE_STORAGE.bucket);
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  backend.seed("index.md", "# Context\n");
  backend.seed(ENTRY, "# Chapter transition\n\nSee [the proposal](proposal.md).\n");
  backend.seed(LINKED, "# Proposal\n\nThe numbers.\n");
  vi.stubGlobal("fetch", backend.fetchImpl);

  const encryptedSecretAccessKey = await encryptSecret(
    FAKE_STORAGE.secretAccessKey,
    requireKeyset(),
    { workspaceId },
  );
  await t.run((ctx) =>
    ctx.db.insert("storageBindings", {
      workspaceId,
      provider: FAKE_STORAGE.provider,
      endpoint: FAKE_STORAGE.endpoint,
      region: FAKE_STORAGE.region,
      bucket: FAKE_STORAGE.bucket,
      accessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedSecretAccessKey,
      capabilities: { conditionalWrite: true },
      status: "connected" as const,
      lastVerifiedAt: Date.now(),
      boundBy: owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );

  await copyTree(t, workspaceId);
  // Production's shape: the access rows judge (`nodesPrivacy.heldFor`), so a share reads through them.
  await t.run(async (ctx) => {
    const migration = await ctx.db.query("nodeMigration").first();
    const flags = { accessSource: "rows" as const, privacyAuthority: true };
    if (migration === null) await ctx.db.insert("nodeMigration", { paused: false, updatedAt: 1, ...flags });
    else await ctx.db.patch(migration._id, flags);
    const privacy = await ctx.db
      .query("nodePrivacy")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .first();
    const authorityRow = { etag: "e1", invalid: false, folders: [], notes: [] };
    if (privacy === null) await ctx.db.insert("nodePrivacy", { workspaceId, observedAt: 1, ...authorityRow });
    else await ctx.db.patch(privacy._id, authorityRow);
  });
  await asUser(t, owner).action(api.functions.files.setDirectoryVisibility, {
    workspaceId,
    path: "1-projects",
    visibility: "team",
  });
  return { t, owner, lk, workspaceId, backend };
}

async function shareEntry(f: Fixture, path: string = ENTRY): Promise<string> {
  const { token } = await asUser(f.t, f.owner).mutation(api.functions.shares.createShare, {
    workspaceId: f.workspaceId,
    path,
    recipient: "@lk",
  });
  return token;
}

/** A folder link, which has its own bound — see `folderLink.test.ts`. */
async function shareFolder(f: Fixture, path: string): Promise<string> {
  const made = await asUser(f.t, f.owner).action(api.functions.shares.createLinkShare, {
    workspaceId: f.workspaceId,
    path,
    kind: "folder",
  });
  return made.token;
}

function read(f: Fixture, who: Id<"users">, token: string, path?: string) {
  return asUser(f.t, who).action(api.functions.shares.readSharedNote, {
    token,
    ...(path === undefined ? {} : { path }),
  });
}

function move(f: Fixture, from: string, to: string) {
  return asUser(f.t, f.owner).action(api.functions.files.moveEntry, {
    workspaceId: f.workspaceId,
    from,
    to,
  });
}


/** Every forwarding entry this workspace has, gone: the ledger's cap, or a ledger that never recorded the move. */
async function wipeLedger(f: Fixture): Promise<void> {
  await f.t.run(async (ctx) => {
    const rows = await ctx.db.query("forwardingEntries").collect();
    for (const row of rows) if (row.workspaceId === f.workspaceId) await ctx.db.delete(row._id);
  });
}

async function shareRow(f: Fixture, token: string) {
  return await f.t.run(async (ctx) =>
    await ctx.db
      .query("noteShares")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique(),
  );
}

async function noteIdAt(f: Fixture, path: string): Promise<string | undefined> {
  return await f.t.run(async (ctx) => {
    const row = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.workspaceId).eq("path", path))
      .unique();
    return row?.noteId;
  });
}

async function teamLink(f: Fixture, path: string = ENTRY): Promise<string> {
  const made = await asUser(f.t, f.owner).action(api.functions.shares.createLinkShare, {
    workspaceId: f.workspaceId,
    path,
    kind: "note",
  });
  return made.token;
}

describe("a link is stamped with its note's id", () => {
  test("a new link carries its note's id", async () => {
    const f = await fixture();
    const personal = await shareEntry(f);
    const link = await teamLink(f);
    const folder = await shareFolder(f, "1-projects/transition");

    const id = await noteIdAt(f, ENTRY);
    expect(id).toBeDefined();
    expect((await shareRow(f, personal))?.entryNoteId).toBe(id);
    expect((await shareRow(f, link))?.entryNoteId).toBe(id);
    expect((await shareRow(f, folder))?.entryNoteId).toBe(await noteIdAt(f, "1-projects/transition"));
  });
});

describe("the id carries the link", () => {
  test("a renamed note opens with no forwarding left", async () => {
    const f = await fixture();
    const token = await teamLink(f);
    await move(f, ENTRY, "1-projects/transition/summary.md");
    await wipeLedger(f);

    const result = await read(f, f.lk, token);
    expect(result.path).toBe("1-projects/transition/summary.md");
    expect(result.entryPath).toBe("1-projects/transition/summary.md");
    expect(result.text).toContain("# Chapter transition");
  });

  test("a renamed folder link opens with no forwarding left", async () => {
    const f = await fixture();
    const token = await shareFolder(f, "1-projects/transition");
    await move(f, "1-projects/transition", "1-projects/chapter-transition");
    await wipeLedger(f);

    const entry = await read(f, f.lk, token);
    expect(entry.kind).toBe("folder");
    expect(entry.entryPath).toBe("1-projects/chapter-transition");
    const inside = await read(f, f.lk, token, "1-projects/chapter-transition/overview.md");
    expect(inside.text).toContain("# Chapter transition");
  });

  test("a note that moved away does not lend its old path's ledger entry to the note now there", async () => {
    const f = await fixture();
    // A link on a note that will move away, and later a link on a new note at the same path.
    await move(f, ENTRY, "1-projects/transition/summary.md");
    await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: ENTRY,
      text: `# The new overview\n\n${IMPOSTOR_MARKER}\n`,
    });
    const token = await teamLink(f, ENTRY);

    // The ledger still says ENTRY went to summary.md. The new link is for the note now at ENTRY.
    const result = await read(f, f.lk, token);
    expect(result.path).toBe(ENTRY);
    expect(result.text).toContain(IMPOSTOR_MARKER);
  });

  test("a different note later created at the old path is not served, with or without the ledger", async () => {
    const f = await fixture();
    const token = await teamLink(f);
    await move(f, ENTRY, "1-projects/transition/summary.md");
    await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: ENTRY,
      text: `# Something else entirely\n\n${IMPOSTOR_MARKER}\n`,
    });
    await wipeLedger(f);

    const result = await read(f, f.lk, token);
    expect(result.path).toBe("1-projects/transition/summary.md");
    expect(result.text).not.toContain(IMPOSTOR_MARKER);
  });

  test("a link followed into a private folder is absent", async () => {
    const f = await fixture();
    const token = await teamLink(f);
    await move(f, ENTRY, "2-areas/overview.md");
    await wipeLedger(f);
    expect(errorCode(await captureError(() => read(f, f.lk, token)))).toBe("SHARE_UNAVAILABLE");
  });

  test("a trashed note's link is refused", async () => {
    const f = await fixture();
    const token = await teamLink(f);
    await asUser(f.t, f.owner).action(api.functions.files.trashEntry, { workspaceId: f.workspaceId, path: ENTRY });
    expect(errorCode(await captureError(() => read(f, f.lk, token)))).toBe("SHARE_UNAVAILABLE");
  });

  test("an id two live rows hold names neither, and the minted path answers", async () => {
    const f = await fixture();
    const token = await teamLink(f);
    const id = await noteIdAt(f, ENTRY);
    await f.t.run(async (ctx) => {
      const other = await ctx.db
        .query("nodes")
        .withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.workspaceId).eq("path", LINKED))
        .unique();
      await ctx.db.patch(other!._id, { noteId: id });
    });
    const result = await read(f, f.lk, token);
    expect(result.path).toBe(ENTRY);
  });
});

describe("links minted before the id are stamped", () => {
  test("an unstamped link still reads through the ledger, and the stamp fills it with the note it reaches", async () => {
    const f = await fixture();
    const token = await teamLink(f);
    const share = await shareRow(f, token);
    await f.t.run((ctx) => ctx.db.patch(share!._id, { entryNoteId: undefined }));
    await move(f, ENTRY, "1-projects/transition/summary.md");

    expect((await read(f, f.lk, token)).path).toBe("1-projects/transition/summary.md");

    const stamped = await f.t.mutation(internal.functions.shares.stampEntryNoteIds, {});
    expect(stamped.stamped).toBe(1);
    expect((await shareRow(f, token))?.entryNoteId).toBe(await noteIdAt(f, "1-projects/transition/summary.md"));

    await wipeLedger(f);
    expect((await read(f, f.lk, token)).path).toBe("1-projects/transition/summary.md");
  });

  test("a revoked link is left alone", async () => {
    const f = await fixture();
    const token = await teamLink(f);
    const share = await shareRow(f, token);
    await f.t.run((ctx) => ctx.db.patch(share!._id, { entryNoteId: undefined, status: "revoked" }));
    const stamped = await f.t.mutation(internal.functions.shares.stampEntryNoteIds, {});
    expect(stamped.stamped).toBe(0);
    expect((await shareRow(f, token))?.entryNoteId).toBeUndefined();
  });
});
