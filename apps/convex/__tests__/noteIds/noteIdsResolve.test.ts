/**
 * `POST /gateway/note-ids/resolve` (`functions/lib/noteIds/http.ts`): the
 * current path of each note id the reader names, for the reader's own
 * workspace only, and `POST /gateway/tree/manifest`, whose entries carry each
 * live file's note id.
 *
 * What is proved:
 *  - a live note id answers the path the row sits at now, and a path the
 *    reader may not see answers `null` (as a path with no row does);
 *  - a trashed row (`goneAt`) and a row moved under a dot folder (the trash
 *    location, which the tree never lists) answer `null`;
 *  - another workspace's note id answers `null` to this workspace's reader,
 *    and the other workspace's own reader still resolves it;
 *  - more than 200 ids, no ids, duplicates-as-one, and any id that is not a
 *    note id (a UUIDv7) is a 400 or collapses as stated; a refused token,
 *    a wrong secret and a non-member are refused as lookup refuses them;
 *  - the manifest entries of a served tree carry `noteId` for rows that have
 *    one, and omit it for a row with none.
 *
 * Sabotage (temporary local edit, reverted):
 *  - dropping `workspaceId` from the lookup in `pathsForNoteIds`: the
 *    "second workspace's note id resolves to null" case fails.
 */

import { describe, expect, test } from "vitest";
import { gatewayPost, responseFingerprint } from "../fixtures.helpers";
import { bodyOf } from "../controlPlane/fixtures.helpers";
import {
  EDITOR,
  GONE,
  MEMBER,
  NOTE_IDS,
  OUTSIDER,
  OWNER,
  PICTURE,
  PLAN,
  SECRET,
  fixture,
  patchRow,
  seedCopies,
  type Fixture,
} from "./noteIdsGateway.helpers";

const RESOLVE = "/gateway/note-ids/resolve";
const MANIFEST = "/gateway/tree/manifest";

/** A note id of the other workspace's row, `1-projects/theirs.md`. */
const THEIRS_ID = "0190c0de-0000-7000-8000-00000000b001";
const THEIRS = "1-projects/theirs.md";

async function resolve(f: Fixture, body: Record<string, unknown>, options: { secret?: string | null } = {}) {
  return await gatewayPost(f.t, RESOLVE, body, options);
}

/** Give the other workspace's row a note id, so there is one to ask for. */
async function giveTheirsAnId(f: Fixture): Promise<void> {
  await patchRow(f.t, f.other, THEIRS, { noteId: THEIRS_ID });
}

