/**
 * `POST /gateway/note-ids/wrote` (`functions/lib/noteIds/http.ts`): the gateway
 * says it wrote the same bytes to a path and to its id key, and the copy is
 * recorded only if that is true of the row.
 *
 * What is proved:
 *  - a write to the id key the row's own id gives is recorded, with the etag
 *    given and the time, and a lookup then calls the copy fresh once the row's
 *    etag is that etag;
 *  - a key that is not the row's id key is not recorded, nor is a trashed row,
 *    a row with no id, or a path with no row;
 *  - only a grant that may write this workspace records anything: a member
 *    (read-only role) and another workspace's editor are refused and nothing is
 *    recorded.
 *
 * Sabotage (temporary local edit, reverted): comparing only the key's prefix
 * in `recordCopy`, or dropping the `goneAt` check, makes the matching-key and
 * trashed-row cases fail.
 */

import { describe, expect, test } from "vitest";
import { gatewayPost, responseFingerprint } from "../fixtures.helpers";
import { bodyOf } from "../controlPlane/fixtures.helpers";
import { idKeyFor } from "../../functions/lib/nodes/noteIds";
import {
  EDITOR,
  GONE,
  MEMBER,
  MISSING,
  NOTE_IDS,
  NO_COPY,
  ORPHAN,
  OUTSIDER,
  OWNER,
  PLAN,
  fixture,
  patchRow,
  rowOf,
  seedCopies,
  type Fixture,
} from "./noteIdsGateway.helpers";

const WROTE = "/gateway/note-ids/wrote";
const NEW_ETAG = "etag-after-the-write";

async function wrote(f: Fixture, body: Record<string, unknown>, options: { secret?: string | null } = {}) {
  return await gatewayPost(f.t, WROTE, body, options);
}

function writeOf(f: Fixture, accessToken: string, path: string, key: string, etag = NEW_ETAG) {
  return { accessToken, workspaceId: f.ws, path, key, etag };
}

describe("POST /gateway/note-ids/wrote", () => {
  test("records a copy whose key is the row's own id key, with the etag and the time", async () => {
    const f = await fixture();
    await seedCopies(f);
    const key = idKeyFor(NOTE_IDS.noCopy, NO_COPY);
    const body = await bodyOf(await wrote(f, writeOf(f, EDITOR, NO_COPY, key)));
    expect(body).toEqual({ ok: true, recorded: true });
    const row = await rowOf(f.t, f.ws, NO_COPY);
    expect(row!.idCopy).toEqual({ key, etag: NEW_ETAG, copiedAt: expect.any(Number) });
  });

  test("once the row's etag is the one written, the lookup calls the copy fresh", async () => {
    const f = await fixture();
    await seedCopies(f);
    const key = idKeyFor(NOTE_IDS.noCopy, NO_COPY);
    await patchRow(f.t, f.ws, NO_COPY, { etag: NEW_ETAG });
    await wrote(f, writeOf(f, EDITOR, NO_COPY, key));
    const answer = await bodyOf(
      await gatewayPost(f.t, "/gateway/note-ids/lookup", { accessToken: OWNER, workspaceId: f.ws, paths: [NO_COPY] }),
    );
    expect((answer.copies as Record<string, unknown>)[NO_COPY]).toEqual({ key, etag: NEW_ETAG, fresh: true });
  });

  test("a key that is not the row's id key is refused and nothing is recorded", async () => {
    const f = await fixture();
    await seedCopies(f);
    const before = await rowOf(f.t, f.ws, NO_COPY);
    const wrongId = await wrote(f, writeOf(f, EDITOR, NO_COPY, `notes/${NOTE_IDS.plan}.md`));
    expect(await bodyOf(wrongId)).toEqual({ ok: true, recorded: false });
    const wrongExtension = await wrote(f, writeOf(f, EDITOR, NO_COPY, `files/${NOTE_IDS.noCopy}.md`));
    expect(await bodyOf(wrongExtension)).toEqual({ ok: true, recorded: false });
    const after = await rowOf(f.t, f.ws, NO_COPY);
    expect(after!.idCopy).toEqual(before!.idCopy);
  });

  test("a trashed row, a row with no id, and a path with no row are not recorded", async () => {
    const f = await fixture();
    await seedCopies(f);
    expect(await bodyOf(await wrote(f, writeOf(f, EDITOR, GONE, `notes/${NOTE_IDS.gone}.md`)))).toEqual({
      ok: true,
      recorded: false,
    });
    expect(await bodyOf(await wrote(f, writeOf(f, EDITOR, ORPHAN, `notes/${NOTE_IDS.noCopy}.md`)))).toEqual({
      ok: true,
      recorded: false,
    });
    expect(await bodyOf(await wrote(f, writeOf(f, EDITOR, MISSING, `notes/${NOTE_IDS.noCopy}.md`)))).toEqual({
      ok: true,
      recorded: false,
    });
    expect((await rowOf(f.t, f.ws, ORPHAN))!.idCopy).toBeUndefined();
  });

  test("a grant that is not an owner or editor of this workspace records nothing", async () => {
    const f = await fixture();
    await seedCopies(f);
    const key = idKeyFor(NOTE_IDS.noCopy, NO_COPY);
    const asMember = await wrote(f, writeOf(f, MEMBER, NO_COPY, key));
    expect(await bodyOf(asMember)).toEqual({ served: false });
    const asOutsider = await wrote(f, writeOf(f, OUTSIDER, NO_COPY, key));
    expect(await bodyOf(asOutsider)).toEqual({ served: false });
    expect((await rowOf(f.t, f.ws, NO_COPY))!.idCopy).toBeUndefined();
  });

  test("a refused write is the same bytes as one for a workspace that does not exist", async () => {
    const f = await fixture();
    await seedCopies(f);
    const key = idKeyFor(NOTE_IDS.noCopy, NO_COPY);
    const forbidden = await responseFingerprint(await wrote(f, writeOf(f, MEMBER, NO_COPY, key)));
    const nonexistent = await responseFingerprint(
      await wrote(f, { ...writeOf(f, MEMBER, NO_COPY, key), workspaceId: f.ws.replace(/.$/, "x") }),
    );
    expect(forbidden).toBe(nonexistent);
  });

  test("a wrong gateway secret is refused, and a malformed body is a 400", async () => {
    const f = await fixture();
    await seedCopies(f);
    const key = idKeyFor(NOTE_IDS.noCopy, NO_COPY);
    expect((await wrote(f, writeOf(f, EDITOR, NO_COPY, key), { secret: "not-the-secret" })).status).toBe(401);
    expect((await wrote(f, { accessToken: EDITOR, workspaceId: f.ws, path: NO_COPY, key })).status).toBe(400);
    expect((await wrote(f, { ...writeOf(f, EDITOR, NO_COPY, key), etag: "" })).status).toBe(400);
  });
});
