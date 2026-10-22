/**
 * The keyed routes of the gateway's id copy (`functions/lib/noteIds/http.ts`):
 * `lookup` answering `keyed` and `notes`, `wrote` with `keyed: true`, and
 * `adopt` and `removed`.
 *
 * What is proved:
 *  - `lookup` answers `notes` for every path named, a path the reader may not
 *    see included (a form's answers note must resolve for the member who wrote
 *    it), while `copies` keeps its privacy filter; `keyed` follows the switch;
 *  - a member (any role) with a write grant may adopt, retire and record a keyed
 *    write; an outsider, a read-only grant and a reader of another workspace
 *    get `{ served: false }` for each, and nothing changes;
 *  - the unkeyed `wrote` stays owner-or-editor, as it was: a member is refused;
 *  - a malformed keyed body (no time, a size that is not a number, an overlong
 *    path) is a 400 before anything is read.
 *
 * Sabotage (temporary local edits, reverted):
 *  - answering `notes` through `canSee`: the hidden-note case fails;
 *  - requiring owner or editor for keyed writes: the member cases fail;
 *  - dropping the `at` check in `wrote`: the missing-time case fails.
 */

import { describe, expect, test } from "vitest";
import { idKeyFor } from "../../functions/lib/nodes/noteIds";
import { ensureCopyRow } from "../../functions/lib/noteIds/state";
import { gatewayPost } from "../fixtures.helpers";
import { bodyOf, seedConnectedClient, token } from "../controlPlane/fixtures.helpers";
import {
  EDITOR,
  MEMBER,
  NOTE_IDS,
  OUTSIDER,
  OWNER,
  PLAN,
  SECRET,
  fixture,
  rowOf,
  seedCopies,
  type Fixture,
} from "./noteIdsGateway.helpers";

const LOOKUP = "/gateway/note-ids/lookup";
const WROTE = "/gateway/note-ids/wrote";
const ADOPT = "/gateway/note-ids/adopt";
const REMOVED = "/gateway/note-ids/removed";

const NEW = "1-projects/new.md";
const NEW_ID = "0190c0de-0000-7000-8000-00000000b001";
const READER = token("ids_member_reader");

/** The switch at `keys`, and the flip begun: the workspace is keyed. */
async function keysMode(f: Fixture) {
  await f.t.run(async (ctx) => {
    const layout = await ctx.db.query("noteIdLayout").first();
    if (layout === null) await ctx.db.insert("noteIdLayout", { paused: false, mode: "keys", updatedAt: 1, updatedBy: "test" });
    else await ctx.db.patch(layout._id, { mode: "keys" });
    const copies = await ensureCopyRow(ctx, f.ws);
    await ctx.db.patch(copies._id, { keyedAt: 1 });
  });
}

/** A read-only grant for the member of `ws`: it may read, and may not write. */
async function readOnlyMember(f: Fixture) {
  const memberId = await f.t.run(async (ctx) => {
    const users = await ctx.db.query("users").collect();
    return users.find((user) => user.email === "ids-member@example.test")!._id;
  });
  await seedConnectedClient(f.t, { workspaceId: f.ws, userId: memberId, clientId: "mcp_client_note_ids", accessToken: READER, scopes: ["context:read"] });
}

function adoptOf(accessToken: string, f: Fixture, path: string, noteId: string, extra: Record<string, unknown> = {}) {
  return {
    accessToken,
    workspaceId: f.ws,
    path,
    noteId,
    key: idKeyFor(noteId, path),
    etag: "k-new-1",
    at: 500,
    ...extra,
  };
}

async function post(f: Fixture, path: string, body: Record<string, unknown>) {
  return await gatewayPost(f.t, path, body);
}

describe("POST /gateway/note-ids/lookup: notes and keyed", () => {
  test("notes answers every path named, a hidden one included, while copies keeps its privacy filter", async () => {
    const f = await fixture();
    await seedCopies(f);
    await keysMode(f);
    const body = await bodyOf(await post(f, LOOKUP, { accessToken: MEMBER, workspaceId: f.ws, paths: [SECRET, PLAN] }));
    expect(body.keyed).toBe(true);
    expect(Object.keys(body.copies as object)).toEqual([PLAN]);
    expect((body.notes as Record<string, unknown>)[SECRET]).toEqual({
      path: SECRET,
      state: "path",
      key: `notes/${NOTE_IDS.secret}.md`,
      etag: expect.any(String),
      keyEtag: "key-etag-0",
      fresh: true,
    });
    expect(Object.keys(body.notes as object).sort()).toEqual([PLAN, SECRET].sort());
  });

  test("a grant of another workspace gets nothing for notes or copies", async () => {
    const f = await fixture();
    await seedCopies(f);
    await keysMode(f);
    expect(await bodyOf(await post(f, LOOKUP, { accessToken: OUTSIDER, workspaceId: f.ws, paths: [PLAN] }))).toEqual({ served: false });
  });
});

