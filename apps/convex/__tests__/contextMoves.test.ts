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
