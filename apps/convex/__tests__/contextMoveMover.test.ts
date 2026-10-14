/**
 * A move into another context, carried by the gateway's mover
 * (`lib/contextMoveMover.ts`, `apps/mcp/src/moves/contextMovePage.js`): the
 * files go bucket to bucket there, and this deployment only plans, narrows
 * and records. `contextMoveEndToEnd.test.ts` runs the whole move suite both
 * ways; this file holds what only the mover's way has.
 *
 * Sabotage, each confirmed to fail a case here: carry the batch in this
 * deployment while the mover is set (the "never read here" case), let a
 * ticket open a file outside the move (the ticket case), or fail the move when
 * the mover does not answer (the unanswered case).
 */

import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { asUser, drainScheduled, gatewayPost } from "./fixtures.helpers";
import { hashToken } from "../functions/lib/crypto";
import { CONTEXT_MOVE_RETRY_MS } from "../functions/lib/contextMoveMover";
import { keysUnder, pair, type Pair } from "./contextMove.helpers";

const start = async (p: Pair, from = "1-projects/acme", to = "work/acme"): Promise<Id<"contextMoves">> =>
  (await asUser(p.t, p.mover).action(api.functions.contextMoves.startContextMove, {
    sourceWorkspaceId: p.from,
    from,
    destinationWorkspaceId: p.to,
    to,
  })).moveId;

