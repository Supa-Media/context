/**
 * What a move in flight tells a caller who may not see it.
 *
 * A move under way answers "Something there is still moving" (`CONFLICT`) when
 * the names a caller asks for overlap it, from `rowMoveFor` / `rowMoveOverlaps`
 * (`lib/nodes/rowMoveStart.ts`). It answered before asking whether the caller may see either name, so a
 * `team` caller could tell a private folder being moved from nothing at all:
 * `CONFLICT` where a free name gives `FILE_NOT_FOUND`. Inference is disclosure
 * here, so the refusal has to be the one a free name gives.
 *
 * Each case fails if the visibility check in front of the busy refusal goes:
 * the probe answers `CONFLICT` and stops matching its control.
 */

import { describe, expect, test } from "vitest";
import type { Id } from "../../_generated/dataModel";
import { startRowTrash } from "../../functions/lib/nodes/rowTrash";
import { OWNER, TEAM, start, type Fixture as FixtureOf } from "./moveFixture.helpers";
import { keyedFixture } from "./keyedFixture.helpers";

const SECRET = "1-projects/secret";
/** A big private folder, mid-move. The rows beneath it are beside the point: the record is what is read. */
const MOVING = `${SECRET}/big`;
const LANDING = `${SECRET}/moved`;

/** A keyed chunked move of `MOVING`, recorded as still moving, as `beginChunkedMove` records one. */
async function keyedMoveInFlight(f: FixtureOf): Promise<Id<"rowMoves">> {
  return await f.t.run(async (ctx) =>
    await ctx.db.insert("rowMoves", {
      workspaceId: f.ws,
      from: MOVING,
      to: LANDING,
      trash: false,
      state: "moving",
      scope: "private",
      grantedNames: [],
      privacyEtag: null,
      pass: 1,
      moved: 1,
      left: 0,
      now: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

/** The error a move throws, as a code, or `"ok"` when it did not throw. */
async function codeOf(made: Promise<unknown>): Promise<string> {
  try {
    await made;
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  }
}

describe("a move in flight inside a private folder is invisible to a team caller", () => {
  test("keyed: probing the moving folder itself answers what a free private name answers", async () => {
    const f = await keyedFixture();
    const control = await codeOf(start(f, `${SECRET}/none`, "1-projects/none", TEAM));
    expect(control).toBe("FILE_NOT_FOUND");

    await keyedMoveInFlight(f);
    expect(await codeOf(start(f, MOVING, "1-projects/none", TEAM))).toBe(control);
    // An ancestor and a child of the moving name are the same probe by another spelling.
    expect(await codeOf(start(f, `${MOVING}/inside.md`, "1-projects/none", TEAM))).toBe(control);
  });

  test("keyed: probing a landing place inside the moving folder answers the same", async () => {
    const f = await keyedFixture();
    const control = await codeOf(start(f, "1-projects/keep.md", `${MOVING}/keep.md`, TEAM));
    expect(control).toBe("FILE_NOT_FOUND");

    await keyedMoveInFlight(f);
    expect(await codeOf(start(f, "1-projects/keep.md", `${MOVING}/keep.md`, TEAM))).toBe(control);
    expect(await codeOf(start(f, "1-projects/keep.md", `${LANDING}/keep.md`, TEAM))).toBe(control);
  });

  test("keyed: the owner, who may see it, is still told to wait", async () => {
    const f = await keyedFixture();
    await keyedMoveInFlight(f);
    expect(await codeOf(start(f, MOVING, "1-projects/elsewhere", OWNER))).toBe("CONFLICT");
  });

  test("keyed trash: asking to trash the moving folder answers what a free private name answers", async () => {
    const f = await keyedFixture();
    const trash = (path: string, clearance: typeof TEAM) =>
      startRowTrash(f.ctx, { workspaceId: f.ws, store: f.store, path, clearance, now: Date.now() });
    const control = await codeOf(trash(`${SECRET}/none`, TEAM));
    expect(control).toBe("FILE_NOT_FOUND");

    await keyedMoveInFlight(f);
    expect(await codeOf(trash(MOVING, TEAM))).toBe(control);
    expect(await codeOf(trash(`${MOVING}/inside.md`, TEAM))).toBe(control);
    // The owner, who may see it, is still told to wait.
    expect(await codeOf(trash(MOVING, OWNER))).toBe("CONFLICT");
  });
});
