/**
 * The old-copy cleanup's tickets (`lib/storageMover.ts`, `functions/storageMover.ts`):
 * a page handed to the gateway's mover is minted with its run, its cursor or its
 * keys, the mover's answer is read back, and the spent ticket carries the same
 * job when the mover claims it. The fetch to the mover is a stub; the ticket
 * store is the real `mintPage` / `claimPage` / `dropPage`.
 *
 * What is proved:
 *  - a list page's ticket names its run and its cursor, and no keys;
 *  - a delete page's ticket names its run and its keys, and no cursor;
 *  - a ticket is spent once: a second claim of the same ticket finds nothing;
 *  - a cleanup ticket naming keys on a list page, or no run, is refused at mint;
 *  - a mover that does not answer is `unanswered`, not a page that deleted.
 *
 * Sabotage (temporary local edit, reverted): drop the `cleanup_delete` check in
 * `mintPage` and the keys-on-a-list case fails; drop the cleanup fields from
 * `claimPage`'s return and the claim case fails.
 */

import { describe, expect, test } from "vitest";
import type { ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { hashToken } from "../../functions/lib/crypto";
import { runCleanupDeleteOnMover, runCleanupListOnMover } from "../../functions/lib/storageMover";
import { tester, boundWorkspace, type T } from "../noteIds/noteIds.helpers";

const env = { GATEWAY_SECRET: "gateway-secret-for-tests" };
const origin = "https://mover.example.test";

/**
 * A mover that spends the ticket it is sent, as the gateway does, and then
 * answers with `body`. The claim happens inside the request, since a ticket the
 * mover never spends is dropped once the answer is in.
 */
function moverStub(t: T, body: unknown, status = 200) {
  const tickets: string[] = [];
  const claims: (Record<string, unknown> | null)[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const ticket = JSON.parse(String(init.body)).ticket as string;
    tickets.push(ticket);
    claims.push((await t.mutation(internal.functions.storageMover.claimPage, { hashedTicket: await hashToken(ticket), now: Date.now() })) as never);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { tickets, claims, fetchImpl };
}

function ctxOf(t: T): ActionCtx {
  return {
    runMutation: (ref: unknown, args: unknown) => (t.mutation as unknown as (r: unknown, a: unknown) => Promise<unknown>)(ref, args),
  } as unknown as ActionCtx;
}

describe("cleanup tickets", () => {
  test("a list page's ticket names its run and cursor, and the claim returns them", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "list-ticket");
    const { tickets, claims, fetchImpl } = moverStub(t, { ok: true, keys: ["a.md"], nextCursor: "a.md" });
    const outcome = await runCleanupListOnMover(ctxOf(t), ws, { runId: 3, cursor: "9.md" }, origin, { fetchImpl, env });
    expect(outcome).toEqual({ kind: "done", keys: ["a.md"], nextCursor: "a.md" });
    expect(claims[0]).toMatchObject({ workspaceId: ws, cleanupRunId: 3, phase: "cleanup_list", expectedCursor: "9.md" });
    expect(claims[0]?.cleanupKeys ?? []).toEqual([]);
    // Spent once: the same ticket finds nothing the second time.
    expect(await t.mutation(internal.functions.storageMover.claimPage, { hashedTicket: await hashToken(tickets[0]!), now: Date.now() })).toBeNull();
  });

  test("a delete page's ticket names its run and its keys, and no cursor", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "delete-ticket");
    const { claims, fetchImpl } = moverStub(t, { ok: true, results: [{ key: "old.md", ok: true }] });
    const outcome = await runCleanupDeleteOnMover(ctxOf(t), ws, { runId: 4, keys: ["old.md"] }, origin, { fetchImpl, env });
    expect(outcome).toEqual({ kind: "done", results: [{ key: "old.md", ok: true }] });
    expect(claims[0]).toMatchObject({ workspaceId: ws, cleanupRunId: 4, phase: "cleanup_delete", cleanupKeys: ["old.md"] });
    expect(claims[0]?.expectedCursor).toBeUndefined();
  });

  test("a ticket that names keys on a list page, or carries no run, is refused at mint", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "bad-ticket");
    const base = { workspaceId: ws, hashedTicket: "h1", now: Date.now() };
    await expect(
      t.mutation(internal.functions.storageMover.mintPage, { ...base, cleanupRunId: 1, cleanupKeys: ["x.md"], phase: "cleanup_list" }),
    ).rejects.toThrow();
    await expect(t.mutation(internal.functions.storageMover.mintPage, { ...base, phase: "cleanup_delete" })).rejects.toThrow();
    await expect(t.mutation(internal.functions.storageMover.mintPage, { ...base, cleanupRunId: 1, phase: "copy" })).rejects.toThrow();
  });

  test("a mover that does not answer, or answers a failure, is not a page that deleted", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "no-answer");
    const down = moverStub(t, {}, 500);
    expect(await runCleanupDeleteOnMover(ctxOf(t), ws, { runId: 1, keys: ["old.md"] }, origin, { fetchImpl: down.fetchImpl, env })).toEqual({
      kind: "unanswered",
    });
    const failed = moverStub(t, { ok: false, error: "CLEANUP_FAILED" });
    expect(await runCleanupDeleteOnMover(ctxOf(t), ws, { runId: 1, keys: ["old.md"] }, origin, { fetchImpl: failed.fetchImpl, env })).toEqual({
      kind: "failed",
      code: "CLEANUP_FAILED",
    });
    const stale = moverStub(t, { ok: false, error: "STALE" });
    expect(await runCleanupListOnMover(ctxOf(t), ws, { runId: 1 }, origin, { fetchImpl: stale.fetchImpl, env })).toEqual({ kind: "stale" });
    // Nothing was left behind: every ticket a failed hand-over minted was dropped again.
    const left = await t.run((ctx) => ctx.db.query("moverTickets").collect());
    expect(left).toEqual([]);
  });
  test("a ticket of the retired move into another context is spent, never claimed", async () => {
    // Production may still hold `carry` tickets from the removed move between contexts.
    const t = tester();
    const ws = await boundWorkspace(t, "carry-ticket");
    const hashedTicket = await hashToken("carry-ticket-secret");
    await t.run((ctx) =>
      ctx.db.insert("moverTickets", { hashedTicket, workspaceId: ws, phase: "carry", objects: [], createdAt: Date.now(), expiresAt: Date.now() + 60_000 } as never),
    );
    expect(await t.mutation(internal.functions.storageMover.claimPage, { hashedTicket, now: Date.now() })).toBeNull();
    expect(await t.run((ctx) => ctx.db.query("moverTickets").collect())).toEqual([]);
  });
});
