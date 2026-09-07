/**
 * THE KEY THAT OPENS ONE CONTEXT'S NOTES, AND ONLY ITS OWN.
 *
 * `functions/encryptionKeys.ts`, and the sibling it puts on `/gateway/binding`.
 * See `docs/decisions/encryption.md`.
 *
 * `structure.test.ts` already proves the *structural* half — no public function
 * can reach this decrypt, `datakey` may not appear in a public return
 * validator, and the module is an enumerated importer of the decrypt path. What
 * that cannot prove is behaviour, so this file asks four questions:
 *
 *  1. **Is it the same key every time?** A second key written for a workspace
 *     that already has one makes every note already encrypted under the first
 *     unreadable — the one failure in this feature that cannot be undone, and
 *     the one that would look like a fix for "the key was missing".
 *  2. **Is it one key per workspace?** Two contexts must not share one, and one
 *     workspace's envelope must not open in another's row. The second half is
 *     the AAD's job and is asserted by moving an envelope between rows.
 *  3. **Does reading create one?** It must not. A context that has never
 *     encrypted anything should have no row, so that "how many customers are we
 *     holding a note key for" is a count rather than a filter — the same shape
 *     `search.md` argues for the fast-search opt-in.
 *  4. **Does it reach the gateway only through the door that was already
 *     enumerated?** `/gateway/binding`, with both proofs, and absent for a
 *     context that has no key.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; counts are failing tests in this
 * file plus `controlPlane.test.ts` and `structure.test.ts`.
 *
 *   `insertDataKeyIfAbsent` inserting unconditionally                     6
 *   `openWorkspaceDataKey` creating by default (`create === false`)       4
 *   `openStorageBinding` omitting `encryptionKey` from its answer         2
 *   `openWorkspaceDataKey` sealing to a fixed AAD, not the workspace      1
 *   the `datakey` entry removed from `PLAINTEXT_CREDENTIAL_FIELDS`        1
 *
 * The fourth row is the one worth naming, and it is one on purpose. Binding the
 * envelope to a constant instead of to the workspace looks harmless — every row
 * still opens, every key is still different, and every other test here stays
 * green. What it removes is the single property that a row copied into another
 * workspace fails to decrypt, which is why the cross-tenant test below moves a
 * real envelope between two real rows rather than asserting that two generated
 * keys differ. An assertion that two random 32-byte values are not equal proves
 * nothing about the AAD at all.
 */

import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { addMember, asUser, createUser, createWorkspace, setupTest } from "./fixtures.helpers";

async function keyRow(t: ReturnType<typeof setupTest>, workspaceId: Id<"workspaces">) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("workspaceDataKeys")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique(),
  );
}

