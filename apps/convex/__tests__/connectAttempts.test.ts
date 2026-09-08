/**
 * `connectAttemptTables` — the derivation `deleteWorkspaceCascade` uses to
 * find every parked-connect-attempt table without a hand-maintained list.
 *
 * Per `docs/decisions/testing.md`, "A guard nobody has checked is not a
 * guard": the point of deriving this set from the schema is that a fifth
 * provider's attempts table is caught automatically, and the only way to
 * believe that is to feed the derivation a table it was never told about and
 * watch it get caught — the same self-test `structure.test.ts` runs for
 * `encryptedColumnsIn`.
 */
import { defineTable } from "convex/server";
import { v } from "convex/values";
import { describe, expect, test } from "vitest";
import { connectAttemptTables, CONNECT_ATTEMPT_TABLES } from "../functions/lib/connectAttempts";
import schema from "../schema";

describe("connectAttemptTables", () => {
  test("on the real schema, finds exactly the connect-attempt tables that exist today", () => {
    // Spelled out and asserted exactly, on purpose — the same discipline
    // `INVITATION_STATUSES` in `functions/account.ts` uses. A sixth table
    // matching the shape is a welcome, automatic addition to the sweep; this
    // assertion is what makes that addition visible as a diff to review
    // rather than a change nobody notices.
    expect(connectAttemptTables()).toEqual(["dropboxConnectAttempts", "googleConnectAttempts"]);
    // The exported constant is the same computation, not a second one that
    // could drift from it.
    expect(CONNECT_ATTEMPT_TABLES).toEqual(["dropboxConnectAttempts", "googleConnectAttempts"]);
  });

  test("catches a table it was never told about — the derivation's own self-test", () => {
    // A table this codebase does not have. A hand-maintained list could not
    // know about it; the derivation must.
    const withThirdProvider = {
      ...schema.tables,
      slackConnectAttempts: defineTable({
        hashedState: v.string(),
        encryptedVerifier: v.string(),
        workspaceId: v.id("workspaces"),
        expiresAt: v.number(),
      }),
    };
    expect(connectAttemptTables(withThirdProvider)).toEqual([
      "dropboxConnectAttempts",
      "googleConnectAttempts",
      "slackConnectAttempts",
    ]);
  });

  test("a workspace-scoped table with no encrypted verifier is not a connect attempt", () => {
    // Shaped like `storageBindings` and a dozen other ordinary workspace
    // rows: `workspaceId` alone is not enough to be swept as a live
    // half-credential, or the derivation would just be "every workspace
    // table" and the sweep it drives would delete far too much.
    const tables = {
      ordinaryWorkspaceRow: defineTable({
        workspaceId: v.id("workspaces"),
        encryptedSecretAccessKey: v.string(),
      }),
    };
    expect(connectAttemptTables(tables)).toEqual([]);
  });

  test("an encrypted verifier with no workspace is not a connect attempt", () => {
    // The other half of the pair matters too: something that carries an
    // encrypted verifier but names no workspace has nothing for a workspace
    // teardown to key off, so it must not match either.
    const tables = {
      globalVerifier: defineTable({
        encryptedVerifier: v.string(),
      }),
    };
    expect(connectAttemptTables(tables)).toEqual([]);
  });

  test("an empty schema finds nothing", () => {
    expect(connectAttemptTables({})).toEqual([]);
  });
});