describe("POST /gateway/note-ids/resolve", () => {
  test("answers the path a live note id sits at now", async () => {
    const f = await fixture();
    await seedCopies(f);
    const body = await bodyOf(
      await resolve(f, {
        accessToken: OWNER,
        workspaceId: f.ws,
        noteIds: [NOTE_IDS.plan, NOTE_IDS.picture],
      }),
    );
    expect(body.paths).toEqual({ [NOTE_IDS.plan]: PLAN, [NOTE_IDS.picture]: PICTURE });
    // The first gateway call of the file pays the module load: 5 to 6 seconds on a loaded machine, past vitest's default.
  }, 30_000);

  test("a note id that names no row answers null, and so does one the reader may not see", async () => {
    const f = await fixture();
    await seedCopies(f);
    const unknown = "0190c0de-0000-7000-8000-0000000fffff";
    const body = await bodyOf(
      await resolve(f, { accessToken: MEMBER, workspaceId: f.ws, noteIds: [unknown, NOTE_IDS.secret, NOTE_IDS.plan] }),
    );
    expect(body.paths).toEqual({ [unknown]: null, [NOTE_IDS.secret]: null, [NOTE_IDS.plan]: PLAN });
    const asOwner = await bodyOf(await resolve(f, { accessToken: OWNER, workspaceId: f.ws, noteIds: [NOTE_IDS.secret] }));
    expect(asOwner.paths).toEqual({ [NOTE_IDS.secret]: SECRET });
  });

  test("a trashed row answers null", async () => {
    const f = await fixture();
    await seedCopies(f);
    const body = await bodyOf(await resolve(f, { accessToken: OWNER, workspaceId: f.ws, noteIds: [NOTE_IDS.gone] }));
    expect(body.paths).toEqual({ [NOTE_IDS.gone]: null });
  });

  test("a live row under the trash location (a dot folder the tree never lists) answers null", async () => {
    const f = await fixture();
    await seedCopies(f);
    await patchRow(f.t, f.ws, PLAN, { path: ".context/trash/s1/1-projects/plan.md" });
    const body = await bodyOf(await resolve(f, { accessToken: OWNER, workspaceId: f.ws, noteIds: [NOTE_IDS.plan] }));
    expect(body.paths).toEqual({ [NOTE_IDS.plan]: null });
  });

  test("another workspace's note id answers null, and that workspace's own reader still resolves it", async () => {
    const f = await fixture();
    await seedCopies(f);
    await giveTheirsAnId(f);
    const asOwnerHere = await bodyOf(await resolve(f, { accessToken: OWNER, workspaceId: f.ws, noteIds: [THEIRS_ID] }));
    expect(asOwnerHere.paths).toEqual({ [THEIRS_ID]: null });
    const asOwnerThere = await bodyOf(await resolve(f, { accessToken: OUTSIDER, workspaceId: f.other, noteIds: [THEIRS_ID] }));
    expect(asOwnerThere.paths).toEqual({ [THEIRS_ID]: THEIRS });
  });

  test("more than 200 ids is a 400; exactly 200 is accepted; duplicates answer once", async () => {
    const f = await fixture();
    await seedCopies(f);
    const many = Array.from({ length: 201 }, (_, index) => `0190c0de-0000-7000-8000-${index.toString(16).padStart(12, "0")}`);
    expect((await resolve(f, { accessToken: OWNER, workspaceId: f.ws, noteIds: many })).status).toBe(400);
    const exactly = await resolve(f, { accessToken: OWNER, workspaceId: f.ws, noteIds: many.slice(0, 200) });
    expect(exactly.status).toBe(200);
    expect(Object.keys((await bodyOf(exactly)).paths as object)).toHaveLength(200);
    const twice = await bodyOf(await resolve(f, { accessToken: OWNER, workspaceId: f.ws, noteIds: [NOTE_IDS.plan, NOTE_IDS.plan] }));
    expect(twice.paths).toEqual({ [NOTE_IDS.plan]: PLAN });
  });

  test("an empty list, a non-list, and anything that is not a note id is a 400", async () => {
    const f = await fixture();
    await seedCopies(f);
    const bad = (noteIds: unknown) => resolve(f, { accessToken: OWNER, workspaceId: f.ws, noteIds });
    expect((await bad([])).status).toBe(400);
    expect((await bad(NOTE_IDS.plan)).status).toBe(400);
    expect((await bad([PLAN])).status).toBe(400);
    expect((await bad(["0190c0de-0000-4000-8000-00000000a001"])).status).toBe(400);
    expect((await bad([1])).status).toBe(400);
    expect((await bad([NOTE_IDS.plan.toUpperCase()])).status).toBe(400);
  });

  test("a missing token, a token for nothing, and another workspace's member are refused, as lookup refuses them", async () => {
    const f = await fixture();
    await seedCopies(f);
    expect(await bodyOf(await resolve(f, { workspaceId: f.ws, noteIds: [NOTE_IDS.plan] }))).toEqual({ served: false });
    expect(
      await bodyOf(await resolve(f, { accessToken: "cat_nobody", workspaceId: f.ws, noteIds: [NOTE_IDS.plan] })),
    ).toEqual({ served: false });
    expect(await bodyOf(await resolve(f, { accessToken: OUTSIDER, workspaceId: f.ws, noteIds: [NOTE_IDS.plan] }))).toEqual({
      served: false,
    });
    const forbidden = await responseFingerprint(
      await resolve(f, { accessToken: OUTSIDER, workspaceId: f.ws, noteIds: [NOTE_IDS.plan] }),
    );
    const nonexistent = await responseFingerprint(
      await resolve(f, { accessToken: OUTSIDER, workspaceId: f.ws.replace(/.$/, "x"), noteIds: [NOTE_IDS.plan] }),
    );
    expect(forbidden).toBe(nonexistent);
  });

  test("a wrong gateway secret, or none, is refused before anything is read", async () => {
    const f = await fixture();
    await seedCopies(f);
    const body = { accessToken: OWNER, workspaceId: f.ws, noteIds: [NOTE_IDS.plan] };
    expect((await resolve(f, body, { secret: "not-the-secret" })).status).toBe(401);
    expect((await resolve(f, body, { secret: null })).status).toBe(401);
  });
});

describe("POST /gateway/tree/manifest carries note ids", () => {
  test("a live file with an id has noteId in its entry, and a file with none has no such field", async () => {
    const f = await fixture();
    await seedCopies(f);
    const body = await bodyOf(await gatewayPost(f.t, MANIFEST, { accessToken: EDITOR, expectedWorkspaceId: f.ws }));
    expect(body.served).toBe(true);
    const entries = body.entries as Array<{ path: string; noteId?: string }>;
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    expect(byPath.get(PLAN)?.noteId).toBe(NOTE_IDS.plan);
    expect(byPath.get(PICTURE)?.noteId).toBe(NOTE_IDS.picture);
    expect(byPath.get("1-projects/orphan.md")).toBeDefined();
    expect(byPath.get("1-projects/orphan.md")).not.toHaveProperty("noteId");
  });

  test("a trashed row is not in the manifest, so its note id is not either", async () => {
    const f = await fixture();
    await seedCopies(f);
    const body = await bodyOf(await gatewayPost(f.t, MANIFEST, { accessToken: OWNER, expectedWorkspaceId: f.ws }));
    const entries = body.entries as Array<{ noteId?: string }>;
    expect(entries.some((entry) => entry.noteId === NOTE_IDS.gone)).toBe(false);
  });
});