describe("POST /gateway/note-ids/adopt", () => {
  test("a member with a write grant adopts a new name: the row is keyed, and the answer says so", async () => {
    const f = await fixture();
    await keysMode(f);
    const answer = await bodyOf(await post(f, ADOPT, adoptOf(MEMBER, f, NEW, NEW_ID, { size: 4 })));
    expect(answer).toEqual({ ok: true, adopted: true, taken: null });
    expect(await rowOf(f.t, f.ws, NEW)).toMatchObject({ noteId: NEW_ID, storageKey: `notes/${NEW_ID}.md`, etag: "k-new-1", size: 4 });
  });

  test("a name a row holds is not adopted, and the holder is answered", async () => {
    const f = await fixture();
    await seedCopies(f);
    await keysMode(f);
    const answer = await bodyOf(await post(f, ADOPT, adoptOf(EDITOR, f, PLAN, NEW_ID)));
    expect(answer).toEqual({
      ok: true,
      adopted: false,
      taken: { path: PLAN, state: "path", key: `notes/${NOTE_IDS.plan}.md`, etag: `e-${PLAN}`, keyEtag: "key-etag-0", fresh: true },
    });
  });

  test("a read-only grant, another workspace's member and a stranger are refused, and nothing is created", async () => {
    const f = await fixture();
    await keysMode(f);
    await readOnlyMember(f);
    for (const accessToken of [READER, OUTSIDER, "cat_nobody"]) {
      expect(await bodyOf(await post(f, ADOPT, adoptOf(accessToken, f, NEW, NEW_ID)))).toEqual({ served: false });
    }
    expect(await rowOf(f.t, f.ws, NEW)).toBeNull();
  });

  test("a malformed body is a 400: no time, a size that is not a number, an overlong path", async () => {
    const f = await fixture();
    await keysMode(f);
    const { at: _at, ...noTime } = adoptOf(MEMBER, f, NEW, NEW_ID);
    expect((await post(f, ADOPT, noTime)).status).toBe(400);
    expect((await post(f, ADOPT, adoptOf(MEMBER, f, NEW, NEW_ID, { size: "4" }))).status).toBe(400);
    const long = `1-projects/${"x".repeat(2000)}.md`;
    expect((await post(f, ADOPT, adoptOf(MEMBER, f, long, NEW_ID))).status).toBe(400);
  });
});

describe("POST /gateway/note-ids/removed", () => {
  test("a member with a write grant retires a keyed note: the row is gone", async () => {
    const f = await fixture();
    await keysMode(f);
    await post(f, ADOPT, adoptOf(MEMBER, f, NEW, NEW_ID));
    const key = `notes/${NEW_ID}.md`;
    expect(await bodyOf(await post(f, REMOVED, { accessToken: EDITOR, workspaceId: f.ws, path: NEW, key, at: 600 }))).toEqual({
      ok: true,
      removed: true,
    });
    expect((await rowOf(f.t, f.ws, NEW))!.goneAt).toBe(600);
  });

  test("a key that is not the row's, a read-only grant and a stranger change nothing", async () => {
    const f = await fixture();
    await keysMode(f);
    await readOnlyMember(f);
    await post(f, ADOPT, adoptOf(MEMBER, f, NEW, NEW_ID));
    const key = `notes/${NEW_ID}.md`;
    expect(await bodyOf(await post(f, REMOVED, { accessToken: MEMBER, workspaceId: f.ws, path: NEW, key: `notes/${NOTE_IDS.plan}.md`, at: 600 }))).toEqual({
      ok: true,
      removed: false,
    });
    expect(await bodyOf(await post(f, REMOVED, { accessToken: READER, workspaceId: f.ws, path: NEW, key, at: 600 }))).toEqual({ served: false });
    expect(await bodyOf(await post(f, REMOVED, { accessToken: OUTSIDER, workspaceId: f.ws, path: NEW, key, at: 600 }))).toEqual({ served: false });
    expect((await rowOf(f.t, f.ws, NEW))!.goneAt).toBeUndefined();
  });

  test("a malformed body is a 400", async () => {
    const f = await fixture();
    expect((await post(f, REMOVED, { accessToken: MEMBER, workspaceId: f.ws, path: NEW, key: `notes/${NEW_ID}.md` })).status).toBe(400);
  });
});

