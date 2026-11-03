/**
 * Hiding old copies where the notes live in the workspace object (`lib/oldCopies/hideInObject.ts`): each copy is
 * moved by the object (`ws.write.move` with `trash: true`), Convex's own row move is not run, and nothing is pushed
 * back through the row outbox. A copy already gone or a hidden name taken is passed over; an object that throws or
 * says it is busy stops the page for the next pass; with no way to reach the object nothing is hidden.
 *
 * Sabotage (temporary local edits, reverted): ignoring the home runs `hideRows`, which moves Convex's rows and fails
 * the first case; treating every refusal as passed over fails the stopping case.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import type { Fixture } from "../nodes/moveFixture.helpers";
import { liveAt } from "../nodes/keyedFixture.helpers";
import { hideOldCopiesPass } from "../../functions/lib/oldCopies/hiding";
import { OLD_COPIES_ROOT } from "../../functions/lib/fileOps/store";
import type { OldCopyMover } from "../../functions/lib/oldCopies/hideInObject";
import { COPIES, OWN, copiesFixture } from "./oldCopies.helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

async function inObject(f: Fixture) {
  await f.t.run(async (ctx) => {
    await ctx.db.insert("workspaceObjectHomes", { workspaceId: f.ws, home: "object", since: 0 });
  });
}

function moverOf(reply: (path: string, call: number) => unknown | Error) {
  const calls: Array<{ from: string; to: string; trash: boolean; scope: string }> = [];
  const mover: OldCopyMover = {
    write: {
      move: async (body) => {
        calls.push(body);
        const answer = reply(body.from, calls.length);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
  return { mover, calls };
}

const moved = (from: string) => ({ ok: true, from, to: `${OLD_COPIES_ROOT}/${from}`, count: 1, at: 1, files: [{ from, to: `${OLD_COPIES_ROOT}/${from}` }] });
const outbox = (f: Fixture) => f.t.run(async (ctx) => await ctx.db.query("workspaceObjectOutbox").collect());
const allCopies = [...COPIES.days, ...COPIES.contacts, ...COPIES.files];

describe("hiding old copies in the workspace object", () => {
  test("the object moves each copy among the old copies; Convex's rows are left to the mirror, and nothing is pushed back", async () => {
    const f = await copiesFixture();
    await inObject(f);
    const { mover, calls } = moverOf((path) => moved(path));
    const pass = await hideOldCopiesPass(f.ctx, f.ws, f.store, null, null, () => mover);

    expect(pass).toMatchObject({ days: COPIES.days.length, contacts: COPIES.contacts.length, files: COPIES.files.length });
    expect(pass.stopped).toBeUndefined();
    expect(calls.map((call) => call.from).sort()).toEqual([...allCopies].sort());
    for (const call of calls) expect(call).toEqual({ from: call.from, to: `${OLD_COPIES_ROOT}/${call.from}`, trash: true, scope: "private" });
    for (const path of OWN) expect(calls.some((call) => call.from === path)).toBe(false);
    // The object is the record: Convex's copy moves when the mirror brings the change back, not here.
    for (const path of allCopies) expect(await liveAt(f, path)).toBe(true);
    expect(await outbox(f)).toEqual([]);
  });

  test("a copy already gone, or one whose hidden name is taken, is passed over and the page goes on", async () => {
    const f = await copiesFixture();
    await inObject(f);
    const { mover, calls } = moverOf((path, call) => (call === 1 ? { ok: false, code: "NOT_FOUND" } : call === 2 ? { ok: false, code: "TAKEN" } : moved(path)));
    const pass = await hideOldCopiesPass(f.ctx, f.ws, f.store, null, null, () => mover);
    expect(pass.stopped).toBeUndefined();
    expect(calls).toHaveLength(allCopies.length);
    expect(pass.days + pass.contacts + pass.files).toBe(allCopies.length - 2);
  });

  for (const [why, reply, stopped] of [
    ["an object out of reach", new Error("down"), "not_served"],
    ["a busy object", { ok: false, code: "BUSY" }, "busy"],
    ["a move the control plane must decide", { ok: false, code: "DEFER" }, "defer"],
  ] as const) {
    test(`${why} stops the page where it began, for the next pass`, async () => {
      const f = await copiesFixture();
      await inObject(f);
      const { mover, calls } = moverOf(() => reply);
      const pass = await hideOldCopiesPass(f.ctx, f.ws, f.store, null, null, () => mover);
      expect(pass.stopped).toBe(stopped);
      expect(pass.cursor).toBeNull();
      expect(calls).toHaveLength(1);
      for (const path of allCopies) expect(await liveAt(f, path)).toBe(true);
    });
  }

  test("with no way to reach the object nothing is hidden, and Convex's rows are not moved", async () => {
    const f = await copiesFixture();
    await inObject(f);
    const pass = await hideOldCopiesPass(f.ctx, f.ws, f.store, null, "a-cursor", () => null);
    expect(pass).toMatchObject({ stopped: "not_served", cursor: "a-cursor", days: 0, contacts: 0, files: 0 });
    for (const path of allCopies) expect(await liveAt(f, path)).toBe(true);
    expect(await outbox(f)).toEqual([]);
  });

  test("a workspace whose notes are in the bucket never asks the object: Convex moves its rows as before", async () => {
    const f = await copiesFixture();
    const { mover, calls } = moverOf((path) => moved(path));
    const pass = await hideOldCopiesPass(f.ctx, f.ws, f.store, null, null, () => mover);
    expect(calls).toEqual([]);
    expect(pass.days).toBe(COPIES.days.length);
    for (const path of allCopies) expect(await liveAt(f, path)).toBe(false);
  });
});
