/**
 * `POST /gateway/note-ids/lookup` (`functions/lib/noteIds/http.ts`): the id
 * key and copy etag for each path the gateway names, for the reader's own
 * workspace only.
 *
 * What is proved:
 *  - a live file with an id answers its key, the copy's etag, and whether the
 *    copy is still true (`fresh`), and nothing else is in the answer;
 *  - a stale copy, a file with no copy, a trashed file, a path with no row and
 *    a file the tree has given no id are all answered (or left out) as they are;
 *  - a path the reader may not see is left out, as a path with no row is;
 *  - a member of another workspace, a bad gateway secret and a missing token get
 *    refusals, and a request of more than 200 paths (or none) is a 400.
 *
 * Sabotage (temporary local edits, reverted):
 *  - dropping `copyIsFresh` for `fresh` (answering `true` for every row with a
 *    copy): the stale-copy case fails;
 *  - dropping the `visible` filter: the team member case fails;
 *  - dropping the `goneAt` check in `copiesFor`: the trashed-file case fails;
 *  - dropping the 200-path bound: the 201-path case fails.
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
  PICTURE,
  PLAN,
  SECRET,
  STALE,
  fixture,
  seedCopies,
  type Fixture,
} from "./noteIdsGateway.helpers";

const LOOKUP = "/gateway/note-ids/lookup";

async function lookup(f: Fixture, body: Record<string, unknown>, options: { secret?: string | null } = {}) {
  return await gatewayPost(f.t, LOOKUP, body, options);
}

describe("POST /gateway/note-ids/lookup", () => {
  test("answers each live file's key, its copy's etag and whether the copy is still true", async () => {
    const f = await fixture();
    await seedCopies(f);
    const response = await lookup(f, {
      accessToken: OWNER,
      workspaceId: f.ws,
      paths: [PLAN, STALE, NO_COPY, PICTURE],
    });
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(body).toEqual({
      copies: {
        [PLAN]: { key: `notes/${NOTE_IDS.plan}.md`, etag: `e-${PLAN}`, keyEtag: null, fresh: true },
        [STALE]: { key: `notes/${NOTE_IDS.stale}.md`, etag: "an-older-etag", keyEtag: null, fresh: false },
        [NO_COPY]: { key: `notes/${NOTE_IDS.noCopy}.md`, etag: null, keyEtag: null, fresh: false },
        [PICTURE]: { key: `files/${NOTE_IDS.picture}.png`, etag: `e-${PICTURE}`, keyEtag: null, fresh: true },
      },
    });
  });

  test("the key is the one the id-key rule gives, so the gateway and the copy agree on it", async () => {
    const f = await fixture();
    await seedCopies(f);
    const body = await bodyOf(await lookup(f, { accessToken: OWNER, workspaceId: f.ws, paths: [PICTURE] }));
    const copies = body.copies as Record<string, { key: string }>;
    expect(copies[PICTURE].key).toBe(idKeyFor(NOTE_IDS.picture, PICTURE));
  });

  test("a path with no row, a trashed file and a file with no id are left out", async () => {
    const f = await fixture();
    await seedCopies(f);
    const body = await bodyOf(
      await lookup(f, { accessToken: OWNER, workspaceId: f.ws, paths: [MISSING, GONE, ORPHAN, PLAN] }),
    );
    expect(Object.keys(body.copies as object)).toEqual([PLAN]);
  });

  test("a team reader is not told the copy of a note in a private folder, and an owner is", async () => {
    const f = await fixture();
    await seedCopies(f);
    const asMember = await bodyOf(await lookup(f, { accessToken: MEMBER, workspaceId: f.ws, paths: [SECRET, PLAN] }));
    expect(Object.keys(asMember.copies as object)).toEqual([PLAN]);
    const asOwner = await bodyOf(await lookup(f, { accessToken: OWNER, workspaceId: f.ws, paths: [SECRET] }));
    expect((asOwner.copies as Record<string, unknown>)[SECRET]).toEqual({
      key: `notes/${NOTE_IDS.secret}.md`,
      etag: `e-${SECRET}`,
      keyEtag: null,
      fresh: true,
    });
  });

  test("a grant of another workspace's member is refused, and nothing of this workspace is answered", async () => {
    const f = await fixture();
    await seedCopies(f);
    const response = await lookup(f, { accessToken: OUTSIDER, workspaceId: f.ws, paths: [PLAN] });
    expect(await bodyOf(response)).toEqual({ served: false });
    const reverse = await lookup(f, { accessToken: MEMBER, workspaceId: f.other, paths: ["1-projects/theirs.md"] });
    expect(await bodyOf(reverse)).toEqual({ served: false });
  });

  test("a refused request is the same bytes as one for a workspace that does not exist", async () => {
    const f = await fixture();
    await seedCopies(f);
    const forbidden = await responseFingerprint(await lookup(f, { accessToken: OUTSIDER, workspaceId: f.ws, paths: [PLAN] }));
    const nonexistent = await responseFingerprint(
      await lookup(f, { accessToken: OUTSIDER, workspaceId: f.ws.replace(/.$/, "x"), paths: [PLAN] }),
    );
    expect(forbidden).toBe(nonexistent);
  });

  test("a missing or unknown access token is refused, and so is a token for nothing", async () => {
    const f = await fixture();
    await seedCopies(f);
    expect(await bodyOf(await lookup(f, { workspaceId: f.ws, paths: [PLAN] }))).toEqual({ served: false });
    expect(await bodyOf(await lookup(f, { accessToken: "cat_nobody", workspaceId: f.ws, paths: [PLAN] }))).toEqual({
      served: false,
    });
  });

  test("a wrong gateway secret, or none, is refused before anything is read", async () => {
    const f = await fixture();
    await seedCopies(f);
    const body = { accessToken: OWNER, workspaceId: f.ws, paths: [PLAN] };
    expect((await lookup(f, body, { secret: "not-the-secret" })).status).toBe(401);
    expect((await lookup(f, body, { secret: null })).status).toBe(401);
  });

  test("more than 200 paths, no paths, or a path list that is not one is a 400", async () => {
    const f = await fixture();
    await seedCopies(f);
    const many = Array.from({ length: 201 }, (_, index) => `1-projects/many-${index}.md`);
    expect((await lookup(f, { accessToken: OWNER, workspaceId: f.ws, paths: many })).status).toBe(400);
    expect((await lookup(f, { accessToken: OWNER, workspaceId: f.ws, paths: [] })).status).toBe(400);
    expect((await lookup(f, { accessToken: OWNER, workspaceId: f.ws, paths: PLAN })).status).toBe(400);
    expect((await lookup(f, { accessToken: OWNER, workspaceId: f.ws, paths: [1] })).status).toBe(400);
  });

  test("exactly 200 paths is accepted", async () => {
    const f = await fixture();
    await seedCopies(f);
    const paths = Array.from({ length: 200 }, (_, index) => `1-projects/many-${index}.md`);
    paths[0] = PLAN;
    const response = await lookup(f, { accessToken: OWNER, workspaceId: f.ws, paths });
    expect(response.status).toBe(200);
    expect(Object.keys((await bodyOf(response)).copies as object)).toEqual([PLAN]);
  });
});
