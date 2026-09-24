import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  ROTATED_ENVELOPE_COLUMNS,
  ROTATION_EXEMPT_ENVELOPE_COLUMNS,
} from "../../functions/storage";
import { decryptSecret, encryptSecret, requireKeyset } from "../../functions/lib/crypto";
import {
  FAKE_D1,
  FAKE_STORAGE,
  bindFakeStorage,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  seedAppSecret,
  setupTest,
  type TestConvex,
} from "../fixtures.helpers";
import {
  asS3,
  boundWorkspace,
} from "./fixtures.helpers";

describe("rotating the encryption key", () => {
  const SECOND_KEY = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=";

  /** Swap the process env for one test, then put it back. */
  async function withEnv(
    overrides: Record<string, string | undefined>,
    body: () => Promise<void>,
  ) {
    const before: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(overrides)) {
      before[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      await body();
    } finally {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  async function dataKeyEnvelopeOf(
    t: TestConvex,
    workspaceId: Id<"workspaces">,
  ): Promise<string> {
    const row = await t.run((ctx) =>
      ctx.db
        .query("workspaceDataKeys")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
    );
    return row!.encryptedDataKey;
  }

  async function envelopeOf(
    t: TestConvex,
    workspaceId: Id<"workspaces">,
  ): Promise<string> {
    const binding = await t.run((ctx) =>
      ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
    );
    return binding!.encryptedSecretAccessKey!;
  }

  test("a binding written before a rotation keeps working, and can be moved to the new key", async () => {
    const { t, workspaceId } = await boundWorkspace();
    const originalKey = process.env.STORAGE_SECRET_ENCRYPTION_KEY!;
    expect((await envelopeOf(t, workspaceId)).startsWith("v2:k1:")).toBe(true);

    await withEnv(
      {
        STORAGE_SECRET_ENCRYPTION_KEY: SECOND_KEY,
        STORAGE_SECRET_ENCRYPTION_KEY_ID: "k2",
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS: originalKey,
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID: "k1",
      },
      async () => {
        // Mid-rotation: the old envelope still opens.
        const credential = await t.action(
          internal.functions.storage.getBindingForGateway,
          { workspaceId },
        );
        expect(asS3(credential).secretAccessKey).toBe(FAKE_STORAGE.secretAccessKey);

        const result = await t.action(
          internal.functions.storage.rekeyStorageBindings,
          {},
        );
        expect(result).toMatchObject({ rekeyed: 1, skipped: 0, unreadable: 0 });
        expect((await envelopeOf(t, workspaceId)).startsWith("v2:k2:")).toBe(
          true,
        );

        // Idempotent: a second pass has nothing left to do.
        expect(
          await t.action(internal.functions.storage.rekeyStorageBindings, {}),
        ).toMatchObject({ rekeyed: 0 });
      },
    );

    // Rotation finished: the old key is gone from the environment entirely and
    // the binding still works. This is the step that was impossible before.
    await withEnv(
      {
        STORAGE_SECRET_ENCRYPTION_KEY: SECOND_KEY,
        STORAGE_SECRET_ENCRYPTION_KEY_ID: "k2",
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS: undefined,
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID: undefined,
      },
      async () => {
        const credential = await t.action(
          internal.functions.storage.getBindingForGateway,
          { workspaceId },
        );
        expect(asS3(credential).secretAccessKey).toBe(FAKE_STORAGE.secretAccessKey);
      },
    );
  });

  test("the re-encryption keeps the workspace binding, so a rekeyed envelope is still not portable", async () => {
    const t = setupTest();
    const alice = await createUser(t, "alice@example.invalid");
    const bob = await createUser(t, "bob@example.invalid");
    const aliceWs = await createWorkspace(t, alice, "alice-context");
    const bobWs = await createWorkspace(t, bob, "bob-context");
    await bindFakeStorage(t, alice, aliceWs);
    await bindFakeStorage(t, bob, bobWs);
    const originalKey = process.env.STORAGE_SECRET_ENCRYPTION_KEY!;

    await withEnv(
      {
        STORAGE_SECRET_ENCRYPTION_KEY: SECOND_KEY,
        STORAGE_SECRET_ENCRYPTION_KEY_ID: "k2",
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS: originalKey,
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID: "k1",
      },
      async () => {
        expect(
          await t.action(internal.functions.storage.rekeyStorageBindings, {}),
        ).toMatchObject({ rekeyed: 2 });

        const alicesEnvelope = await envelopeOf(t, aliceWs);
        await t.run(async (ctx) => {
          const bobs = await ctx.db
            .query("storageBindings")
            .withIndex("by_workspace", (q) => q.eq("workspaceId", bobWs))
            .unique();
          await ctx.db.patch(bobs!._id, {
            encryptedSecretAccessKey: alicesEnvelope,
          });
        });

        expect(
          errorCode(
            await captureError(() =>
              t.action(internal.functions.storage.getBindingForGateway, {
                workspaceId: bobWs,
              }),
            ),
          ),
        ).toBe("CREDENTIAL_UNAVAILABLE");
      },
    );
  });

  test("a row nothing configured can open is counted and left alone, never destroyed", async () => {
    const { t, workspaceId } = await boundWorkspace();
    await t.run(async (ctx) => {
      const binding = await ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(binding!._id, {
        encryptedSecretAccessKey: "v1:aXZpdml2aXZpdml2aQ==:Y2lwaGVydGV4dA==",
      });
    });

    const result = await t.action(
      internal.functions.storage.rekeyStorageBindings,
      {},
    );
    expect(result).toMatchObject({ rekeyed: 0, unreadable: 1 });
    // Still there. A migration that deletes what it cannot read is a migration
    // that loses the customer's binding.
    expect(await envelopeOf(t, workspaceId)).toContain("v1:");
  });

  /**
   * THE ENVELOPE THAT IS NOT ON A BINDING.
   *
   * `workspaceDataKeys.encryptedDataKey` is sealed by the same scheme and
   * carries the same key id, and it is the one envelope in this control plane
   * whose loss cannot be repaired: it opens the encrypted notes in somebody's
   * bucket, and re-entering a credential does not bring it back.
   *
   * A pass that walked only `storageBindings` would report "nothing left" with
   * these rows still under the outgoing key, and step 4 of the operator
   * sequence — unset the PREVIOUS variables — would then destroy every
   * encrypted note in every context. So the assertion that matters is the last
   * one: the key still opens **after the old envelope key is gone from the
   * environment entirely**, which is the state a finished rotation leaves.
   */
  test("a workspace data key is moved forward too, and still opens once the old key is gone", async () => {
    const { t, workspaceId } = await boundWorkspace();
    const originalKey = process.env.STORAGE_SECRET_ENCRYPTION_KEY!;

    const before = await t.action(
      internal.functions.encryptionKeys.openWorkspaceDataKey,
      { workspaceId, create: true },
    );
    const sealedBefore = await dataKeyEnvelopeOf(t, workspaceId);
    expect(sealedBefore.startsWith("v2:k1:")).toBe(true);

    await withEnv(
      {
        STORAGE_SECRET_ENCRYPTION_KEY: SECOND_KEY,
        STORAGE_SECRET_ENCRYPTION_KEY_ID: "k2",
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS: originalKey,
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID: "k1",
      },
      async () => {
        const result = await t.action(
          internal.functions.storage.rekeyStorageBindings,
          {},
        );
        expect(result).toMatchObject({
          rekeyed: 1,
          dataKeysRekeyed: 1,
          dataKeysSkipped: 0,
          dataKeysUnreadable: 0,
        });
        // The envelope moved; the material inside it did not. A rotation that
        // wrote a *new* key here would look identical from the outside and
        // would have made every note already encrypted unreadable.
        const sealedAfter = await dataKeyEnvelopeOf(t, workspaceId);
        expect(sealedAfter.startsWith("v2:k2:")).toBe(true);
        expect(sealedAfter).not.toBe(sealedBefore);

        // Idempotent, like the binding half.
        expect(
          await t.action(internal.functions.storage.rekeyStorageBindings, {}),
        ).toMatchObject({ rekeyed: 0, dataKeysRekeyed: 0 });
      },
    );

    await withEnv(
      {
        STORAGE_SECRET_ENCRYPTION_KEY: SECOND_KEY,
        STORAGE_SECRET_ENCRYPTION_KEY_ID: "k2",
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS: undefined,
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID: undefined,
      },
      async () => {
        const after = await t.action(
          internal.functions.encryptionKeys.openWorkspaceDataKey,
          { workspaceId },
        );
        expect(after).toEqual(before);
      },
    );
  });

  /**
   * THE RETIRED GENERATION, WHICH IS THE ONE A PASS COULD MOST EASILY MISS.
   *
   * After a workspace-key rotation this table holds more than one row per
   * workspace, and the extra rows are the ones nothing is currently writing
   * with. A pass that moved only the *current* generation forward would report
   * "nothing left" with the retired rows still sealed under the outgoing
   * envelope key — and step 4 of the operator sequence, unsetting the PREVIOUS
   * variables, would then make every note still wrapped under that generation
   * permanently unreadable. Those notes are exactly the ones the grace period
   * in `docs/decisions/encryption.md` exists to protect: a restore from bucket
   * versioning, a client that synced the bucket directly, a walk that has not
   * reached them yet.
   *
   * `listDataKeyRekeyCandidates` walks the table rather than a workspace's
   * current row, so this passes — and it is asked here because nothing else
   * asks it, and because "one row per workspace" was true of this table until
   * rotation shipped.
   */
  test("a RETIRED generation is moved forward too, and still opens once the old key is gone", async () => {
    const { t, workspaceId } = await boundWorkspace();
    const originalKey = process.env.STORAGE_SECRET_ENCRYPTION_KEY!;

    await t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, {
      workspaceId,
      create: true,
    });
    await t.action(internal.functions.encryptionKeys.startWorkspaceKeyRotation, {
      workspaceId,
    });
    const before = await t.action(
      internal.functions.encryptionKeys.openWorkspaceDataKey,
      { workspaceId },
    );
    expect(Object.keys(before!.keys).sort()).toEqual(["k1", "k2"]);

    const sealed = async () =>
      (
        await t.run((ctx) =>
          ctx.db
            .query("workspaceDataKeys")
            .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
            .collect(),
        )
      )
        .map((row) => row.encryptedDataKey)
        .sort();
    expect((await sealed()).every((envelope) => envelope.startsWith("v2:k1:"))).toBe(true);

    await withEnv(
      {
        STORAGE_SECRET_ENCRYPTION_KEY: SECOND_KEY,
        STORAGE_SECRET_ENCRYPTION_KEY_ID: "k2",
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS: originalKey,
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID: "k1",
      },
      async () => {
        // BOTH rows, not one: the retired generation is a candidate too.
        expect(
          await t.action(internal.functions.storage.rekeyStorageBindings, {}),
        ).toMatchObject({ dataKeysRekeyed: 2, dataKeysUnreadable: 0 });
        expect((await sealed()).every((envelope) => envelope.startsWith("v2:k2:"))).toBe(true);
      },
    );

    await withEnv(
      {
        STORAGE_SECRET_ENCRYPTION_KEY: SECOND_KEY,
        STORAGE_SECRET_ENCRYPTION_KEY_ID: "k2",
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS: undefined,
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID: undefined,
      },
      async () => {
        // Same material on both generations, with the old envelope key gone
        // from the environment entirely — which is the state a finished
        // rotation leaves, and the state a note on k1 has to survive.
        expect(
          await t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, {
            workspaceId,
          }),
        ).toEqual(before);
      },
    );
  });

  test("a data key the pass cannot open is counted, never rewritten", async () => {
    const { t, workspaceId } = await boundWorkspace();
    const originalKey = process.env.STORAGE_SECRET_ENCRYPTION_KEY!;
    await t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, {
      workspaceId,
      create: true,
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("workspaceDataKeys")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(row!._id, {
        encryptedDataKey: "v1:aXZpdml2aXZpdml2aQ==:Y2lwaGVydGV4dA==",
      });
    });

    await withEnv(
      {
        STORAGE_SECRET_ENCRYPTION_KEY: SECOND_KEY,
        STORAGE_SECRET_ENCRYPTION_KEY_ID: "k2",
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS: originalKey,
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID: "k1",
      },
      async () => {
        expect(
          await t.action(internal.functions.storage.rekeyStorageBindings, {}),
        ).toMatchObject({ dataKeysRekeyed: 0, dataKeysUnreadable: 1 });
        // Left exactly as it was. Generating a replacement here would be data
        // loss wearing the costume of a repair.
        expect(await dataKeyEnvelopeOf(t, workspaceId)).toContain("v1:");
      },
    );
  });

  /**
   * THE EXACT MISS `encryptedDataKey` WAS, ARRIVING A SECOND TIME.
   *
   * `googleConnections` is its own table, so `listRekeyCandidates` above
   * never sees a Google refresh or access token no matter how completely
   * `ENVELOPE_FIELDS` is enumerated — that list is queried against
   * `storageBindings` rows only. Column-name accounting
   * (`ROTATED_ENVELOPE_COLUMNS`, checked by the guard below) cannot catch a
   * table the walk itself never visits; only this test, actually running
   * `rekeyStorageBindings` against a `googleConnections` row, can. The token
   * stays top-level on the generalized row (never nested under `gmail`),
   * which is what keeps this test — and the rotation code it proves — from
   * needing to change shape if Calendar or Chat land on the same row.
   */
  test("a connected Google account's tokens are moved forward too", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    const originalKey = process.env.STORAGE_SECRET_ENCRYPTION_KEY!;
    const context = { workspaceId: workspaceId as string };
    const now = Date.now();
    const refreshBefore = await encryptSecret("google-refresh-abc", requireKeyset(), context);
    const accessBefore = await encryptSecret("google-access-xyz", requireKeyset(), context);
    expect(refreshBefore.startsWith("v2:k1:")).toBe(true);

    const connectionId = await t.run((ctx) =>
      ctx.db.insert("googleConnections", {
        workspaceId,
        provider: "google" as const,
        address: "person@example.invalid",
        encryptedRefreshToken: refreshBefore,
        encryptedAccessToken: accessBefore,
        accessTokenExpiresAt: now + 3_600_000,
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        googleAccountId: "google-account-1",
        products: ["gmail"] as const,
        gmail: {
          scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
          mailboxSlug: "person-at-example-invalid",
          backfillDays: 90,
          folders: ["inbox", "sent"] as const,
          storeRawMime: false,
          attachmentMode: "store" as const,
          attachmentRetentionDays: 90,
          quotaBytes: 5 * 1024 * 1024 * 1024,
        },
        health: "active" as const,
        boundBy: owner,
        createdAt: now,
        updatedAt: now,
      }),
    );

    await withEnv(
      {
        STORAGE_SECRET_ENCRYPTION_KEY: SECOND_KEY,
        STORAGE_SECRET_ENCRYPTION_KEY_ID: "k2",
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS: originalKey,
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID: "k1",
      },
      async () => {
        const result = await t.action(internal.functions.storage.rekeyStorageBindings, {});
        expect(result).toMatchObject({
          googleConnectionsRekeyed: 2, // refresh AND access token
          googleConnectionsSkipped: 0,
          googleConnectionsUnreadable: 0,
        });

        const row = await t.run((ctx) => ctx.db.get(connectionId));
        expect(row!.encryptedRefreshToken.startsWith("v2:k2:")).toBe(true);
        expect(row!.encryptedAccessToken!.startsWith("v2:k2:")).toBe(true);
        expect(row!.encryptedRefreshToken).not.toBe(refreshBefore);

        // Idempotent, like every other half of this pass.
        expect(
          await t.action(internal.functions.storage.rekeyStorageBindings, {}),
        ).toMatchObject({ googleConnectionsRekeyed: 0 });
      },
    );

    // Still opens once the old key is gone from the environment entirely —
    // the state a finished rotation leaves, and the property that matters.
    await withEnv(
      {
        STORAGE_SECRET_ENCRYPTION_KEY: SECOND_KEY,
        STORAGE_SECRET_ENCRYPTION_KEY_ID: "k2",
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS: undefined,
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID: undefined,
      },
      async () => {
        const row = await t.run((ctx) => ctx.db.get(connectionId));
        expect(await decryptSecret(row!.encryptedRefreshToken, requireKeyset(), context)).toBe(
          "google-refresh-abc",
        );
      },
    );
  });

  /**
   * THE SAME MISS, ASKED OF A ROW WITH NO `gmail` OBJECT ON IT AT ALL.
   *
   * The test above proves the walk visits `googleConnections`, but it seeds a
   * Gmail row — so it would still pass if the walk (or a future "only rows we
   * actually sync" optimisation of it) filtered on `products`, on the presence
   * of `gmail`, or on a mailbox slug. A Chat-only connection is the row shape
   * that has none of those, and it holds exactly the same refresh token: the
   * token is top-level on the shared row precisely so rotation never has to
   * know which products are enabled, and this is the test that says so.
   *
   * Sabotage: add `.filter((q) => q.neq(q.field("gmail"), undefined))` to
   * `listGoogleConnectionRekeyCandidates` — the Gmail test above stays green
   * and this one fails, with the chat row's token stranded on the old key.
   */
  test("a Chat-only connection's token is moved forward too", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    const originalKey = process.env.STORAGE_SECRET_ENCRYPTION_KEY!;
    const context = { workspaceId: workspaceId as string };
    const now = Date.now();
    const refreshBefore = await encryptSecret("google-chat-refresh-abc", requireKeyset(), context);
    expect(refreshBefore.startsWith("v2:k1:")).toBe(true);

    const connectionId = await t.run((ctx) =>
      ctx.db.insert("googleConnections", {
        workspaceId,
        provider: "google" as const,
        address: "person@example.invalid",
        encryptedRefreshToken: refreshBefore,
        accessTokenExpiresAt: now + 3_600_000,
        scopes: [
          "https://www.googleapis.com/auth/chat.messages.readonly",
          "https://www.googleapis.com/auth/chat.spaces.readonly",
        ],
        googleAccountId: "google-account-1",
        products: ["chat"] as const,
        chat: {
          scopes: [
            "https://www.googleapis.com/auth/chat.messages.readonly",
            "https://www.googleapis.com/auth/chat.spaces.readonly",
          ],
          nonceSeed: "not-a-credential-just-a-seed",
        },
        health: "active" as const,
        boundBy: owner,
        createdAt: now,
        updatedAt: now,
      }),
    );

    await withEnv(
      {
        STORAGE_SECRET_ENCRYPTION_KEY: SECOND_KEY,
        STORAGE_SECRET_ENCRYPTION_KEY_ID: "k2",
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS: originalKey,
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID: "k1",
      },
      async () => {
        expect(await t.action(internal.functions.storage.rekeyStorageBindings, {})).toMatchObject({
          googleConnectionsRekeyed: 1, // refresh only — a chat row caches no access token yet
          googleConnectionsSkipped: 0,
          googleConnectionsUnreadable: 0,
        });
        expect((await t.run((ctx) => ctx.db.get(connectionId)))!.encryptedRefreshToken.startsWith("v2:k2:")).toBe(
          true,
        );
      },
    );

    // And it still opens once the old key is gone from the environment
    // entirely — the state a finished rotation leaves, which is the whole
    // point of the walk having visited this row.
    await withEnv(
      {
        STORAGE_SECRET_ENCRYPTION_KEY: SECOND_KEY,
        STORAGE_SECRET_ENCRYPTION_KEY_ID: "k2",
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS: undefined,
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID: undefined,
      },
      async () => {
        const row = await t.run((ctx) => ctx.db.get(connectionId));
        expect(await decryptSecret(row!.encryptedRefreshToken, requireKeyset(), context)).toBe(
          "google-chat-refresh-abc",
        );
        // The chat product's own state rode along untouched — rotation moves
        // the envelope and nothing else.
        expect(row!.chat?.nonceSeed).toBe("not-a-credential-just-a-seed");
      },
    );
  });

  /**
   * AND THE THIRD ROW SHAPE, THE ONE A **CALENDAR** CONNECT ACTUALLY WRITES.
   *
   * Added by the adversarial review of the Calendar PR, for the reason the
   * Chat test above gives and one more: this row is written by
   * `applyCalendarConnectionBinding` itself rather than inserted by hand, so
   * it also proves the mutation this product ships puts the token pair where
   * the walk looks — top-level on the shared row — rather than somewhere a
   * clean-looking rotation pass would report success without visiting.
   *
   * Sabotage, measured: adding `if (row.products.includes("calendar")) continue;`
   * to `listGoogleConnectionRekeyCandidates` — the shape of any "skip the
   * rows this pass does not own" refactor — fails exactly this test, on the
   * rekeyed count, and leaves every other test in this file green, both the
   * Gmail and Chat rotation proofs above included.
   */
  test("a Calendar-only connection's token rotates too — the token is the account's, not the product's", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    const originalKey = process.env.STORAGE_SECRET_ENCRYPTION_KEY!;
    const context = { workspaceId: workspaceId as string };

    await t.mutation(internal.functions.calendarConnect.applyCalendarConnectionBinding, {
      workspaceId,
      boundBy: owner,
      address: "person@example.invalid",
      googleAccountId: "google-account-cal",
      scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"],
      encryptedRefreshToken: await encryptSecret("calendar-refresh-abc", requireKeyset(), context),
      encryptedAccessToken: await encryptSecret("calendar-access-xyz", requireKeyset(), context),
      accessTokenExpiresAt: Date.now() + 3_600_000,
    });

    const before = await t.run((ctx) => ctx.db.query("googleConnections").unique());
    expect(before!.gmail).toBeUndefined();
    expect(before!.chat).toBeUndefined();
    expect(before!.products).toEqual(["calendar"]);
    expect(before!.encryptedRefreshToken.startsWith("v2:k1:")).toBe(true);

    await withEnv(
      {
        STORAGE_SECRET_ENCRYPTION_KEY: SECOND_KEY,
        STORAGE_SECRET_ENCRYPTION_KEY_ID: "k2",
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS: originalKey,
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID: "k1",
      },
      async () => {
        expect(await t.action(internal.functions.storage.rekeyStorageBindings, {})).toMatchObject({
          googleConnectionsRekeyed: 2, // refresh AND the cached access token
          googleConnectionsSkipped: 0,
          googleConnectionsUnreadable: 0,
        });
        const row = await t.run((ctx) => ctx.db.query("googleConnections").unique());
        expect(row!.encryptedRefreshToken.startsWith("v2:k2:")).toBe(true);
        expect(row!.encryptedAccessToken!.startsWith("v2:k2:")).toBe(true);
      },
    );

    // The old key gone from the environment entirely — the state a finished
    // rotation leaves — and the calendar connection still opens.
    await withEnv(
      {
        STORAGE_SECRET_ENCRYPTION_KEY: SECOND_KEY,
        STORAGE_SECRET_ENCRYPTION_KEY_ID: "k2",
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS: undefined,
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID: undefined,
      },
      async () => {
        const row = await t.run((ctx) => ctx.db.query("googleConnections").unique());
        expect(await decryptSecret(row!.encryptedRefreshToken, requireKeyset(), context)).toBe(
          "calendar-refresh-abc",
        );
        expect(await decryptSecret(row!.encryptedAccessToken!, requireKeyset(), context)).toBe(
          "calendar-access-xyz",
        );
        // The calendar product's own cursor state rode along untouched.
        expect(row!.calendar?.scopes).toEqual(["https://www.googleapis.com/auth/calendar.events.readonly"]);
      },
    );
  });

  /**
   * A disconnected connection's refresh token is the empty string
   * (`disconnectGoogleConnection` clears it, never deletes the row), and
   * empty is never a rekey candidate — there is nothing there to re-seal, and
   * `envelopeKeyId("")` would only ever be `unreadable` noise on every future
   * pass for a credential that is intentionally gone.
   */
  test("a disconnected connection's empty token is not a rekey candidate", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    const originalKey = process.env.STORAGE_SECRET_ENCRYPTION_KEY!;
    const now = Date.now();
    await t.run((ctx) =>
      ctx.db.insert("googleConnections", {
        workspaceId,
        provider: "google" as const,
        address: "gone@example.invalid",
        encryptedRefreshToken: "",
        scopes: [],
        googleAccountId: "google-account-2",
        products: ["gmail"] as const,
        gmail: {
          scopes: [],
          mailboxSlug: "gone-at-example-invalid",
          backfillDays: 90,
          folders: ["inbox", "sent"] as const,
          storeRawMime: false,
          attachmentMode: "store" as const,
          attachmentRetentionDays: 90,
          quotaBytes: 5 * 1024 * 1024 * 1024,
        },
        health: "error" as const,
        disconnectedAt: now,
        boundBy: owner,
        createdAt: now,
        updatedAt: now,
      }),
    );

    await withEnv(
      {
        STORAGE_SECRET_ENCRYPTION_KEY: SECOND_KEY,
        STORAGE_SECRET_ENCRYPTION_KEY_ID: "k2",
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS: originalKey,
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID: "k1",
      },
      async () => {
        expect(
          await t.action(internal.functions.storage.rekeyStorageBindings, {}),
        ).toMatchObject({ googleConnectionsRekeyed: 0, googleConnectionsUnreadable: 0 });
      },
    );
  });

  /**
   * THE PLATFORM'S OWN CREDENTIALS, found by the guard below and fixed here.
   *
   * `appSecrets` is bound to the `integration` scope rather than to a
   * workspace, so it was in neither the pass nor anybody's list. Losing these
   * is an outage rather than data loss — an operator re-enters them — but a
   * rotation that cannot be finished without breaking search provisioning and
   * mail is a rotation nobody performs, which is the state this pass exists to
   * end.
   */
  test("a platform secret is moved forward too, and its fingerprint does not move with it", async () => {
    const { t } = await boundWorkspace();
    const originalKey = process.env.STORAGE_SECRET_ENCRYPTION_KEY!;
    await seedAppSecret(t, "SEARCH_D1_API_TOKEN", FAKE_D1.apiToken);
    const fingerprintBefore = await t.run(async (ctx) => {
      const row = await ctx.db.query("appSecrets").unique();
      return row!.fingerprint;
    });

    await withEnv(
      {
        STORAGE_SECRET_ENCRYPTION_KEY: SECOND_KEY,
        STORAGE_SECRET_ENCRYPTION_KEY_ID: "k2",
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS: originalKey,
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID: "k1",
      },
      async () => {
        expect(
          await t.action(internal.functions.storage.rekeyStorageBindings, {}),
        ).toMatchObject({
          platformSecretsRekeyed: 1,
          platformSecretsSkipped: 0,
          platformSecretsUnreadable: 0,
        });
      },
    );

    await withEnv(
      {
        STORAGE_SECRET_ENCRYPTION_KEY: SECOND_KEY,
        STORAGE_SECRET_ENCRYPTION_KEY_ID: "k2",
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS: undefined,
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID: undefined,
      },
      async () => {
        const row = await t.run(async (ctx) => await ctx.db.query("appSecrets").unique());
        expect(row!.encryptedValue.startsWith("v2:k2:")).toBe(true);
        // Derived from the plaintext, which a rotation does not touch. A
        // fingerprint that moved would tell an operator their credential had
        // been replaced.
        expect(row!.fingerprint).toBe(fingerprintBefore);
        expect(
          await t.action(internal.functions.admin.readIntegrationSecret, {
            name: "SEARCH_D1_API_TOKEN",
          }),
        ).toBe(FAKE_D1.apiToken);
      },
    );
  });

  /**
   * The guard that would have caught the miss above.
   *
   * `dropboxBinding.test.ts` already couples `ENVELOPE_FIELDS` to the schema —
   * but it reads only the `storageBindings` slice of it, so an encrypted column
   * in a **new table** was invisible to it. That is the same blindness its own
   * rationale warns about one level down, and `encryptedDataKey` walked
   * straight through it.
   */
  test("every encrypted column in the whole schema is one rotation moves", () => {
    // `schema.ts` plus the table modules it spreads in from `functions/lib/schema/`.
    const tableModules = readdirSync(new URL("../../functions/lib/schema/", import.meta.url))
      .sort()
      .map((name) => `../../functions/lib/schema/${name}`);
    const schema = ["../../schema.ts", ...tableModules]
      .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
      .join("\n");
    const declared = [
      ...new Set(
        [...schema.matchAll(/^\s+(encrypted[A-Za-z0-9]*)\s*:\s*v\./gm)].map(
          (match) => match[1]!,
        ),
      ),
    ];
    expect(declared.length).toBeGreaterThan(3);
    // Two lists, and every encrypted column must be in exactly one of them. A
    // column in neither is not "probably fine": it is an envelope whose fate on
    // the operator's step 4 nobody has decided, which is how `encryptedDataKey`
    // — the one envelope in this control plane that cannot be re-entered —
    // came to be missing from the pass.
    const accounted = [
      ...(ROTATED_ENVELOPE_COLUMNS as readonly string[]),
      ...(ROTATION_EXEMPT_ENVELOPE_COLUMNS as readonly string[]),
    ];
    for (const column of declared) {
      expect(
        accounted,
        `schema column "${column}" is encrypted at rest but is in neither ROTATED_ENVELOPE_COLUMNS nor ROTATION_EXEMPT_ENVELOPE_COLUMNS, so nobody has decided what retiring the previous key does to it`,
      ).toContain(column);
    }
    // And the exemptions are exemptions, not a second copy of the pass.
    for (const column of ROTATION_EXEMPT_ENVELOPE_COLUMNS as readonly string[]) {
      expect(ROTATED_ENVELOPE_COLUMNS as readonly string[]).not.toContain(column);
    }
  });
});

