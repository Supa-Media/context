/**
 * Dismissing the notice a move into another workspace left behind: whose
 * answer it is, and which outcomes may be answered for good. Split out of
 * `contextMoves.test.ts`, which keeps who may start a move and what its row says.
 */

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { addMember, asUser, captureError, createUser, createWorkspace, drainScheduled, errorCode, setupTest, type TestConvex } from "./fixtures.helpers";

async function twoContexts(t: TestConvex): Promise<{
  owner: Id<"users">;
  mine: Id<"workspaces">;
  theirs: Id<"workspaces">;
  them: Id<"users">;
}> {
  const owner = await createUser(t, "owner@example.invalid");
  const them = await createUser(t, "them@example.invalid");
  const mine = await createWorkspace(t, owner, "ada-context");
  const theirs = await createWorkspace(t, them, "bee-context", { kind: "shared" });
  return { owner, them, mine, theirs };
}

function start(
  t: TestConvex,
  userId: Id<"users">,
  args: {
    sourceWorkspaceId: Id<"workspaces">;
    from: string;
    destinationWorkspaceId: Id<"workspaces">;
    to: string;
  },
) {
  return asUser(t, userId).action(api.functions.contextMoves.startContextMove, args);
}


/**
 * A NOTICE THAT CANNOT BE ANSWERED IS A NOTICE PEOPLE READ PAST.
 *
 * A finished row stays listable for a day, and on purpose: a move that ends
 * while nobody is looking still has to reach the person who started it. The
 * cost of that is a line which comes back — and for a while it came back on
 * every launch, because the only record of "I have read this" was one
 * component's `useState`. Somebody who moved a single note saw "Moved 1 note
 * to @supa." every time they opened the app for the next twenty-four hours,
 * pressing a Dismiss button that worked until they closed it.
 *
 * So dismissal is a fact about the row. Which brings two obligations with it:
 *
 *  - **It is the owner's to record**, re-asked rather than read off the row,
 *    because `listContextMoves` is owner-only and a control over a notice its
 *    caller was never shown is not a control.
 *  - **Only a move that finished cleanly.** The sharp one, and the reason the
 *    obvious version of this change is a data-loss trap: a *failed* move's
 *    notice carries the only control that can finish it. The destination-root
 *    check runs while nothing has landed, so a resume walks past it and a
 *    fresh move over the same folder is refused against the half already
 *    carried. One press must not be able to hide that for good.
 */
