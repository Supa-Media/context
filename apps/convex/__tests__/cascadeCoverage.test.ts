/**
 * Every workspace-scoped table that holds sealed credential material is
 * either swept by `deleteWorkspaceCascade` or named here as a deliberate
 * exception, with the reason.
 *
 * ## Why this exists beside `connectAttempts.test.ts`
 *
 * `connectAttemptTables` derives one *shape* — `workspaceId` plus
 * `encryptedVerifier` — and sweeps it automatically. That closes the gap it
 * was written for and no more: the miss it was written *because of* was
 * `googleConnections`, which has `workspaceId` and `encryptedRefreshToken`
 * and therefore matches no part of that predicate. It was found by reading,
 * and it is swept by a hand-written block. A second provider's *connections*
 * table would be missed exactly the same way, and so would a connect attempt
 * that spelled its verifier `encryptedCodeVerifier`.
 *
 * So this guard asks the wider question the cascade actually has to answer —
 * **which workspace-scoped tables hold something sealed, and is each one
 * accounted for?** — and makes the answer a diff. A new table carrying an
 * `encrypted…` field and a `workspaceId` fails this test on the day it is
 * declared, and passes it only by being swept or by being written down below
 * with a reason somebody chose.
 *
 * Per `docs/decisions/testing.md`, "A guard nobody has checked is not a
 * guard", the derivation is fed tables this codebase does not have and
 * required to catch them — including the two shapes that slip past
 * `connectAttemptTables`.
 *
 * ## What still escapes, and is therefore not claimed
 *
 * This reads field *names* off the schema's validators, so a future table
 * escapes it by not looking like the ones here:
 *
 *  - a credential scoped by `userId` rather than `workspaceId` (nothing the
 *    workspace cascade could key on anyway — `deleteAccount`'s user-scoped
 *    sweeps are where that belongs);
 *  - a sealed value in a field whose name does not begin with `encrypted`
 *    (`sealedVerifier`, `wrappedKey`); and
 *  - one nested inside an object field rather than declared at the top level.
 *
 * The first is a different sweep's job. The other two are conventions this
 * codebase keeps everywhere — `structure.test.ts`'s `encryptedColumnsIn`
 * depends on the same one — and breaking either is the thing a reviewer has
 * to notice, because no test here will.
 */
/*
 * ## Sabotage record
 *
 * Run as temporary local edits against a committed tree and reverted.
 *
 *   the obligation derivation matching nothing                          2
 *   the cascade deleting the plan row without cancelling first          2
 *   the cascade not sweeping the plan table at all                      3
 *
 * The second is the one this guard exists for: it is an *ordering* failure, and
 * a sweep that deleted the row before scheduling the cancellation would look
 * completely correct in a diff.
 */
import { defineTable } from "convex/server";
import { v } from "convex/values";
import { describe, expect, test } from "vitest";
import { CONNECT_ATTEMPT_TABLES } from "../functions/lib/connectAttempts";
import schema from "../schema";

const CASCADE_SOURCE = (() => {
  const sources = import.meta.glob("../functions/account.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;
  const source = Object.values(sources)[0];
  if (typeof source !== "string") {
    throw new Error("cascadeCoverage.test.ts could not read functions/account.ts");
  }
  // The cascade only — a mention in the file's header prose must not count as
  // a sweep. The header is exactly where an unswept table gets *described*.
  const start = source.indexOf("async function deleteWorkspaceCascade");
  const end = source.indexOf("async function voidCapabilitiesAddressedTo");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("cascadeCoverage.test.ts could not locate deleteWorkspaceCascade");
  }
  return source.slice(start, end);
})();

/**
 * Tables the cascade deliberately does not delete, and why. Each entry is a
 * decision somebody took; adding one is how this guard is meant to be
 * satisfied when deletion is the wrong answer.
 */
const DELIBERATE_EXCEPTIONS: Record<string, string> = {
  // Holds the material that opens the customer's own notes in their own
  // bucket. Deleting it on a metadata teardown destroys the notes of anybody
  // who never exported their keys — an open product decision, not an
  // oversight. `docs/decisions/encryption.md`, "What a teardown deletes, and
  // what it keeps", and the comment at the sweep site in `account.ts`.
  workspaceDataKeys: "kept deliberately: deleting it would destroy unexported notes",
};

