/**
 * Rows the byte-move removal (#2100) left behind in production still
 * validate, so the schema push succeeds, and none of them ever runs: a
 * leftover `materialize_move` gateway job and a `carry` mover ticket are
 * spent when presented. Production's deploy failed on exactly such a row on
 * 2026-10-23 ("materialize_move does not match literal image_upload").
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-10-23):
 * dropping the `kind` check in `claimGatewayJobHandler` fails the first test.
 */

import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import { hashToken } from "../functions/lib/crypto";
import { twoConnectedTenants } from "./controlPlane/fixtures.helpers";

const TICKET = "a".repeat(64);

describe("rows left by the retired byte moves", () => {
  test("a leftover materialize_move job validates and is spent, never run", async () => {
    const { t, alice, aliceWs, grantA } = await twoConnectedTenants();
    const hashedTicket = await hashToken(TICKET);
    const now = Date.now();
    await t.run((ctx) =>
      ctx.db.insert("gatewayJobs", {
        hashedTicket,
        workspaceId: aliceWs,
        actorUserId: alice,
        actorClientId: "client_a",
        grantId: grantA as never,
        kind: "materialize_move",
        moveId: "move_1",
        status: "queued",
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + 60 * 60 * 1000,
      }),
    );
    expect(await t.mutation(internal.functions.controlPlane.claimGatewayJob, { hashedTicket })).toBeNull();
    const row = await t.run((ctx) => ctx.db.query("gatewayJobs").first());
    expect(row?.status).toBe("queued");
  });

  test("a leftover carry ticket validates and is spent, never carried", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    const hashedTicket = await hashToken(TICKET);
    await t.run((ctx) =>
      ctx.db.insert("moverTickets", { hashedTicket, workspaceId: aliceWs, phase: "carry", createdAt: Date.now(), expiresAt: Date.now() + 60_000 }),
    );
    expect(await t.mutation(internal.functions.storageMover.claimPage, { hashedTicket, now: Date.now() })).toBeNull();
    expect(await t.run((ctx) => ctx.db.query("moverTickets").collect())).toHaveLength(0);
  });
});
