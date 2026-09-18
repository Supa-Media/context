/**
 * A CROSS-CONTEXT MOVE THROUGH THE WHOLE STACK, AGAINST TWO REAL BUCKETS.
 *
 * `contextMove.test.ts` drives the three engine functions directly and
 * `contextMoves.test.ts` proves who may start one. Neither runs the thing that
 * actually ships: the public action, the credential barrier opening **two
 * different workspaces' bindings in turn**, the scheduled pass chain, and the
 * row a person watches. Those are the parts where a mistake looks like nothing
 * at all — a move that never schedules, a pass that opens the wrong bucket, a
 * chain that stops one batch short and leaves half a folder in each context.
 *
 * So this one is end to end: two S3-speaking in-memory buckets behind one
 * `fetch`, two workspaces with real encrypted bindings, and the move run to
 * completion through `startContextMove` and the scheduler.
 *
 * What it is here to catch, in order of how bad it is:
 *
 *  - **Half a folder in each context.** A chain that stops early is the worst
 *    outcome this feature has, and it is invisible to any test that moves
 *    fewer objects than one batch carries. The folder here is deliberately
 *    larger than a single batch.
 *  - **The wrong bucket.** Two bindings, two credentials, one barrier. A
 *    source key written into the source, or the destination read as the
 *    source, would pass every single-bucket test in this suite.
 *  - **A source left behind.** Copy-then-delete means the failure mode is a
 *    duplicate, and a duplicate reads as success from the destination alone.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  FAKE_STORAGE,
  addMember,
  asUser,
  createUser,
  createWorkspace,
  drainScheduled,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";
import { memoryS3, type MemoryS3 } from "./storeStub.helpers";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifestForFolders } from "../functions/lib/scaffold";

const SOURCE_BUCKET = "example-source-bucket";
const DESTINATION_BUCKET = "example-destination-bucket";

/**
 * One `fetch` over two buckets.
 *
 * Each `memoryS3` answers `NoSuchBucket` for a path that is not its own, so
 * "try the other one" is a complete router rather than a guess — and a request
 * that reached neither still comes back as a 404 the adapter understands,
 * instead of as a hung promise that would make a misrouted call look like a
 * slow one.
 */
function twoBuckets(source: MemoryS3, destination: MemoryS3) {
  return async (input: URL | RequestInfo, init: RequestInit = {}): Promise<Response> => {
    const first = await source.fetchImpl(input, init);
    if (first.status !== 404) return first;
    const body = await first.clone().text();
    if (!body.includes("NoSuchBucket")) return first;
    return await destination.fetchImpl(input, init);
  };
}

