/**
 * Account deletion.
 *
 * The two things that must hold no matter what changes here:
 *  - deleting yourself removes every row that is *yours* — the user row, your
 *    auth material, your memberships, your name claims, and any workspace only
 *    you own, including its storage binding and its slug, so the person can
 *    re-onboard under the same name; and
 *  - deleting yourself removes nothing that is *somebody else's* — a workspace
 *    with another owner survives untouched, and so does everyone else's
 *    membership of it.
 *
 * The cascade assertions below deliberately check the *pre*-state first. An
 * "is empty afterwards" assertion over a table the fixture never populated is
 * vacuously green, and a cascade that silently stopped touching a table would
 * sail through it.
 *
 * A third property, added alongside the Google connection cascade: deleting
 * workspace A must never touch workspace B's rows, in any of the tables this
 * file sweeps, when both live in the *same* database — a separate
 * `setupTest()` per workspace would prove nothing here, since two databases
 * cannot collide by construction. See "tenant isolation" below.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing vitest tests
 * (in this file unless noted).
 *
 *   the `workspaceKeyRotations` sweep removed from the cascade             1
 *   the `CONNECT_ATTEMPT_TABLES` loop deleted from the cascade             1
 *   the Google connection sweep deleted from the cascade                   2
 *   `workspaceId` filter dropped from the connect-attempt sweep            1
 *   `encryptedVerifier` typo'd in `connectAttemptTables`'s predicate       3
 *     (1 here + 2 in `connectAttempts.test.ts` — the derivation returns an
 *     empty set, so both its own self-tests and this file's cascade test
 *     fail together)
 *
 * Re-measured on review, with three more rows and one correction — the
 * Google-connection row is now 5, because this file grew three tests that
 * depend on that sweep and `cascadeCoverage.test.ts` catches it as an
 * unaccounted-for credential table:
 *
 *   the Google connection sweep deleted from the cascade                   5
 *     (4 here + 1 in `cascadeCoverage.test.ts`)
 *   the `searchIndexes` release deleted from the cascade                   2
 *   the Google sweep left unscoped (`query(...).collect()`, no index)      1
 *     — the two-workspace isolation test, specifically
 *   `workspaceDataKeys` deleted by the cascade (the kept half)             1
 *   the failed-revoke log line removed from `revokeGoogleGrant`            1
 *
 * The encryption tables are the one place this file asserts an *asymmetry*
 * rather than an emptiness — the rotation rows go, the key generations stay.
 * Both directions are asserted, because the second is an open product
 * decision (`docs/decisions/encryption.md`, "What a teardown deletes, and
 * what it keeps") and an open decision with no test in front of it is a
 * decision that gets taken by accident.
 */

import type { Id } from "../../_generated/dataModel";
import {
  type TestConvex,
  createUser,
  createWorkspace,
  seedStorageBinding,
  setupTest,
} from "../fixtures.helpers";

export async function onboardedAccount(slug = "atlas") {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, slug);
  await seedStorageBinding(t, { workspaceId, boundBy: owner });
  return { t, owner, workspaceId };
}

/** Auth rows as @convex-dev/auth lays them down for a signed-in account. */
export async function seedAuthRows(t: TestConvex, userId: Id<"users">) {
  const accountId = await t.run((ctx) =>
    ctx.db.insert("authAccounts", {
      userId,
      provider: "email-otp",
      providerAccountId: "owner@example.invalid",
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("authVerificationCodes", {
      accountId,
      provider: "email-otp",
      code: "fake-hashed-code-not-real",
      expirationTime: Date.now() + 86_400_000,
    }),
  );
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 86_400_000,
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("authRefreshTokens", {
      sessionId,
      expirationTime: Date.now() + 86_400_000,
    }),
  );
  return { accountId, sessionId };
}

