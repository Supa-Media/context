/**
 * WHO MAY MOVE SOMETHING OUT OF A CONTEXT, AND WHAT THE ROW SAYS AFTERWARDS.
 *
 * The bytes are `contextMove.test.ts`'s subject. This file is about the two
 * questions that have to be settled before any bucket is opened at all, plus
 * the one thing a person watching the screen depends on.
 *
 *  - **`owner` on the source, `editor` on the destination.** The asymmetry is
 *    the product decision. Taking something out of a context removes it from
 *    everybody who could read it there, which is not a call an editor invited
 *    to help with one project gets to make; putting something into a context
 *    is an ordinary write, which is exactly what `editor` means. A test for
 *    each, in both directions, because a single `requireWorkspaceRole` with
 *    the wrong argument reads perfectly well and is a cross-tenant write.
 *  - **Both checks happen in the mutation that opens the row**, before a
 *    credential is decrypted and before anything is scheduled. A refusal after
 *    the first batch would already have copied a stranger's note somewhere.
 *  - **A stopped move can be picked up, and picking it up re-asks both
 *    questions.** A person can have been removed from either context since
 *    they pressed Move; the row remembers who they were, not what they may do.
 *  - **A move that cannot run says so on the row.** Everything here runs
 *    against workspaces with no storage bound, so every scheduled pass fails —
 *    which is the case this asserts on, because a pass that threw and left the
 *    row reading `moving` forever is the state nobody can act on and nobody
 *    can tell from a slow one.
 */

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import * as contextMoveFunctions from "../functions/contextMoves";
import type { Id } from "../_generated/dataModel";
import {
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  drainScheduled,
  errorCode,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";

/**
 * A refusal compared as a whole, not by its code.
 *
 * Local rather than shared, exactly as `files.test.ts` keeps its own: two
 * refusals that differ only in a message are still two refusals a stranger can
 * tell apart, and a helper that compared codes would hide that.
 */
function errorShape(error: unknown): string {
  return JSON.stringify((error as { data?: unknown }).data ?? null);
}

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
 * THE ENUMERATION `files.test.ts` SAYS IT CANNOT DO FOR ME.
 *
 * Its own coverage check reads `functions/files.ts` alone and states the gap
 * plainly: "a file endpoint that lands in a different module … needs its own
 * entry, and no check here will say so." This module is exactly that, so this
 * is that entry — the same shape, against this module's own public surface, so
 * a fourth endpoint added here cannot arrive without an isolation test.
 *
 * The property is the one `isolation.test.ts` insists on everywhere: a refusal
 * about somebody else's context must be **byte-identical** to a refusal about a
 * context that never existed. "Both throw" is not enough — a different code, or
 * a different message, tells a stranger which of the two they guessed.
 */
describe("every endpoint here refuses a stranger the way it refuses nothing", () => {
  test("and the list of them is Convex's, not one somebody remembered to update", async () => {
    const t = setupTest();
    const { them, mine, theirs } = await twoContexts(t);
    const ghost = await createUser(t, "ghost@example.invalid");
    const nowhere = await createWorkspace(t, ghost, "cee-context");
    const move = await t.run((ctx) =>
      ctx.db.insert("contextMoves", {
        sourceWorkspaceId: mine,
        destinationWorkspaceId: theirs,
        actorUserId: ghost,
        from: "1-projects/acme",
        to: "work/acme",
        status: "failed" as const,
        movedObjects: 0,
        movedBytes: 0,
        skipped: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    // A move id that refers to nothing, made the same way the workspace one is:
    // insert and delete, so it is indistinguishable in shape from a live id.
    const gone = await t.run(async (ctx) => {
      const id = await ctx.db.insert("contextMoves", {
        sourceWorkspaceId: theirs,
        destinationWorkspaceId: mine,
        actorUserId: ghost,
        from: "a",
        to: "b",
        status: "failed" as const,
        movedObjects: 0,
        movedBytes: 0,
        skipped: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.delete(id);
      await ctx.db.delete(nowhere);
      return id;
    });

    // `them` owns `theirs` and has never been near `mine`.
    const as = asUser(t, them);
    const calls: Array<(workspaceId: Id<"workspaces">) => Promise<unknown>> = [
      (workspaceId) =>
        as.action(api.functions.contextMoves.startContextMove, {
          sourceWorkspaceId: workspaceId,
          from: "1-projects/acme",
          destinationWorkspaceId: theirs,
          to: "work/acme",
        }),
      (workspaceId) =>
        as.query(api.functions.contextMoves.listContextMoves, { workspaceId }),
      /*
        Takes a move id rather than a workspace id, so the stranger's two
        guesses are "a real move out of a context that is not mine" and "a move
        that is not there at all". Same requirement: the answers must not
        differ, or the id space becomes a way to ask whether somebody is in the
        middle of moving a folder.
      */
      (workspaceId) =>
        as.action(api.functions.contextMoves.resumeContextMove, {
          moveId: workspaceId === mine ? move : gone,
        }),
      /*
        Same id-space argument as `resumeContextMove` above, and it bites
        harder here: this one only ever *hides* a row, so the temptation is to
        treat a refusal as cosmetic. It is not. An endpoint that answered
        "nothing to dismiss" for a move that is not there and threw for one
        belonging to somebody else would let anyone holding an id learn that a
        stranger is moving a folder out of a context.
      */
      (workspaceId) =>
        as.mutation(api.functions.contextMoves.dismissContextMove, {
          moveId: workspaceId === mine ? move : gone,
        }),
    ];

    const covered = new Set(
      calls.flatMap((call) =>
        [...call.toString().matchAll(/api\.functions\.contextMoves\.(\w+)/g)].map((m) => m[1]),
      ),
    );
    const publicEndpoints = Object.entries(contextMoveFunctions)
      .filter(([, value]) => {
        const fn = value as { isPublic?: boolean; isHttp?: boolean } | null;
        return fn?.isPublic === true || fn?.isHttp === true;
      })
      .map(([name]) => name);
    expect(publicEndpoints.length).toBeGreaterThan(0);
    expect([...covered].sort()).toEqual([...publicEndpoints].sort());

    for (const call of calls) {
      const theirsError = await captureError(() => call(mine));
      const nowhereError = await captureError(() => call(nowhere));
      expect(errorShape(theirsError)).toBe(errorShape(nowhereError));
    }
  });
});

describe("who may start a move between contexts", () => {
  test("an owner of the source who can write the destination may", async () => {
    const t = setupTest();
    const { owner, mine, theirs } = await twoContexts(t);
    await addMember(t, theirs, owner, "editor");

    const { moveId } = await start(t, owner, {
      sourceWorkspaceId: mine,
      from: "1-projects/acme",
      destinationWorkspaceId: theirs,
      to: "work/acme",
    });

    const row = await t.run((ctx) => ctx.db.get(moveId));
    expect(row?.status).toBe("moving");
    expect(row?.from).toBe("1-projects/acme");
    expect(row?.to).toBe("work/acme");
  });

  test("an editor of the source may not — moving out is the owner's call", async () => {
    const t = setupTest();
    const { owner, them, mine, theirs } = await twoContexts(t);
    // `them` can write both: an editor here, the owner there. The only thing
    // they are missing is ownership of the context the note is leaving.
    await addMember(t, mine, them, "editor");

    const error = await captureError(() =>
      start(t, them, {
        sourceWorkspaceId: mine,
        from: "1-projects/acme",
        destinationWorkspaceId: theirs,
        to: "work/acme",
      }),
    );

    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
    expect(await t.run((ctx) => ctx.db.query("contextMoves").collect())).toEqual([]);
  });

  test("a member of the destination may not — a move is a write there", async () => {
    const t = setupTest();
    const { owner, mine, theirs } = await twoContexts(t);
    await addMember(t, theirs, owner, "member");

    const error = await captureError(() =>
      start(t, owner, {
        sourceWorkspaceId: mine,
        from: "1-projects/acme",
        destinationWorkspaceId: theirs,
        to: "work/acme",
      }),
    );

    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
  });

  test("a stranger to the destination is told the same thing as about a context that does not exist", async () => {
    const t = setupTest();
    const { owner, mine, theirs } = await twoContexts(t);
    // A real id for a workspace that is no longer there, so the comparison is
    // between two refusals rather than between a refusal and a crash.
    const ghost = await createUser(t, "ghost@example.invalid");
    const nowhere = await createWorkspace(t, ghost, "cee-context");
    await t.run(async (ctx) => {
      await ctx.db.delete(nowhere);
    });

    const stranger = await captureError(() =>
      start(t, owner, {
        sourceWorkspaceId: mine,
        from: "a.md",
        destinationWorkspaceId: theirs,
        to: "b.md",
      }),
    );
    const absent = await captureError(() =>
      start(t, owner, {
        sourceWorkspaceId: mine,
        from: "a.md",
        destinationWorkspaceId: nowhere,
        to: "b.md",
      }),
    );

    // Byte-for-byte, in the style of `isolation.test.ts`: a different refusal
    // for a context they are not in would confirm that it exists.
    expect(errorCode(stranger)).toBe("WORKSPACE_NOT_FOUND");
    expect(errorCode(absent)).toBe("WORKSPACE_NOT_FOUND");
  });

  test("a move within one context is refused, because links can follow there", async () => {
    const t = setupTest();
    const { owner, mine } = await twoContexts(t);

    const error = await captureError(() =>
      start(t, owner, {
        sourceWorkspaceId: mine,
        from: "1-projects/acme.md",
        destinationWorkspaceId: mine,
        to: "2-areas/acme.md",
      }),
    );

    // Not a capability gap: `files.moveEntry` does this *and* rewrites every
    // reference, which no cross-context move can. Silently routing it here
    // would break links for the one case where following them is possible.
    expect(errorCode(error)).toBe("SAME_CONTEXT");
  });

  test("an empty path is refused before anything is scheduled", async () => {
    const t = setupTest();
    const { owner, mine, theirs } = await twoContexts(t);
    await addMember(t, theirs, owner, "editor");

    const error = await captureError(() =>
      start(t, owner, {
        sourceWorkspaceId: mine,
        from: "/",
        destinationWorkspaceId: theirs,
        to: "work/acme",
      }),
    );

    expect(errorCode(error)).toBe("PATH_INVALID");
  });
});

describe("a move that cannot reach a bucket", () => {
  test("ends on the row saying so, rather than reading as still moving", async () => {
    const t = setupTest();
    const { owner, mine, theirs } = await twoContexts(t);
    await addMember(t, theirs, owner, "editor");

    const { moveId } = await start(t, owner, {
      sourceWorkspaceId: mine,
      from: "1-projects/acme",
      destinationWorkspaceId: theirs,
      to: "work/acme",
    });
    await drainScheduled(t);

    const row = await t.run((ctx) => ctx.db.get(moveId));
    expect(row?.status).toBe("failed");
    // No bucket is bound in this fixture, so the message is the storage one —
    // what matters is that there is one and the row stopped.
    expect(row?.error).toContain("bucket");
    expect(row?.completedAt).toBeGreaterThan(0);
  });

  test("and is recorded in the source context's audit trail", async () => {
    const t = setupTest();
    const { owner, mine, theirs } = await twoContexts(t);
    await addMember(t, theirs, owner, "editor");

    await start(t, owner, {
      sourceWorkspaceId: mine,
      from: "1-projects/acme",
      destinationWorkspaceId: theirs,
      to: "work/acme",
    });
    await drainScheduled(t);

    const events = await t.run((ctx) =>
      ctx.db
        .query("auditEvents")
        .filter((q) => q.eq(q.field("workspaceId"), mine))
        .collect(),
    );
    const move = events.find((event) => event.action.startsWith("file.moveOut"));
    expect(move?.action).toBe("file.moveOut.failed");
    expect(move?.actorUserId).toBe(owner);
    expect(move?.paths).toEqual(["1-projects/acme", "work/acme"]);
  });
});

/**
 * A LONG MOVE OUTLIVES THE PRESS THAT STARTED IT, SO IT RE-ASKS.
 *
 * `openMove` establishes both roles when somebody presses Move. A folder of
 * nine thousand notes is still crossing minutes later, and in that time an
 * owner can hand the source on or the destination's owner can take the write
 * access back. A job that kept batching on the strength of the original check
 * would be carrying notes out of a context on an authority that has gone.
 */
describe("a move in flight", () => {
  test("stops when the access it started with is taken away", async () => {
    const t = setupTest();
    const { owner, mine, theirs } = await twoContexts(t);
    await addMember(t, theirs, owner, "editor");
    const { moveId } = await start(t, owner, {
      sourceWorkspaceId: mine,
      from: "1-projects/acme",
      destinationWorkspaceId: theirs,
      to: "work/acme",
    });

    // Before any pass runs: the destination's owner demotes them.
    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("workspaceMembers")
        .filter((q) => q.eq(q.field("workspaceId"), theirs))
        .filter((q) => q.eq(q.field("userId"), owner))
        .first();
      await ctx.db.patch(membership!._id, { role: "member" });
    });
    await drainScheduled(t);

    const row = await t.run((ctx) => ctx.db.get(moveId));
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("no longer in place");
    // And it says which way to read that: what crossed, crossed.
    expect(row?.error).toContain("already moved is in the new context");
  });
});

describe("a move of something that is not there", () => {
  test("fails rather than completing over an empty folder", async () => {
    const t = setupTest();
    const { owner, mine, theirs } = await twoContexts(t);
    await addMember(t, theirs, owner, "editor");
    // No bucket is bound in this fixture, so the pass fails at the credential
    // before it can reach the empty-export arm. Asserted at the engine level
    // in `contextMove.test.ts`; what matters here is the shape of the row.
    const { moveId } = await start(t, owner, {
      sourceWorkspaceId: mine,
      from: "1-projects/nothing-here",
      destinationWorkspaceId: theirs,
      to: "work/nothing-here",
    });
    await drainScheduled(t);

    const row = await t.run((ctx) => ctx.db.get(moveId));
    expect(row?.status).toBe("failed");
    expect(row?.movedObjects).toBe(0);
  });
});

describe("picking a stopped move back up", () => {
  test("re-asks both questions rather than trusting the row", async () => {
    const t = setupTest();
    const { owner, them, mine, theirs } = await twoContexts(t);
    await addMember(t, theirs, owner, "editor");
    const { moveId } = await start(t, owner, {
      sourceWorkspaceId: mine,
      from: "1-projects/acme",
      destinationWorkspaceId: theirs,
      to: "work/acme",
    });
    await drainScheduled(t);
    expect(await t.run(async (ctx) => (await ctx.db.get(moveId))?.status)).toBe("failed");

    // The destination's owner takes the write access back.
    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("workspaceMembers")
        .filter((q) => q.eq(q.field("workspaceId"), theirs))
        .filter((q) => q.eq(q.field("userId"), owner))
        .first();
      await ctx.db.patch(membership!._id, { role: "member" });
    });

    const error = await captureError(() =>
      asUser(t, owner).action(api.functions.contextMoves.resumeContextMove, { moveId }),
    );
    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
    expect(them).toBeDefined();
  });

  test("a finished move is not reopened", async () => {
    const t = setupTest();
    const { owner, mine, theirs } = await twoContexts(t);
    await addMember(t, theirs, owner, "editor");
    const { moveId } = await start(t, owner, {
      sourceWorkspaceId: mine,
      from: "1-projects/acme",
      destinationWorkspaceId: theirs,
      to: "work/acme",
    });
    await drainScheduled(t);
    await t.run((ctx) => ctx.db.patch(moveId, { status: "complete" }));

    const { resumed } = await asUser(t, owner).action(
      api.functions.contextMoves.resumeContextMove,
      { moveId },
    );

    expect(resumed).toBe(false);
  });
});

describe("watching a move", () => {
  test("only the source context's owner can", async () => {
    const t = setupTest();
    const { owner, them, mine, theirs } = await twoContexts(t);
    await addMember(t, theirs, owner, "editor");
    await addMember(t, mine, them, "editor");
    await start(t, owner, {
      sourceWorkspaceId: mine,
      from: "1-projects/acme",
      destinationWorkspaceId: theirs,
      to: "work/acme",
    });

    const mineRows = await asUser(t, owner).query(
      api.functions.contextMoves.listContextMoves,
      { workspaceId: mine },
    );
    expect(mineRows.length).toBe(1);
    expect(mineRows[0]!.from).toBe("1-projects/acme");

    const error = await captureError(() =>
      asUser(t, them).query(api.functions.contextMoves.listContextMoves, { workspaceId: mine }),
    );
    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
  });

  test("the destination's owner is not shown somebody else's move", async () => {
    const t = setupTest();
    const { owner, them, mine, theirs } = await twoContexts(t);
    await addMember(t, theirs, owner, "editor");
    await start(t, owner, {
      sourceWorkspaceId: mine,
      from: "1-projects/acme",
      destinationWorkspaceId: theirs,
      to: "work/acme",
    });

    /*
      The row names a path in `mine`, and a folder name is itself private —
      `storage-and-credentials.md` says so about the gateway's own move marker.
      Listing by destination would hand it to somebody who never saw that
      folder.
    */
    const rows = await asUser(t, them).query(
      api.functions.contextMoves.listContextMoves,
      { workspaceId: theirs },
    );
    expect(rows).toEqual([]);
  });
});

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

    test("cannot be answered for good, because its notice is how it gets finished", async () => {
      const t = setupTest();
      const { owner, mine, moveId } = await failed(t);

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
      const { owner, moveId } = await failed(t);
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