async function bindBucket(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  boundBy: Id<"users">,
  bucket: string,
): Promise<void> {
  const encryptedSecretAccessKey = await encryptSecret(
    FAKE_STORAGE.secretAccessKey,
    requireKeyset(),
    { workspaceId },
  );
  await t.run((ctx) =>
    ctx.db.insert("storageBindings", {
      workspaceId,
      provider: FAKE_STORAGE.provider,
      endpoint: FAKE_STORAGE.endpoint,
      region: FAKE_STORAGE.region,
      bucket,
      accessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedSecretAccessKey,
      /*
        THE SHAPE A REAL BINDING PROBES AS, NOT THE FLATTERING ONE.

        R2 accepts `If-Match` on DELETE and ignores it, so every real row comes
        back `conditionalDelete: false` with the other two true — measured in
        `apps/mcp`'s "Move a note on storage that will not enforce a
        conditional delete". Writing `true` here would run this whole suite
        down a branch no customer is on and leave `retireMovedSource`'s
        conditional-PUT substitute — the thing that actually protects an edit
        made mid-move — untested end to end.
      */
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: false },
      status: "connected" as const,
      lastVerifiedAt: Date.now(),
      boundBy,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

interface Pair {
  t: TestConvex;
  mover: Id<"users">;
  from: Id<"workspaces">;
  to: Id<"workspaces">;
  source: MemoryS3;
  destination: MemoryS3;
}

/**
 * Two contexts and a bucket each.
 *
 * `into` is the half worth choosing per test, because the two real shapes read
 * differently at the far end and both have to work:
 *
 *  - `"shared"` — somebody else's shared context that the mover is an `editor`
 *    of. Its folders scaffold `team`, which is what makes an editor able to
 *    write into them at all, and which is exactly the case where a private
 *    note has to arrive carrying an exception.
 *  - `"own"` — a second personal context the mover owns. Its folders are
 *    private, and only an owner's `private` scope can see them, so this is the
 *    case a hardcoded `team` at the destination used to refuse with "not
 *    found" about the mover's own folder.
 *
 * @param notes how many notes to put in `1-projects/acme`. The default is more
 * than one batch carries, so the chain has to run more than once.
 */
async function pair(
  options: { notes?: number; into?: "shared" | "own" } = {},
): Promise<Pair> {
  const t = setupTest();
  const mover = await createUser(t, "mover@example.invalid");
  const other = await createUser(t, "other@example.invalid");
  const from = await createWorkspace(t, mover, "ada-context");
  const into = options.into ?? "shared";
  const to =
    into === "own"
      ? await createWorkspace(t, mover, "cee-context")
      : await createWorkspace(t, other, "bee-context", { kind: "shared" });
  if (into === "shared") await addMember(t, to, mover, "editor", other);

  const source = memoryS3(SOURCE_BUCKET);
  source.seed(PRIVACY_KEY, renderPrivacyManifestForFolders(["1-projects"], "personal"));
  source.seed("1-projects/README.md", "# Projects\n");
  const notes = options.notes ?? 55;
  for (let index = 0; index < notes; index += 1) {
    source.seed(`1-projects/acme/note-${String(index).padStart(3, "0")}.md`, `# ${index}\n`);
  }

  const destination = memoryS3(DESTINATION_BUCKET);
  destination.seed(
    PRIVACY_KEY,
    renderPrivacyManifestForFolders(["work"], into === "own" ? "personal" : "shared"),
  );
  destination.seed("work/README.md", "# Work\n");

  vi.stubGlobal("fetch", twoBuckets(source, destination));
  await bindBucket(t, from, mover, SOURCE_BUCKET);
  await bindBucket(t, to, into === "own" ? mover : other, DESTINATION_BUCKET);

  return { t, mover, from, to, source, destination };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function keysUnder(bucket: MemoryS3, prefix: string): string[] {
  return [...bucket.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
}

describe("a folder moved from one context into another", () => {
  test("arrives whole, leaves nothing behind, and takes more than one batch", async () => {
    const p = await pair({ notes: 55 });

    const { moveId } = await asUser(p.t, p.mover).action(
      api.functions.contextMoves.startContextMove,
      {
        sourceWorkspaceId: p.from,
        from: "1-projects/acme",
        destinationWorkspaceId: p.to,
        to: "work/acme",
      },
    );
    await drainScheduled(p.t);

    const row = await p.t.run((ctx) => ctx.db.get(moveId));
    expect([row?.status, row?.error]).toEqual(["complete", undefined]);
    expect(row?.movedObjects).toBe(55);
    expect(row?.skipped).toEqual([]);

    // Every note is in the destination, under the new prefix, with its body.
    expect(keysUnder(p.destination, "work/acme/").length).toBe(55);
    expect(p.destination.objects.get("work/acme/note-000.md")?.body).toBe("# 0\n");
    expect(p.destination.objects.get("work/acme/note-054.md")?.body).toBe("# 54\n");

    // And none is in the source. A copy-then-delete that skipped the delete
    // reads as a complete move from the destination alone.
    expect(keysUnder(p.source, "1-projects/acme/")).toEqual([]);
    // What was outside the folder is untouched, in both buckets.
    expect(p.source.objects.has("1-projects/README.md")).toBe(true);
    expect(p.destination.objects.has("work/README.md")).toBe(true);
  });

  test("a folder bigger than one pass keeps going across scheduled passes", async () => {
    /*
      ONE PASS IS NOT THE UNIT; THE MOVE IS.

      A pass carries `BATCHES_PER_PASS` batches and then hands on to the next by
      scheduling itself. Fifty-five notes fit in one pass, so every other test
      in this file passes with the hand-on deleted — measured, not assumed — and
      the property the whole feature is for ("it should work even for large
      moves") would have had no test at all.

      Two hundred and fifty is over that line. It is the slowest test in this
      file and it is the one worth the seconds: a chain that stops one pass
      short leaves half a folder in each context, which is the worst outcome
      this feature has and the one nobody would notice from the destination.
    */
    const p = await pair({ notes: 250, into: "own" });

    const { moveId } = await asUser(p.t, p.mover).action(
      api.functions.contextMoves.startContextMove,
      {
        sourceWorkspaceId: p.from,
        from: "1-projects/acme",
        destinationWorkspaceId: p.to,
        to: "work/acme",
      },
    );
    await drainScheduled(p.t);

    const row = await p.t.run((ctx) => ctx.db.get(moveId));
    // Not merely "not failed": a move that ran out of passes and stopped
    // rescheduling sits at `moving` forever, which is the state a person cannot
    // tell from a slow one.
    expect([row?.status, row?.error]).toEqual(["complete", undefined]);
    expect(row?.movedObjects).toBe(250);
    expect(keysUnder(p.destination, "work/acme/").length).toBe(250);
    expect(keysUnder(p.source, "1-projects/acme/")).toEqual([]);
  });

  test("the source's manifest forgets the folder and the destination's is untouched", async () => {
    // Into a context the mover owns, where both ends are private: nothing needs
    // narrowing, so the destination's manifest must not be touched at all. A
    // move that churns `privacy.md` on every batch is a move that rewrites the
    // access map of a context it is only passing through.
    const p = await pair({ notes: 3, into: "own" });
    const destinationManifestBefore = p.destination.objects.get(PRIVACY_KEY)!.body;

    const { moveId } = await asUser(p.t, p.mover).action(
      api.functions.contextMoves.startContextMove,
      {
        sourceWorkspaceId: p.from,
        from: "1-projects/acme",
        destinationWorkspaceId: p.to,
        to: "work/acme",
      },
    );
    await drainScheduled(p.t);

    /*
      The outcome first, and it is not ceremony: without it this test passes
      over a move that never happened — an untouched manifest is exactly what a
      refusal leaves behind too. Measured: hardcoding the destination scope back
      to `team` (the defect the re-derivation above fixed) left every assertion
      below green.
    */
    const row = await p.t.run((ctx) => ctx.db.get(moveId));
    expect([row?.status, row?.error]).toEqual(["complete", undefined]);
    expect(keysUnder(p.destination, "work/acme/").length).toBe(3);

    expect(p.destination.objects.get(PRIVACY_KEY)!.body).toBe(destinationManifestBefore);
    expect(p.source.objects.get(PRIVACY_KEY)!.body).not.toContain("1-projects/acme");
  });

  test("it is recorded in the source context's audit trail, with both paths", async () => {
    const p = await pair({ notes: 2 });

    await asUser(p.t, p.mover).action(api.functions.contextMoves.startContextMove, {
      sourceWorkspaceId: p.from,
      from: "1-projects/acme",
      destinationWorkspaceId: p.to,
      to: "work/acme",
    });
    await drainScheduled(p.t);

    const events = await p.t.run((ctx) =>
      ctx.db
        .query("auditEvents")
        .filter((q) => q.eq(q.field("workspaceId"), p.from))
        .collect(),
    );
    const move = events.find((event) => event.action === "file.moveOut");
    expect(move?.actorUserId).toBe(p.mover);
    expect(move?.paths).toEqual(["1-projects/acme", "work/acme"]);
    expect(move?.details?.objects).toBe(2);
  });

  test("an owner's private note stays private in a shared destination", async () => {
    const p = await pair({ notes: 1, into: "shared" });

    await asUser(p.t, p.mover).action(api.functions.contextMoves.startContextMove, {
      sourceWorkspaceId: p.from,
      from: "1-projects/acme",
      destinationWorkspaceId: p.to,
      to: "work/acme",
    });
    await drainScheduled(p.t);

    /*
      `work` defaults to `team` in a shared context, so inheritance alone would
      publish this note to everybody in @bee-context the moment it landed. The
      manifest has to carry an exception for it, and the whole path from the
      source's `private` to that exception runs through two buckets and three
      barrier calls — which is why it is asserted here as well as in the
      engine's own suite.
    */
    const manifest = p.destination.objects.get(PRIVACY_KEY)!.body;
    expect(manifest).toContain("work/acme/note-000.md: private");
  });

  test("a move onto a folder the destination already has is refused, and nothing moves", async () => {
    const p = await pair({ notes: 4 });
    p.destination.seed("work/acme/theirs.md", "# theirs\n");

    const { moveId } = await asUser(p.t, p.mover).action(
      api.functions.contextMoves.startContextMove,
      {
        sourceWorkspaceId: p.from,
        from: "1-projects/acme",
        destinationWorkspaceId: p.to,
        to: "work/acme",
      },
    );
    await drainScheduled(p.t);

    const row = await p.t.run((ctx) => ctx.db.get(moveId));
    expect(row?.status).toBe("failed");
    expect(row?.movedObjects).toBe(0);
    expect(keysUnder(p.source, "1-projects/acme/").length).toBe(4);
    expect(keysUnder(p.destination, "work/acme/")).toEqual(["work/acme/theirs.md"]);
  });

  test("a move of a path that is not there fails rather than reporting success", async () => {
    const p = await pair({ notes: 1 });

    const { moveId } = await asUser(p.t, p.mover).action(
      api.functions.contextMoves.startContextMove,
      {
        sourceWorkspaceId: p.from,
        from: "1-projects/nothing-here",
        destinationWorkspaceId: p.to,
        to: "work/nothing-here",
      },
    );
    await drainScheduled(p.t);

    const row = await p.t.run((ctx) => ctx.db.get(moveId));
    // "Moved 0 notes to @bee-context" over a path that never existed sends
    // somebody looking for a note in a context it was never in.
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("nothing at 1-projects/nothing-here");
  });

  test("a stopped move picks up where it left off rather than starting again", async () => {
    /*
      Into a context the mover owns, so the half-finished state below can be
      staged by hand without also having to unpick the destination's manifest.
      Between two private-default contexts a move writes no exceptions at all,
      which is what makes "put three of them back" a state the product could
      really be in rather than one only a test can build.
    */
    const p = await pair({ notes: 6, into: "own" });
    const { moveId } = await asUser(p.t, p.mover).action(
      api.functions.contextMoves.startContextMove,
      {
        sourceWorkspaceId: p.from,
        from: "1-projects/acme",
        destinationWorkspaceId: p.to,
        to: "work/acme",
      },
    );
    await drainScheduled(p.t);
    expect(await p.t.run(async (ctx) => (await ctx.db.get(moveId))?.status)).toBe("complete");

    // Put three of them back in the source, as a half-finished move leaves
    // them, and mark the row failed the way a dead pass does.
    for (let index = 0; index < 3; index += 1) {
      const key = `work/acme/note-${String(index).padStart(3, "0")}.md`;
      p.source.seed(key.replace("work/acme", "1-projects/acme"), `# ${index}\n`);
      p.destination.objects.delete(key);
    }
    await p.t.run((ctx) =>
      ctx.db.patch(moveId, { status: "failed", movedObjects: 3, error: "stopped" }),
    );

    await asUser(p.t, p.mover).action(api.functions.contextMoves.resumeContextMove, { moveId });
    await drainScheduled(p.t);

    const row = await p.t.run((ctx) => ctx.db.get(moveId));
    expect([row?.status, row?.error]).toEqual(["complete", undefined]);
    // Six in total, not nine: the three that had already crossed are not
    // counted twice, because they are not in the source to be found.
    expect(row?.movedObjects).toBe(6);
    expect(keysUnder(p.source, "1-projects/acme/")).toEqual([]);
    expect(keysUnder(p.destination, "work/acme/").length).toBe(6);
  });
});