/** Field names a table declares, across object and union validators. */
function fieldNamesOf(validator: unknown): string[] {
  if (typeof validator !== "object" || validator === null) return [];
  const shape = validator as { kind?: string; fields?: unknown; members?: unknown };
  if (shape.kind === "object" && typeof shape.fields === "object" && shape.fields !== null) {
    return Object.keys(shape.fields as Record<string, unknown>);
  }
  // A table may be declared as a union of object variants; a credential in
  // any variant is a credential in that table.
  if (shape.kind === "union" && Array.isArray(shape.members)) {
    return shape.members.flatMap((member) => fieldNamesOf(member));
  }
  return [];
}

/**
 * Workspace-scoped tables declaring at least one sealed field.
 *
 * Takes the table map so the guard can be shown catching a table this
 * codebase does not have — the same reason `connectAttemptTables` takes one.
 */
export function credentialBearingWorkspaceTables(
  tables: Record<string, { validator: unknown }> = schema.tables as unknown as Record<
    string,
    { validator: unknown }
  >,
): string[] {
  const found: string[] = [];
  for (const [tableName, table] of Object.entries(tables)) {
    const fields = fieldNamesOf(table.validator);
    if (!fields.includes("workspaceId")) continue;
    if (!fields.some((field) => /^encrypted/i.test(field))) continue;
    found.push(tableName);
  }
  return found.sort();
}

/**
 * Field names that mean **an obligation to somebody outside this deployment**.
 *
 * `credentialBearingWorkspaceTables` asks "does deleting this row strand a
 * secret", which is the question the cascade was written for. It is not the
 * only question the cascade has to answer, and `workspacePlans` is the proof:
 * it holds a Stripe subscription id, no credential of any kind, and deleting
 * its workspace without cancelling bills the customer every month with no route
 * in the product to stop it. It passed the guard above on the day it was
 * declared, and nothing would have raised it again.
 *
 * So the second derivation looks for an identifier issued by somebody else that
 * keeps costing or keeps existing after our row is gone. `stripe*` is the
 * shape that exists today; the list is here to be added to, and adding to it is
 * the diff a reviewer sees.
 *
 * **What still escapes**, and is therefore not claimed: an obligation whose
 * field is named for the thing rather than the provider (`subscriptionId`,
 * `externalId`), and one nested inside an object field. Same convention this
 * file already depends on for `encrypted*`, and the same caveat.
 */
const EXTERNAL_OBLIGATION_PATTERNS: readonly RegExp[] = [/^stripe[A-Z]/];

/**
 * Workspace-scoped tables holding a live obligation to an outside service.
 *
 * Deliberately a separate derivation from the credential one rather than a
 * widened regex: the two ask different questions, they are satisfied by
 * different things — a credential can be deleted, an obligation has to be
 * *ended* — and folding them together would mean one of them is documented
 * wrong.
 */
export function obligationBearingWorkspaceTables(
  tables: Record<string, { validator: unknown }> = schema.tables as unknown as Record<
    string,
    { validator: unknown }
  >,
): string[] {
  const found: string[] = [];
  for (const [tableName, table] of Object.entries(tables)) {
    const fields = fieldNamesOf(table.validator);
    if (!fields.includes("workspaceId")) continue;
    if (!fields.some((field) => EXTERNAL_OBLIGATION_PATTERNS.some((p) => p.test(field)))) {
      continue;
    }
    found.push(tableName);
  }
  return found.sort();
}

function isSwept(tableName: string): boolean {
  return (
    CASCADE_SOURCE.includes(`query("${tableName}")`) ||
    (CONNECT_ATTEMPT_TABLES as readonly string[]).includes(tableName)
  );
}

describe("every workspace-scoped table holding an outside obligation ends it", () => {
  /*
    The second question, and the one `workspacePlans` proved the first could not
    answer. Deleting a row that names somebody else's subscription does not
    strand a secret — it strands a *charge*, on a card, with the only
    cancellation path in the product deleted alongside it.
  */
  test("the derivation finds the tables that exist today", () => {
    expect(obligationBearingWorkspaceTables()).toEqual(["workspacePlans"]);
  });

  test("each one is swept, and ends the obligation before the row goes", () => {
    for (const tableName of obligationBearingWorkspaceTables()) {
      expect(
        isSwept(tableName),
        `${tableName} names an obligation to an outside service and is not swept by ` +
          `deleteWorkspaceCascade — deleting the workspace would leave it running`,
      ).toBe(true);
    }
    // Swept is not enough on its own: the cascade must *end* the thing, and it
    // must do it before deleting the row that names it. Ordering, not presence.
    const cancelAt = CASCADE_SOURCE.indexOf("cancelSubscription");
    const deleteAt = CASCADE_SOURCE.indexOf("ctx.db.delete(plan._id)");
    expect(cancelAt, "the cascade never cancels a subscription").toBeGreaterThan(-1);
    expect(deleteAt, "the cascade never deletes the plan row").toBeGreaterThan(-1);
    expect(
      cancelAt,
      "the cancellation must be scheduled before the row carrying its id is deleted",
    ).toBeLessThan(deleteAt);
  });

  test("the derivation catches a table this codebase does not have", () => {
    // Non-vacuity, in the shape the next one would arrive in: a second payment
    // provider, or a per-workspace subscription to anything billed.
    const withVendor = {
      ...(schema.tables as unknown as Record<string, { validator: unknown }>),
      vendorSeats: defineTable({
        workspaceId: v.id("workspaces"),
        stripeSubscriptionId: v.string(),
      }),
    };
    expect(obligationBearingWorkspaceTables(withVendor)).toContain("vendorSeats");
    // …and that it is not satisfied by the credential derivation, which is the
    // whole reason there are two.
    expect(credentialBearingWorkspaceTables(withVendor)).not.toContain("vendorSeats");
  });
});

