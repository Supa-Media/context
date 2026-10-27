/**
 * The privacy etag a move is made under, in rows mode (`lib/nodes/readerRules.ts` `privacyEtagNow`).
 *
 * In rows mode the rows are the truth, so the etag a move hands out and the etag its guard compares
 * are both the rows' version: a row-only privacy change between the read and the move refuses it
 * (`rules_changed`), and no change lets it through. In file mode the etag stays the mirror's, unchanged.
 *
 * Sabotage: make `rowMove` compare `readMirror` again (the "rules_changed" tests pass wrongly);
 * return the file etag from `privacyEtagNow` (the end-to-end move refuses);
 * drop the grant-only version from `readerMirror`'s etag (the grant test passes wrongly);
 * hold every move of a batch to the handed etag (`privacyChecked` never set: the batch whose first move changes the
 * rules is refused), or none of them (the stale batch goes through).
 */

import { describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import { keyedFixture, privacyEtag, rowOf, treeOf } from "./keyedFixture.helpers";
import { start } from "./moveFixture.helpers";

type Fixture = Awaited<ReturnType<typeof keyedFixture>>;

async function rowsEtag(f: Fixture): Promise<string | null> {
  return await f.t.query(internal.functions.nodesAccess.privacyEtagNow, { workspaceId: f.ws });
}


async function setBase(f: Fixture, path: string, base: "private" | "team"): Promise<void> {
  await f.t.mutation(internal.functions.nodesAccess.setAccess, {
    workspaceId: f.ws,
    path,
    base,
    actor: { userId: f.ownerId, role: "owner" },
  });
}

describe("the privacy etag a move is made under", () => {

  test("rows mode: a row-only privacy change between the read and the move refuses the move", async () => {
    const f = await keyedFixture();
    const read = await rowsEtag(f);
    expect(read).toMatch(/^rows:/);

    // Only the rows change; the file's etag does not move, so only a rows-judged guard can see it.
    await setBase(f, "1-projects/keep.md", "private");
    expect(await rowsEtag(f)).not.toBe(read);

    const before = await treeOf(f);
    const answer = await f.t.mutation(internal.functions.nodeRowMoves.rowMove, {
      workspaceId: f.ws,
      from: "1-projects/keep.md",
      to: "1-projects/kept.md",
      privacyEtag: read,
      now: Date.now(),
    });
    expect(answer).toEqual({ ok: false, reason: "rules_changed" });
    expect(await treeOf(f)).toEqual(before);
  });

  test("rows mode: a grant-only change between the read and the move refuses too", async () => {
    const f = await keyedFixture();
    // The base is set first and then left alone, so the rendered member rules do not move: only the grant does.
    await setBase(f, "1-projects/keep.md", "team");
    const read = await rowsEtag(f);
    await f.t.mutation(internal.functions.nodesAccess.setAccess, {
      workspaceId: f.ws,
      path: "1-projects/keep.md",
      base: "team",
      grantees: [{ kind: "email", email: "reader@example.test", role: "view" }] as never,
      actor: { userId: f.ownerId, role: "owner" },
    });
    expect(await rowsEtag(f)).not.toBe(read);
    const answer = await f.t.mutation(internal.functions.nodeRowMoves.rowMove, {
      workspaceId: f.ws,
      from: "1-projects/keep.md",
      to: "1-projects/kept.md",
      privacyEtag: read,
      now: Date.now(),
    });
    expect(answer).toEqual({ ok: false, reason: "rules_changed" });
  });

  test("rows mode: no change between the read and the move lets it through", async () => {
    const f = await keyedFixture();
    const read = await rowsEtag(f);
    const answer = await f.t.mutation(internal.functions.nodeRowMoves.rowMove, {
      workspaceId: f.ws,
      from: "1-projects/keep.md",
      to: "1-projects/kept.md",
      privacyEtag: read,
      now: Date.now(),
    });
    expect(answer).toMatchObject({ ok: true });
    expect(await rowOf(f, "1-projects/kept.md")).toBeDefined();
  });

  test("rows mode: a move started end to end is handed the rows etag and goes through", async () => {
    const f = await keyedFixture();
    const moved = await start(f, "1-projects/keep.md", "1-projects/kept.md");
    expect(moved).toMatchObject({ from: "1-projects/keep.md", to: "1-projects/kept.md", rowed: true });
  });

  test("a batch is held to the handed version once: a stale one is refused whole", async () => {
    const f = await keyedFixture();
    const read = await rowsEtag(f);
    await setBase(f, "1-projects/keep.md", "private");
    const before = await treeOf(f);
    await expect(
      f.t.mutation(internal.functions.nodeRowMoves.rowMoveBatch, {
        workspaceId: f.ws,
        moves: [
          { from: "3-resources/r.md", to: "3-resources/r2.md" },
          { from: "1-projects/keep.md", to: "1-projects/kept.md" },
        ],
        privacyEtag: read,
        now: Date.now(),
      }),
    ).rejects.toThrow();
    expect(await treeOf(f)).toEqual(before);
  });

  test("a batch whose first move changes the rules still makes the rest: that change is its own", async () => {
    const f = await keyedFixture();
    // A note with a row of its own: moving it moves the row, so the rules' version moves with the first move.
    await setBase(f, "1-projects/keep.md", "private");
    const read = await rowsEtag(f);
    const moved = await f.t.mutation(internal.functions.nodeRowMoves.rowMoveBatch, {
      workspaceId: f.ws,
      moves: [
        { from: "1-projects/keep.md", to: "1-projects/kept.md" },
        { from: "3-resources/r.md", to: "3-resources/r2.md" },
      ],
      privacyEtag: read,
      now: Date.now(),
    });
    expect(moved.map((move) => move.to)).toEqual(["1-projects/kept.md", "3-resources/r2.md"]);
    expect(await rowsEtag(f)).not.toBe(read);
  });
});