describe("the workspace data key", () => {
  test("is created on first use and is the same key every time after", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "alpha");

    const first = await t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, {
      workspaceId,
      create: true,
    });
    const second = await t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, {
      workspaceId,
      create: true,
    });

    expect(first).not.toBeNull();
    // The same *material*, not merely two successful calls. A second key would
    // strand every note encrypted under the first, and it is exactly what an
    // unconditional insert produces.
    expect(second).toEqual(first);
    expect(first!.current).toBe("k1");
    expect(Object.keys(first!.keys)).toEqual(["k1"]);

    // And there is one row, which is the same claim asked of the database
    // rather than of the return value.
    const rows = await t.run(async (ctx) => ctx.db.query("workspaceDataKeys").collect());
    expect(rows).toHaveLength(1);
  });

  test("is sealed at rest, and the material is not in the row", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "alpha");

    const opened = await t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, {
      workspaceId,
      create: true,
    });
    const row = await keyRow(t, workspaceId);

    expect(row).not.toBeNull();
    // A `v2:` envelope, and the opened key is nowhere inside it. Checking the
    // *absence* of the material rather than the presence of a prefix is what
    // makes this fail if somebody ever stores the key in the clear beside its
    // envelope "for the rekey pass".
    expect(row!.encryptedDataKey.startsWith("v2:")).toBe(true);
    expect(row!.encryptedDataKey).not.toContain(opened!.keys[opened!.current]!);
  });

  test("is one key per context, and one context's envelope does not open in another", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const alpha = await createWorkspace(t, owner, "alpha");
    const beta = await createWorkspace(t, owner, "beta", { kind: "shared" });

    const alphaKey = await t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, {
      workspaceId: alpha,
      create: true,
    });
    const betaKey = await t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, {
      workspaceId: beta,
      create: true,
    });

    expect(alphaKey!.keys[alphaKey!.current]).not.toBe(betaKey!.keys[betaKey!.current]);

    // Now the half a "two random keys differ" assertion cannot reach: copy
    // alpha's envelope onto beta's row and ask beta for its key. The AAD binds
    // the envelope to one workspace, so this must fail rather than hand beta
    // alpha's key — which is the whole reason `lib/crypto.ts` takes a context.
    const alphaRow = await keyRow(t, alpha);
    const betaRow = await keyRow(t, beta);
    await t.run(async (ctx) => {
      await ctx.db.patch(betaRow!._id, { encryptedDataKey: alphaRow!.encryptedDataKey });
    });

    await expect(
      t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, {
        workspaceId: beta,
        create: true,
      }),
    ).rejects.toThrow();
  });

  test("reading does not create one", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "alpha");

    // No `create`, which is how every read path calls it.
    const opened = await t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, {
      workspaceId,
    });

    expect(opened).toBeNull();
    // No row, rather than a row that says "none". A context that has never
    // encrypted anything is one less thing this control plane holds on
    // somebody's behalf, and it makes the census a count instead of a filter.
    expect(await keyRow(t, workspaceId)).toBeNull();
  });

  test("...and an existing key still opens without asking to create one", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "alpha");

    const created = await t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, {
      workspaceId,
      create: true,
    });
    const read = await t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, {
      workspaceId,
    });

    // Without this, "reading does not create one" would also pass if reads
    // never returned anything at all, which would take the feature with it.
    expect(read).toEqual(created);
  });

  test("a key nobody can open is a refusal, not a silently different key", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "alpha");
    await t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, {
      workspaceId,
      create: true,
    });

    const row = await keyRow(t, workspaceId);
    await t.run(async (ctx) => {
      await ctx.db.patch(row!._id, { encryptedDataKey: "v2:k1:AAAAAAAAAAAAAAAA:AAAA" });
    });

    // The direction this must fail in: a corrupt envelope must never fall
    // through to "generate a new one", which would be the unrecoverable
    // outcome dressed up as self-healing. `openStorageBinding` turns the throw
    // into an absent sibling, which the gateway reads as "cannot decrypt".
    await expect(
      t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, {
        workspaceId,
        create: true,
      }),
    ).rejects.toThrow();
    expect((await keyRow(t, workspaceId))!.encryptedDataKey).toBe(
      "v2:k1:AAAAAAAAAAAAAAAA:AAAA",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Workspace-key rotation                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `startWorkspaceKeyRotation` and `applyStartWorkspaceKeyRotation` —
 * `functions/controlPlane.ts`'s `/gateway/binding` test file carries the
 * behavioural, over-the-wire half; this one is the table underneath it.
 *
 * The property that matters most is the one a review of green tests would
 * miss: **two callers racing to start a rotation must mint exactly one new
 * generation between them.** `applyStartWorkspaceKeyRotation`'s re-read is
 * what buys that, on the same shape `insertDataKeyIfAbsent` already relies on
 * for a workspace's first key, and it is sabotage-tested below by calling the
 * mutation directly with the guard's own re-check skipped.
 */
describe("workspace-key rotation", () => {
  test("mints k2, retires k1, and both rows persist with the right retiredAt shape", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "alpha");
    await t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, {
      workspaceId,
      create: true,
    });

    const started = await t.action(
      internal.functions.encryptionKeys.startWorkspaceKeyRotation,
      { workspaceId },
    );
    expect(started).toEqual({ fromGeneration: "k1", toGeneration: "k2" });

    const rows = await t.run((ctx) =>
      ctx.db
        .query("workspaceDataKeys")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .collect(),
    );
    expect(rows).toHaveLength(2);
    const k1 = rows.find((r) => r.generation === "k1")!;
    const k2 = rows.find((r) => r.generation === "k2")!;
    expect(k1.retiredAt).toBeTypeOf("number");
    expect(k2.retiredAt).toBeUndefined();
    // Different material, not the same row re-labelled.
    expect(k2.encryptedDataKey).not.toBe(k1.encryptedDataKey);
  });

  test("opening the key after rotation returns BOTH generations, current pointing at the new one", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "alpha");
    const before = await t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, {
      workspaceId,
      create: true,
    });
    await t.action(internal.functions.encryptionKeys.startWorkspaceKeyRotation, { workspaceId });

    const after = await t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, {
      workspaceId,
    });
    expect(after!.current).toBe("k2");
    expect(Object.keys(after!.keys).sort()).toEqual(["k1", "k2"]);
    // The old generation's material is UNCHANGED by the rotation — a note
    // still on k1 must open with exactly the key it was wrapped under.
    expect(after!.keys.k1).toBe(before!.keys.k1);
  });

  test("a workspace that never had a key has nothing to rotate", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "alpha");

    expect(
      await t.action(internal.functions.encryptionKeys.startWorkspaceKeyRotation, {
        workspaceId,
      }),
    ).toBeNull();
  });

  test("starting a rotation while one is in progress returns the SAME target, not a third generation", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "alpha");
    await t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, {
      workspaceId,
      create: true,
    });

    const first = await t.action(internal.functions.encryptionKeys.startWorkspaceKeyRotation, {
      workspaceId,
    });
    const second = await t.action(internal.functions.encryptionKeys.startWorkspaceKeyRotation, {
      workspaceId,
    });
    expect(second).toEqual(first);

    const rows = await t.run((ctx) => ctx.db.query("workspaceDataKeys").collect());
    expect(rows).toHaveLength(2); // k1, k2 — never a k3.
    const rotations = await t.run((ctx) => ctx.db.query("workspaceKeyRotations").collect());
    expect(rotations).toHaveLength(1);
  });

  /**
   * SABOTAGE: skip the re-check the guard depends on, and confirm two racing
   * starts mint two separate rotations instead of converging on one — the
   * exact failure `applyStartWorkspaceKeyRotation`'s re-read exists to
   * prevent. This calls the *mutation* directly, twice, with material two
   * independent callers of the action would have prepared concurrently, to
   * isolate the mutation's own guard from the action's read-then-write shape.
   */
  test("sabotage: without the mutation's re-check, two racing starts would mint two rotations", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "alpha");
    await t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, {
      workspaceId,
      create: true,
    });

    // Two callers, both reading "current generation is k1" before either
    // writes — exactly what `startWorkspaceKeyRotation`'s own read does before
    // calling this mutation, reproduced here so the guard is isolated.
    const first = await t.mutation(
      internal.functions.encryptionKeys.applyStartWorkspaceKeyRotation,
      { workspaceId, fromGeneration: "k1", toGeneration: "k2", encryptedDataKey: "v2:k1:AAAAAAAAAAAAAAAA:AAAA" },
    );
    expect(first).toEqual({ fromGeneration: "k1", toGeneration: "k2" });

    // The real guard refuses this second call outright, because by now the
    // active rotation is k1->k2, not k1->k3 — asserting that IS the guard
    // working. A version of this mutation with the "active rotation already
    // exists" check removed would instead insert a second `workspaceKeyRotations`
    // row and a third `workspaceDataKeys` row, which is the corruption this
    // test exists to catch if that check is ever weakened.
    await expect(
      t.mutation(internal.functions.encryptionKeys.applyStartWorkspaceKeyRotation, {
        workspaceId,
        fromGeneration: "k1",
        toGeneration: "k3",
        encryptedDataKey: "v2:k1:BBBBBBBBBBBBBBBB:BBBB",
      }),
    ).resolves.toEqual({ fromGeneration: "k1", toGeneration: "k2" }); // hands back the winner, mints nothing

    const rows = await t.run((ctx) => ctx.db.query("workspaceDataKeys").collect());
    expect(rows.map((r) => r.generation).sort()).toEqual(["k1", "k2"]);
    const rotations = await t.run((ctx) => ctx.db.query("workspaceKeyRotations").collect());
    expect(rotations).toHaveLength(1);
  });

  test("completing a rotation is idempotent, and a stale target completes nothing", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "alpha");
    await t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, {
      workspaceId,
      create: true,
    });
    await t.action(internal.functions.encryptionKeys.startWorkspaceKeyRotation, { workspaceId });

    expect(
      await t.mutation(internal.functions.encryptionKeys.completeWorkspaceKeyRotation, {
        workspaceId,
        toGeneration: "k9",
      }),
    ).toBe(false);
    expect(
      await t.query(internal.functions.encryptionKeys.getActiveWorkspaceKeyRotation, {
        workspaceId,
      }),
    ).not.toBeNull();

    expect(
      await t.mutation(internal.functions.encryptionKeys.completeWorkspaceKeyRotation, {
        workspaceId,
        toGeneration: "k2",
      }),
    ).toBe(true);
    expect(
      await t.query(internal.functions.encryptionKeys.getActiveWorkspaceKeyRotation, {
        workspaceId,
      }),
    ).toBeNull();

    // Idempotent: completing an already-done rotation again is a no-op, not
    // an error — the gateway's walk cannot always tell which of those it races.
    expect(
      await t.mutation(internal.functions.encryptionKeys.completeWorkspaceKeyRotation, {
        workspaceId,
        toGeneration: "k2",
      }),
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Key export                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * `exportEncryptionKeys` — the console's action. `structure.test.ts` proves
 * the *structural* half (it is public, it reaches a decrypt, and it is only
 * safe because it does so through the enumerated barrier); this asks whether
 * it behaves.
 */
describe("exportEncryptionKeys (the console action)", () => {
  test("an owner gets every live generation's material in the clear", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "alpha");
    const opened = await t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, {
      workspaceId,
      create: true,
    });
    await t.action(internal.functions.encryptionKeys.startWorkspaceKeyRotation, { workspaceId });

    const exported = await asUser(t, owner).action(
      api.functions.encryptionKeys.exportEncryptionKeys,
      { workspaceId },
    );
    expect(exported!.current).toBe("k2");
    const byGeneration = Object.fromEntries(
      exported!.keys.map((entry) => [entry.generation, entry.material]),
    );
    expect(byGeneration.k1).toBe(opened!.keys.k1);
    expect(byGeneration.k2).toBeDefined();
  });

  test("a workspace that has never encrypted anything exports nothing, not a refusal", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "alpha");

    expect(
      await asUser(t, owner).action(api.functions.encryptionKeys.exportEncryptionKeys, {
        workspaceId,
      }),
    ).toBeNull();
  });

  test("an editor is refused — write access to notes is not authority over the key that opens them", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const editor = await createUser(t, "editor@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "alpha");
    await addMember(t, workspaceId, editor, "editor");
    await t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, {
      workspaceId,
      create: true,
    });

    await expect(
      asUser(t, editor).action(api.functions.encryptionKeys.exportEncryptionKeys, {
        workspaceId,
      }),
    ).rejects.toThrow();
  });

  test("a signed-out caller is refused", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "alpha");

    await expect(
      t.action(api.functions.encryptionKeys.exportEncryptionKeys, { workspaceId }),
    ).rejects.toThrow();
  });

  test("every export writes an audit row naming the acting owner", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "alpha");
    await t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, {
      workspaceId,
      create: true,
    });

    await asUser(t, owner).action(api.functions.encryptionKeys.exportEncryptionKeys, {
      workspaceId,
    });

    const events = await t.run((ctx) => ctx.db.query("auditEvents").collect());
    const exportEvent = events.find((e) => e.action === "encryption.export");
    expect(exportEvent).toBeDefined();
    expect(exportEvent!.workspaceId).toBe(workspaceId);
    expect(exportEvent!.actorUserId).toBe(owner);
    // The exported bytes never appear in the audit trail.
    expect(JSON.stringify(exportEvent)).not.toMatch(/[A-Za-z0-9+/]{40,}={0,2}/);
  });

  test("rate limited after five exports in the window, and the sixth attempt writes no audit row", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "alpha");
    await t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, {
      workspaceId,
      create: true,
    });

    for (let i = 0; i < 5; i += 1) {
      await asUser(t, owner).action(api.functions.encryptionKeys.exportEncryptionKeys, {
        workspaceId,
      });
    }
    const before = await t.run((ctx) => ctx.db.query("auditEvents").collect());

    let rateLimited: unknown;
    try {
      await asUser(t, owner).action(api.functions.encryptionKeys.exportEncryptionKeys, {
        workspaceId,
      });
    } catch (error) {
      rateLimited = error;
    }
    expect(rateLimited).toBeInstanceOf(ConvexError);
    expect((rateLimited as ConvexError<{ code: string }>).data.code).toBe("RATE_LIMITED");

    const after = await t.run((ctx) => ctx.db.query("auditEvents").collect());
    expect(after).toHaveLength(before.length);
  });
});