describe("every sealed, workspace-scoped table is swept or explained", () => {
  test("the derivation finds the tables that exist today", () => {
    // Asserted exactly, so a new one is a diff to review rather than a silent
    // addition — and so this file cannot pass by finding nothing.
    expect(credentialBearingWorkspaceTables()).toEqual([
      "cloudflareProvisioning",
      "dropboxConnectAttempts",
      "googleConnectAttempts",
      "googleConnections",
      "storageBindings",
      "workspaceDataKeys",
    ]);
  });

  test("each one is swept by the cascade, or listed as a deliberate exception", () => {
    for (const tableName of credentialBearingWorkspaceTables()) {
      const accounted = isSwept(tableName) || tableName in DELIBERATE_EXCEPTIONS;
      expect(
        accounted,
        `${tableName} holds sealed material scoped to a workspace but is neither swept by ` +
          `deleteWorkspaceCascade nor listed in DELIBERATE_EXCEPTIONS with a reason`,
      ).toBe(true);
    }
  });

  test("the exception list is not a place to hide a table the cascade already sweeps", () => {
    for (const tableName of Object.keys(DELIBERATE_EXCEPTIONS)) {
      expect(credentialBearingWorkspaceTables()).toContain(tableName);
      expect(isSwept(tableName)).toBe(false);
    }
  });

  /**
   * The self-test, in the two shapes that get past `connectAttemptTables`.
   * Neither of these would be caught by the derivation the cascade loops over,
   * which is the whole reason this guard is a second one.
   */
  test("catches a new provider's connections table — the miss that started this", () => {
    const withSlack = {
      ...(schema.tables as unknown as Record<string, { validator: unknown }>),
      slackConnections: defineTable({
        workspaceId: v.id("workspaces"),
        encryptedRefreshToken: v.string(),
      }),
    };
    expect(credentialBearingWorkspaceTables(withSlack)).toContain("slackConnections");
    // And it is not swept, so the guard above would fail on it — which is the
    // day somebody has to decide what a teardown does with it.
    expect(isSwept("slackConnections")).toBe(false);
  });

  test("catches a connect attempt whose verifier is named slightly differently", () => {
    const tables = {
      notionConnectAttempts: defineTable({
        workspaceId: v.id("workspaces"),
        // NOT `encryptedVerifier` — invisible to `connectAttemptTables`, and
        // therefore never swept by the loop that derives from it.
        encryptedCodeVerifier: v.string(),
        expiresAt: v.number(),
      }),
    };
    expect(credentialBearingWorkspaceTables(tables)).toEqual(["notionConnectAttempts"]);
    expect(
      (CONNECT_ATTEMPT_TABLES as readonly string[]).includes("notionConnectAttempts"),
    ).toBe(false);
  });

  test("reads a union-declared table's variants, not just plain object tables", () => {
    const tables = {
      variantConnection: defineTable(
        v.union(
          v.object({ workspaceId: v.id("workspaces"), kind: v.literal("empty") }),
          v.object({
            workspaceId: v.id("workspaces"),
            kind: v.literal("live"),
            encryptedRefreshToken: v.string(),
          }),
        ),
      ),
    };
    expect(credentialBearingWorkspaceTables(tables)).toEqual(["variantConnection"]);
  });

  test("an unscoped credential and a scoped plain row are both left alone", () => {
    const tables = {
      platformSecret: defineTable({ encryptedValue: v.string() }),
      plainWorkspaceRow: defineTable({ workspaceId: v.id("workspaces"), at: v.number() }),
    };
    expect(credentialBearingWorkspaceTables(tables)).toEqual([]);
  });
});
