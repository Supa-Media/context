/**
 * A queued move keeps its notes' ids and copies (`lib/nodes/moveWork.ts`,
 * `carryIdentity`): the target takes the source's id, and its copy when that
 * copy is still the same bytes, keyed the same way.
 *
 * Sabotage: drop the `carryMoved` call from `observeMoved` and both
 * assertions fail (the target gets a new id and no copy).
 */

import { describe, expect, test } from "vitest";
import { drain, fixture, start } from "../nodes/moveFixture.helpers";
import { copyIsFresh, idKeyFor } from "../../functions/lib/nodes/noteIds";
import { rowAt } from "./noteIds.helpers";

describe("a queued move carries ids and copies", () => {
  test("a moved note keeps its id, and a copy that was fresh is kept, keyed by the same id", async () => {
    const f = await fixture();
    const source = await rowAt(f.t, f.ws, "1-projects/launch/brief.md");
    const copy = { key: idKeyFor(source!.noteId!, "1-projects/launch/brief.md"), etag: source!.etag!, copiedAt: 7 };
    await f.t.run((ctx) => ctx.db.patch(source!._id, { idCopy: copy }));

    await start(f, "1-projects/launch", "3-resources/launch");
    await drain(f);

    const moved = await rowAt(f.t, f.ws, "3-resources/launch/brief.md");
    expect(moved?.noteId).toBe(source!.noteId);
    // The copy is the same bytes under the same key, now judged by the target's own etag
    // (the source's etag is gone with the source row). A later re-check may move the target's
    // etag again; that costs one more copy and never a wrong one.
    expect(moved?.idCopy).toMatchObject({ key: copy.key, copiedAt: 7 });
    expect(moved?.idCopy?.etag).not.toBe(copy.etag);
    expect(await rowAt(f.t, f.ws, "1-projects/launch/brief.md")).toMatchObject({ goneAt: expect.any(Number) });
  });

  test("a copy that was already stale is carried stale, so the next pass copies it", async () => {
    const f = await fixture();
    const source = await rowAt(f.t, f.ws, "1-projects/launch/plan.md");
    await f.t.run((ctx) => ctx.db.patch(source!._id, { idCopy: { key: idKeyFor(source!.noteId!, "1-projects/launch/plan.md"), etag: "an-older-version", copiedAt: 7 } }));

    await start(f, "1-projects/launch", "3-resources/launch");
    await drain(f);

    const moved = await rowAt(f.t, f.ws, "3-resources/launch/plan.md");
    expect(moved?.noteId).toBe(source!.noteId);
    expect(moved?.idCopy?.etag).toBe("an-older-version");
    expect(copyIsFresh(moved!)).toBe(false);
  });

  test("a note moved to a name with another extension is not carried under the old key", async () => {
    const f = await fixture();
    const source = await rowAt(f.t, f.ws, "1-projects/launch/pic.png");
    await f.t.run((ctx) => ctx.db.patch(source!._id, { idCopy: { key: idKeyFor(source!.noteId!, "1-projects/launch/pic.png"), etag: source!.etag!, copiedAt: 7 } }));

    await start(f, "1-projects/launch", "3-resources/launch");
    await drain(f);

    const moved = await rowAt(f.t, f.ws, "3-resources/launch/pic.png");
    expect(moved?.noteId).toBe(source!.noteId);
    expect(moved?.idCopy?.key).toBe(`files/${source!.noteId}.png`);
    expect(moved?.idCopy?.etag).toBe(moved!.etag);
  });
});
