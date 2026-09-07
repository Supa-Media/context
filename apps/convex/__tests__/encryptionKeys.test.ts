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

import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { createUser, createWorkspace, setupTest } from "./fixtures.helpers";

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
    expect(first!.generation).toBe("k1");

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
    expect(row!.encryptedDataKey).not.toContain(opened!.dataKey);
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

    expect(alphaKey!.dataKey).not.toBe(betaKey!.dataKey);

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