describe("a move into another context on the mover", { timeout: 30_000 }, () => {
  test("carries every file, and no note's text is read or written outside the mover", async () => {
    const p = await pair({ notes: 45, mover: true });
    const moveId = await start(p);
    await drainScheduled(p.t);

    const row = await p.t.run((ctx) => ctx.db.get(moveId));
    expect([row?.status, row?.error, row?.movedObjects]).toEqual(["complete", undefined, 45]);
    expect((await keysUnder(p.destination, "work/acme/")).length).toBe(45);
    expect(p.destination.objects.get("work/acme/note-044.md")?.body).toBe("# 44\n");
    expect(await keysUnder(p.source, "1-projects/acme/")).toEqual([]);

    // Two batches, both carried by the mover.
    expect(p.opened.map((page) => (page as { kind: string }).kind)).toEqual(["contextMove", "contextMove"]);
    // Outside it nothing was written under either folder, and nothing read
    // there answered a note's text: only the markers the mover left behind.
    expect(p.outside.filter((request) => !request.startsWith("GET ") && /^(PUT|POST|DELETE) (1-projects\/acme|work\/acme)\//.test(request))).toEqual([]);
    const readNotes = p.outsideReads.filter((read) => read.key.startsWith("1-projects/acme/") || read.key.startsWith("work/acme/"));
    expect(readNotes.filter((read) => /^# \d+/.test(read.body))).toEqual([]);
  });

  test("a single note moves too", async () => {
    const p = await pair({ notes: 2, mover: true, into: "own" });
    const moveId = await start(p, "1-projects/acme/note-001.md", "work/one.md");
    await drainScheduled(p.t);

    const row = await p.t.run((ctx) => ctx.db.get(moveId));
    expect([row?.status, row?.error, row?.movedObjects]).toEqual(["complete", undefined, 1]);
    expect(p.destination.objects.get("work/one.md")?.body).toBe("# 1\n");
    expect(await keysUnder(p.source, "1-projects/acme/")).toEqual(["1-projects/acme/note-000.md"]);
  });

  test("a note encrypted to its own context stays there, named", async () => {
    const p = await pair({ notes: 2, mover: true, into: "own" });
    p.source.seed("1-projects/acme/secret.md", "---\ncontext_encryption: v1\n---\n\nAAAAAAAAAAAAAAAA\n");
    const moveId = await start(p);
    await drainScheduled(p.t);

    const row = await p.t.run((ctx) => ctx.db.get(moveId));
    expect([row?.status, row?.error, row?.movedObjects]).toEqual(["complete", undefined, 2]);
    expect(row?.skipped).toEqual([{ path: "1-projects/acme/secret.md", reason: "encrypted" }]);
    expect(await keysUnder(p.source, "1-projects/acme/")).toEqual(["1-projects/acme/secret.md"]);
    expect(p.destination.objects.has("work/acme/secret.md")).toBe(false);
  });

  test("a mover that does not answer is tried again, not counted as the move failing", async () => {
    const p = await pair({ notes: 3, mover: true, answer: () => new Response("", { status: 502 }) });
    const moveId = await start(p);
    // One pass, run here rather than by the scheduler, so what it scheduled can be read.
    await p.t.action(internal.functions.contextMoves.advanceContextMove, { moveId, passesLeft: 5 });
    const pending = await p.t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (job) => job.state.kind === "pending" && job.name.includes("advanceContextMove") && job.args[0]?.passesLeft === 4,
      ),
    );

    const row = await p.t.run((ctx) => ctx.db.get(moveId));
    expect([row?.status, row?.movedObjects]).toEqual(["moving", 0]);
    expect(row?.error).toBeUndefined();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.scheduledTime - Date.now()).toBeGreaterThan(CONTEXT_MOVE_RETRY_MS - 5_000);
    expect((await keysUnder(p.source, "1-projects/acme/")).length).toBe(3);
    expect(await keysUnder(p.destination, "work/acme/")).toEqual([]);
  });

  test("a ticket opens once, and only for files under the move it was minted for", async () => {
    const p = await pair({ notes: 2, mover: true });
    const moveId: Id<"contextMoves"> = await p.t.run((ctx) =>
      ctx.db.insert("contextMoves", {
        sourceWorkspaceId: p.from,
        destinationWorkspaceId: p.to,
        actorUserId: p.mover,
        from: "1-projects/acme",
        to: "work/acme",
        status: "moving",
        movedObjects: 0,
        movedBytes: 0,
        skipped: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const mint = async (ticket: string, objects: { source: string; destination: string; size: number }[], workspaceId = p.from) =>
      p.t.mutation(internal.functions.storageMover.mintPage, {
        hashedTicket: await hashToken(ticket),
        workspaceId,
        contextMoveId: moveId,
        objects,
        phase: "carry",
        now: Date.now(),
      });
    const open = async (ticket: string) => (await (await gatewayPost(p.t, "/gateway/mover/open", { ticket })).json()).page;
    const inside = { source: "1-projects/acme/note-000.md", destination: "work/acme/note-000.md", size: 4 };

    await mint("good", [inside]);
    expect(await open("good")).toMatchObject({ kind: "contextMove", objects: [inside] });
    expect(await open("good")).toBeNull();

    await mint("outside-source", [{ ...inside, source: "1-projects/README.md" }]);
    expect(await open("outside-source")).toBeNull();
    await mint("outside-destination", [{ ...inside, destination: "elsewhere/note-000.md" }]);
    expect(await open("outside-destination")).toBeNull();
    await mint("wrong-workspace", [inside], p.to);
    expect(await open("wrong-workspace")).toBeNull();
    await p.t.run((ctx) => ctx.db.patch(moveId, { status: "failed" }));
    await mint("stopped", [inside]);
    expect(await open("stopped")).toBeNull();
  });

  test("a ticket names one job, and a move's names its files", async () => {
    const p = await pair({ notes: 1, mover: true });
    await expect(
      p.t.mutation(internal.functions.storageMover.mintPage, {
        hashedTicket: await hashToken("no-files"),
        workspaceId: p.from,
        contextMoveId: await p.t.run((ctx) =>
          ctx.db.insert("contextMoves", {
            sourceWorkspaceId: p.from,
            destinationWorkspaceId: p.to,
            actorUserId: p.mover,
            from: "1-projects/acme",
            to: "work/acme",
            status: "moving",
            movedObjects: 0,
            movedBytes: 0,
            skipped: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }),
        ),
        phase: "carry",
        now: Date.now(),
      }),
    ).rejects.toThrow();
  });
});