describe("POST /gateway/note-ids/wrote with keyed: true", () => {
  test("a member records a keyed write: the key's new version, its size and the time", async () => {
    const f = await fixture();
    await keysMode(f);
    await post(f, ADOPT, adoptOf(MEMBER, f, NEW, NEW_ID));
    const body = { accessToken: MEMBER, workspaceId: f.ws, path: NEW, key: `notes/${NEW_ID}.md`, etag: "k-new-2", keyed: true, size: 11, at: 700 };
    expect(await bodyOf(await post(f, WROTE, body))).toEqual({ ok: true, recorded: true });
    expect(await rowOf(f.t, f.ws, NEW)).toMatchObject({ etag: "k-new-2", size: 11, observedAt: 700 });
  });

  test("a keyed write needs its time: without one it is a 400", async () => {
    const f = await fixture();
    await keysMode(f);
    const body = { accessToken: MEMBER, workspaceId: f.ws, path: PLAN, key: `notes/${NOTE_IDS.plan}.md`, etag: "k", keyed: true };
    expect((await post(f, WROTE, body)).status).toBe(400);
  });

  test("a read-only grant and a stranger record nothing for a keyed write", async () => {
    const f = await fixture();
    await keysMode(f);
    await readOnlyMember(f);
    await post(f, ADOPT, adoptOf(MEMBER, f, NEW, NEW_ID));
    const keyOf = { path: NEW, key: `notes/${NEW_ID}.md`, etag: "k-new-2", keyed: true, at: 700, workspaceId: f.ws };
    expect(await bodyOf(await post(f, WROTE, { ...keyOf, accessToken: READER }))).toEqual({ served: false });
    expect(await bodyOf(await post(f, WROTE, { ...keyOf, accessToken: OUTSIDER }))).toEqual({ served: false });
    expect((await rowOf(f.t, f.ws, NEW))!.etag).toBe("k-new-1");
  });

  test("an unkeyed write stays owner-or-editor: a member is still refused, as before", async () => {
    const f = await fixture();
    await seedCopies(f);
    const body = { accessToken: MEMBER, workspaceId: f.ws, path: PLAN, key: `notes/${NOTE_IDS.plan}.md`, etag: "e-new" };
    expect(await bodyOf(await post(f, WROTE, body))).toEqual({ served: false });
  });
});

describe("POST /gateway/note-ids/wrote without keyed, on a row the flip has keyed", () => {
  /** A keyed note at NEW, its key at version `k-new-1`. */
  async function keyedNew(f: Fixture) {
    await keysMode(f);
    await post(f, ADOPT, adoptOf(MEMBER, f, NEW, NEW_ID));
  }

  test("the row's key version is taken when the key matches and the key's etag is given", async () => {
    const f = await fixture();
    await keyedNew(f);
    const body = { accessToken: EDITOR, workspaceId: f.ws, path: NEW, key: `notes/${NEW_ID}.md`, etag: "p-etag", keyEtag: "k-new-9" };
    expect(await bodyOf(await post(f, WROTE, body))).toEqual({ ok: true, recorded: true });
    const row = await rowOf(f.t, f.ws, NEW);
    expect(row).toMatchObject({ etag: "k-new-9", storageKey: `notes/${NEW_ID}.md`, noteId: NEW_ID });
    expect(row!.keyedFrom).toBeUndefined();
  });

  test("a different key, or no key's etag, is refused and the row keeps its version", async () => {
    const f = await fixture();
    await keyedNew(f);
    const other = { accessToken: EDITOR, workspaceId: f.ws, path: NEW, key: `notes/${NOTE_IDS.plan}.md`, etag: "p-etag", keyEtag: "k-new-9" };
    expect(await bodyOf(await post(f, WROTE, other))).toEqual({ ok: true, recorded: false });
    const noKeyEtag = { accessToken: EDITOR, workspaceId: f.ws, path: NEW, key: `notes/${NEW_ID}.md`, etag: "p-etag" };
    expect(await bodyOf(await post(f, WROTE, noKeyEtag))).toEqual({ ok: true, recorded: false });
    expect((await rowOf(f.t, f.ws, NEW))!.etag).toBe("k-new-1");
  });
});