describe("dismissing what a finished move said", () => {
  /** A move that got where it was going. Inserted, because this fixture has
   *  no bucket to move anything into — every scheduled pass here fails, and
   *  the clean outcome is the one this behavior is about. */
  async function completed(
    t: TestConvex,
    source: Id<"workspaces">,
    destination: Id<"workspaces">,
    actorUserId: Id<"users">,
  ): Promise<Id<"contextMoves">> {
    return await t.run((ctx) =>
      ctx.db.insert("contextMoves", {
        sourceWorkspaceId: source,
        destinationWorkspaceId: destination,
        actorUserId,
        from: "1-projects/acme.md",
        to: "acme.md",
        status: "complete" as const,
        movedObjects: 1,
        movedBytes: 40,
        skipped: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        completedAt: Date.now(),
      }),
    );
  }

  function listedBy(t: TestConvex, userId: Id<"users">, workspaceId: Id<"workspaces">) {
    return asUser(t, userId).query(api.functions.contextMoves.listContextMoves, { workspaceId });
  }

  test("the row stops being listed, and stays that way on the next launch", async () => {
    const t = setupTest();
    const { owner, mine, theirs } = await twoContexts(t);
    const moveId = await completed(t, mine, theirs, owner);
    expect((await listedBy(t, owner, mine)).map((row) => row.moveId)).toEqual([moveId]);

    const answer = await asUser(t, owner).mutation(
      api.functions.contextMoves.dismissContextMove,
      { moveId },
    );
    expect(answer).toEqual({ dismissed: true });

    // This query is the whole of the console's memory — every launch asks it
    // again — so this is what "it does not come back tomorrow" means.
    expect(await listedBy(t, owner, mine)).toEqual([]);
  });

  test("pressing it twice is not an error", async () => {
    const t = setupTest();
    const { owner, mine, theirs } = await twoContexts(t);
    const moveId = await completed(t, mine, theirs, owner);
    await asUser(t, owner).mutation(api.functions.contextMoves.dismissContextMove, { moveId });
    const again = await asUser(t, owner).mutation(
      api.functions.contextMoves.dismissContextMove,
      { moveId },
    );
    // Two devices can both have the line on screen.
    expect(again).toEqual({ dismissed: true });
  });

  test("an editor of the source may not answer for the owner", async () => {
    const t = setupTest();
    const { owner, them, mine, theirs } = await twoContexts(t);
    const moveId = await completed(t, mine, theirs, owner);
    await addMember(t, mine, them, "editor");

    const error = await captureError(() =>
      asUser(t, them).mutation(api.functions.contextMoves.dismissContextMove, { moveId }),
    );

    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
    expect((await listedBy(t, owner, mine)).map((row) => row.moveId)).toEqual([moveId]);
  });

  test("a move still carrying notes cannot be dismissed", async () => {
    const t = setupTest();
    const { owner, mine, theirs } = await twoContexts(t);
    await addMember(t, theirs, owner, "editor");
    const { moveId } = await start(t, owner, {
      sourceWorkspaceId: mine,
      from: "1-projects/acme",
      destinationWorkspaceId: theirs,
      to: "work/acme",
    });

    const answer = await asUser(t, owner).mutation(
      api.functions.contextMoves.dismissContextMove,
      { moveId },
    );

    // Nothing to have read yet, and hiding the row would hide the only thing
    // on screen saying work is outstanding.
    expect(answer).toEqual({ dismissed: false });
    expect((await listedBy(t, owner, mine)).map((row) => row.moveId)).toEqual([moveId]);
  });

  /**
   * THE ONE THAT WOULD HAVE COST SOMEBODY THEIR NOTES.
   *
   * A failed move has already carried part of a folder into the other
   * context. `resumeContextMove` finishes it; a fresh move of the same folder
   * cannot, because `importContextMoveBatch` refuses to land on a root that
   * exists and the half already there is exactly that root. So the Resume
   * button on that notice is the clean way out, and a Dismiss that outlived
   * the session would take it off the screen for good.
   */
  describe("a move that stopped", () => {
    async function failed(t: TestConvex): Promise<{
      owner: Id<"users">;
      mine: Id<"workspaces">;
      moveId: Id<"contextMoves">;
    }> {
      const { owner, mine, theirs } = await twoContexts(t);
      await addMember(t, theirs, owner, "editor");
      const { moveId } = await start(t, owner, {
        sourceWorkspaceId: mine,
        from: "1-projects/acme",
        destinationWorkspaceId: theirs,
        to: "work/acme",
      });
      // No bucket is bound in this fixture, so every pass fails and the row
      // settles on the status this block is about.
      await drainScheduled(t);
      expect(await t.run((ctx) => ctx.db.get(moveId))).toMatchObject({ status: "failed" });
      return { owner, mine, moveId };
    }

    /** A failed move that had already carried part of the folder across. */
    async function failedPartway(t: TestConvex) {
      const made = await failed(t);
      await t.run((ctx) => ctx.db.patch(made.moveId, { movedObjects: 3 }));
      return made;
    }

    test("having carried nothing, can be answered for good: there is no half to reunite", async () => {
      const t = setupTest();
      const { owner, mine, moveId } = await failed(t);

      const answer = await asUser(t, owner).mutation(api.functions.contextMoves.dismissContextMove, { moveId });

      // A refusal here is what kept a failed move's line on every launch with nothing to finish.
      expect(answer).toEqual({ dismissed: true });
      expect(await listedBy(t, owner, mine)).toEqual([]);
    });

    test("partway, cannot be answered for good, because its notice is how it gets finished", async () => {
      const t = setupTest();
      const { owner, mine, moveId } = await failedPartway(t);

      const answer = await asUser(t, owner).mutation(
        api.functions.contextMoves.dismissContextMove,
        { moveId },
      );

      // Refused, and still listed: the console may put it aside for the
      // session, and tomorrow it says so again, because it is still true.
      expect(answer).toEqual({ dismissed: false });
      expect((await listedBy(t, owner, mine)).map((row) => row.moveId)).toEqual([moveId]);
      expect((await t.run((ctx) => ctx.db.get(moveId)))?.dismissedAt).toBeUndefined();
    });

    test("and is still resumable afterwards", async () => {
      const t = setupTest();
      const { owner, moveId } = await failedPartway(t);
      await asUser(t, owner).mutation(api.functions.contextMoves.dismissContextMove, { moveId });

      const { resumed } = await asUser(t, owner).action(
        api.functions.contextMoves.resumeContextMove,
        { moveId },
      );

      expect(resumed).toBe(true);
    });

    test("a resumed move is never a dismissed one", async () => {
      const t = setupTest();
      const { owner, mine, moveId } = await failed(t);
      // Reached directly rather than through the mutation, which refuses it
      // today. `reopenMove`'s contract is about the row it hands on, whatever
      // wrote the flag — and it is what keeps a widening of
      // `dismissContextMove` from making the *next* outcome finish in silence.
      await t.run((ctx) => ctx.db.patch(moveId, { dismissedAt: Date.now() }));

      await asUser(t, owner).action(api.functions.contextMoves.resumeContextMove, { moveId });

      expect((await t.run((ctx) => ctx.db.get(moveId)))?.dismissedAt).toBeUndefined();
      await drainScheduled(t);
      expect((await listedBy(t, owner, mine)).map((row) => row.moveId)).toEqual([moveId]);
    });
  });
});
