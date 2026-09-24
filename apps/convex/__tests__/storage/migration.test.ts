import { describe, expect, test } from "vitest";
import { api, internal } from "../../_generated/api";
import { STORAGE_LAYOUT_PROBE_VERSION } from "../../functions/lib/storageLayout";
import {
  addMember,
  asUser,
  bindFakeStorage,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  seedStorageBinding,
} from "../fixtures.helpers";
import {
  boundWorkspace,
} from "./fixtures";

describe("where the storage-layout migration got to", () => {
  /*
    The migration has always written its own state into the bucket, under
    `.context/`, and short-circuits on `complete`. Nothing outside the bucket
    could read it, so the console had no way to tell "this bucket still needs
    the update" from "it ran last week" — and answered the offer with a flag on
    one device, which is why the notice came back on every other one.

    This is the copy that travels with the workspace. Same category as
    `noteCount`: something we observed while holding a credential, which no
    query can recompute without becoming a public function that opens one.
  */
  test("a fresh binding has none, which is what still offers the migration", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    const binding = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    expect(binding?.storageLayoutState).toBeUndefined();
    expect(binding?.storageLayoutAt).toBeUndefined();
    // And nobody has *asked* it, which is the half that decides the offer.
    expect(binding?.storageLayoutCheckedAt).toBeUndefined();
  });

  /*
    THE ABSENCE THAT MEANT TWO THINGS.

    Recording the outcome fixed the offer for every context migrated after the
    column existed, and for nobody else. A context migrated before it kept
    `complete` in its own bucket and nothing in this row — and an empty column
    read as "nobody has run this", so the notice came back on every device, for
    ever, for exactly the people who had already run it.

    So the question and the answer are recorded separately. `checkedAt` says
    the bucket was asked; the state stays what it said.
  */
  test("a bucket that answers 'never run' is a different fact from one nobody asked", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    await t.mutation(internal.functions.storage.recordStorageLayoutState, {
      workspaceId,
    });

    const binding = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    // Nothing has run here, and that is now a recorded answer rather than an
    // unasked question.
    expect(binding?.storageLayoutState).toBeUndefined();
    expect(binding?.storageLayoutCheckedAt).toBeGreaterThan(0);
    // No outcome was observed, so nothing claims one was.
    expect(binding?.storageLayoutAt).toBeUndefined();
  });

  test("recording an outcome also records that the bucket was asked", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    await t.mutation(internal.functions.storage.recordStorageLayoutState, {
      workspaceId,
      state: "complete",
    });

    const binding = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    expect(binding?.storageLayoutState).toBe("complete");
    expect(binding?.storageLayoutCheckedAt).toBeGreaterThan(0);
  });

  test("a state file that has gone stops claiming the bucket is migrated", async () => {
    /*
      The bucket is authoritative and this row is a copy of it. A copy that
      outlives what it copied is the stale-green-check failure the rebind clear
      exists to avoid, so an observation of "no state here" clears a state we
      had rather than keeping the more flattering answer.
    */
    const { t, owner, workspaceId } = await boundWorkspace();
    await t.mutation(internal.functions.storage.recordStorageLayoutState, {
      workspaceId,
      state: "complete",
    });
    await t.mutation(internal.functions.storage.recordStorageLayoutState, {
      workspaceId,
    });

    const binding = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    expect(binding?.storageLayoutState).toBeUndefined();
    expect(binding?.storageLayoutCheckedAt).toBeGreaterThan(0);
  });

  /**
   * The probe budget belongs to the context, not to the deployment.
   *
   * `OBSERVE_LAYOUT_LIMIT` is the ceiling on probes against a bucket that will
   * not answer — low on purpose, because nobody is waiting on the result. Four
   * is also low enough that a shared counter is spent by accident: one context
   * whose bucket is unreachable, with a console mounting on a phone and a
   * laptop, reaches it inside a minute. Keyed globally, every other customer's
   * layout notice then stays up forever, because the question that would clear
   * it can no longer be asked.
   *
   * Nothing here could see that. The guard spends itself after one success, so
   * every existing test calls this once or twice against a single workspace and
   * the limit never engages at all — which is why the whole suite passed with
   * `${args.workspaceId}` removed from the key. Exhausting it is the only way
   * to look at the key at all.
   *
   * ## Two wrong keys, and why it takes two neighbours to rule out both
   *
   * `:all` and `:${userId}` are different mistakes and a second context does
   * not catch both. A budget keyed by the caller is refuted only by the same
   * person's *other* context — two owners would sail through it, because their
   * ids differ anyway. A budget keyed globally is refuted by either. So the
   * owner's second workspace is the instrument, and the neighbour is the claim
   * being made: one customer's unreachable bucket must not be able to silence
   * another customer's layout notice.
   *
   * Sabotage, as failing tests across the whole `apps/convex` suite:
   *
   *   `storage.observeLayout:all`                                    0 -> 1
   *   `storage.observeLayout:${userId}`                              0 -> 1
   *   the `consumeRateLimit` call deleted outright                        1
   */
  test("a second context has its own probe budget, spent by nobody", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    await t.mutation(internal.functions.storage.recordVerification, {
      workspaceId,
      ok: true,
      capabilities: { conditionalWrite: true },
    });

    // The same owner's other context, and a different customer's.
    const mine = await createWorkspace(t, owner, "bravo");
    const neighbour = await createUser(t, "neighbour@example.invalid");
    const theirs = await createWorkspace(t, neighbour, "charlie");
    for (const [id, who] of [
      [mine, owner],
      [theirs, neighbour],
    ] as const) {
      await seedStorageBinding(t, {
        workspaceId: id,
        boundBy: who,
        status: "connected",
        bucket: `${id}-bucket`,
      });
    }

    /*
      The answer is only recorded by the scheduled read, which is never drained
      here — so the binding stays unanswered and every call is a fresh probe.
      That is the production shape this limit is for: a bucket that never
      answers, asked again by a console that mounted again.
    */
    const answers: unknown[] = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        answers.push(
          await asUser(t, owner).mutation(
            api.functions.storage.observeStorageLayout,
            { workspaceId },
          ),
        );
      } catch {
        break;
      }
    }
    // Asserted outside the loop: a failed expectation inside it would be caught
    // by the `catch` and read as the refusal, which is the one thing this is
    // trying to observe.
    expect(answers.length).toBeGreaterThan(0);
    expect(answers.length).toBeLessThan(20);
    expect(answers.every((answer) => JSON.stringify(answer) === '{"queued":true}')).toBe(
      true,
    );
    expect(
      errorCode(
        await captureError(() =>
          asUser(t, owner).mutation(api.functions.storage.observeStorageLayout, {
            workspaceId,
          }),
        ),
      ),
    ).toBe("RATE_LIMITED");

    // Neither of the other two buckets has been asked anything, so both are.
    // The first rules out a budget keyed by the caller; the second is the
    // cross-tenant claim.
    expect(
      await asUser(t, owner).mutation(api.functions.storage.observeStorageLayout, {
        workspaceId: mine,
      }),
    ).toEqual({ queued: true });
    expect(
      await asUser(t, neighbour).mutation(
        api.functions.storage.observeStorageLayout,
        { workspaceId: theirs },
      ),
    ).toEqual({ queued: true });
  });

  test("asking is owner-only, and spends itself once the bucket has answered", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    // Only a bucket we believe works is worth a question: an unverified or
    // errored binding is one the console is already shouting about, and a
    // probe against it fails for that reason rather than teaching anybody
    // anything.
    await t.mutation(internal.functions.storage.recordVerification, {
      workspaceId,
      ok: true,
      capabilities: { conditionalWrite: true },
    });
    const member = await createUser(t, "asker@example.invalid");
    await addMember(t, workspaceId, member, "member");

    await expect(
      asUser(t, member).mutation(api.functions.storage.observeStorageLayout, {
        workspaceId,
      }),
    ).rejects.toThrow();

    // An unanswered binding is worth asking about exactly once...
    expect(
      await asUser(t, owner).mutation(
        api.functions.storage.observeStorageLayout,
        { workspaceId },
      ),
    ).toEqual({ queued: true });

    // ...and once it has answered — by an observation or by a migration pass —
    // the question is spent, so a console that mounts again asks nothing.
    await t.mutation(internal.functions.storage.recordStorageLayoutState, {
      workspaceId,
    });
    expect(
      await asUser(t, owner).mutation(
        api.functions.storage.observeStorageLayout,
        { workspaceId },
      ),
    ).toEqual({ queued: false });
  });

  test("a recorded outcome is readable, and stamped", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    await t.mutation(internal.functions.storage.recordStorageLayoutState, {
      workspaceId,
      state: "complete",
    });

    const binding = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    expect(binding?.storageLayoutState).toBe("complete");
    expect(binding?.storageLayoutAt).toBeGreaterThan(0);
  });

  test("a later pass overwrites an earlier one", async () => {
    // The chain records on every pass — `copying` while it walks, then the
    // terminal state — so the last write is the current answer rather than the
    // first one to land.
    const { t, owner, workspaceId } = await boundWorkspace();
    for (const state of ["copying", "copied", "complete"] as const) {
      await t.mutation(internal.functions.storage.recordStorageLayoutState, {
        workspaceId,
        state,
      });
    }
    expect(
      (
        await asUser(t, owner).query(api.functions.storage.getStorageBinding, {
          workspaceId,
        })
      )?.storageLayoutState,
    ).toBe("complete");
  });

  test("it is not clamped to the owner, unlike the note count", async () => {
    /*
      Deliberate, and the reason is the difference between the two: the count
      is a number about private notes, and this names no key and counts nothing
      of the customer's. Every member already sees the provider, the bucket and
      the verification status, and this says less than any of them.
    */
    const { t, owner, workspaceId } = await boundWorkspace();
    const member = await createUser(t, "member@example.invalid");
    await addMember(t, workspaceId, member, "member");
    await t.mutation(internal.functions.storage.recordStorageLayoutState, {
      workspaceId,
      state: "complete",
    });
    await t.mutation(internal.functions.storage.recordNoteCount, {
      workspaceId,
      notes: 42,
      truncated: false,
    });

    const seen = await asUser(t, member).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    expect(seen?.storageLayoutState).toBe("complete");
    // The clamp beside it still holds, so this is not a test that stopped
    // checking anything.
    expect(seen?.noteCount).toBeUndefined();
  });

  test("rebinding clears it, so a different bucket is offered the migration", async () => {
    /*
      The failure this exists for is silent. A `complete` carried onto a bucket
      that has never been migrated is a bucket the console never offers it to:
      the pre-v1 plumbing stays where it is, dual reads keep carrying it, and
      no screen ever says so. Same argument as `lastVerifiedAt` and the note
      count above, and a worse outcome than either.
    */
    const { t, owner, workspaceId } = await boundWorkspace();
    await t.mutation(internal.functions.storage.recordStorageLayoutState, {
      workspaceId,
      state: "complete",
    });

    await bindFakeStorage(t, owner, workspaceId, { bucket: "somewhere-else" });

    const rebound = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    expect(rebound?.bucket).toBe("somewhere-else");
    expect(rebound?.storageLayoutState).toBeUndefined();
    expect(rebound?.storageLayoutAt).toBeUndefined();
    /*
      Including the record that it was ever asked. Left behind, a new bucket
      reads as "checked, and never migrated" — an answer nobody obtained about
      a bucket nobody looked at — and the console never offers it the update.
    */
    expect(rebound?.storageLayoutCheckedAt).toBeUndefined();
    expect(rebound?.storageLayoutCheckedVersion).toBeUndefined();
  });

  /*
    THE ANSWER THAT WAS ONLY AS GOOD AS THE QUESTION.

    The first probe asked one thing: is there a migration state file? A bucket
    **we scaffolded ourselves** has none — it was born on the v1 layout and has
    never in its life held a `.audit/` or a `.history/` — so it answered
    "nobody has run the migration here", which is true and beside the point:
    there has never been anything to migrate. Every newly created workspace was
    therefore offered a one-time storage update on its first console load, and
    dismissing it was the only thing that ended it.

    `readStorageLayoutState` now asks whether any pre-v1 plumbing is in the
    bucket at all and answers `complete` when none is. That fixes every bucket
    asked from now on and none of the rows the old question already wrote —
    which are exactly the new workspaces the bug was about, because a binding
    that has been asked is never asked again. So the generation is recorded
    with the answer, and a stale one is asked once more.
  */
  test("an answer from an older probe is asked again; the current one is not", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    await t.mutation(internal.functions.storage.recordVerification, {
      workspaceId,
      ok: true,
      capabilities: { conditionalWrite: true },
    });
    await t.mutation(internal.functions.storage.recordStorageLayoutState, {
      workspaceId,
    });

    // The answer the current probe gave is spent, exactly as before.
    expect(
      await asUser(t, owner).mutation(
        api.functions.storage.observeStorageLayout,
        { workspaceId },
      ),
    ).toEqual({ queued: false });

    // A row written by the probe that got new workspaces wrong: asked, with
    // nothing recorded, and no generation beside it.
    await t.run(async (ctx) => {
      const binding = await ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(binding!._id, {
        storageLayoutCheckedVersion: undefined,
      });
    });

    expect(
      await asUser(t, owner).mutation(
        api.functions.storage.observeStorageLayout,
        { workspaceId },
      ),
    ).toEqual({ queued: true });
  });

  test("a recorded state is the bucket's own word, and is never re-asked", async () => {
    /*
      Only the *absence* of a state can be wrong about a bucket: every
      generation of the probe reads a state file the same way, and a migration
      pass writes what it actually did. Re-asking there would spend somebody's
      request budget to be told what we already know — and, on a bucket
      mid-migration, would do it on every console mount.
    */
    const { t, owner, workspaceId } = await boundWorkspace();
    await t.mutation(internal.functions.storage.recordVerification, {
      workspaceId,
      ok: true,
      capabilities: { conditionalWrite: true },
    });
    await t.mutation(internal.functions.storage.recordStorageLayoutState, {
      workspaceId,
      state: "copying",
    });
    await t.run(async (ctx) => {
      const binding = await ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(binding!._id, {
        storageLayoutCheckedVersion: undefined,
      });
    });

    expect(
      await asUser(t, owner).mutation(
        api.functions.storage.observeStorageLayout,
        { workspaceId },
      ),
    ).toEqual({ queued: false });
  });

  test("recording an answer stamps the generation that produced it", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    await t.mutation(internal.functions.storage.recordStorageLayoutState, {
      workspaceId,
    });
    const binding = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    // The console reads this to tell an answer it can trust from one the probe
    // before it got wrong, so it has to survive the query boundary.
    expect(binding?.storageLayoutCheckedVersion).toBe(
      STORAGE_LAYOUT_PROBE_VERSION,
    );
  });

  test("a binding that went away drops the write rather than resurrecting a row", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    await t.run(async (ctx) => {
      const binding = await ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.delete(binding!._id);
    });

    await t.mutation(internal.functions.storage.recordStorageLayoutState, {
      workspaceId,
      state: "complete",
    });

    expect(
      await asUser(t, owner).query(api.functions.storage.getStorageBinding, {
        workspaceId,
      }),
    ).toBeNull();
  });
});
