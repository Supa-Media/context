import { describe, expect, test } from "vitest";
import { doorStub } from "../functions/lib/rowWatch/objectDoor";
import { TEX_STORE_TICKET_TTL_MS } from "../functions/lib/texStoreTicketTtl";

// The console's door to a workspace object (`lib/rowWatch/objectDoor.ts`): every call carries a live ticket.
describe("the console's door to a workspace object", () => {
  test("a ticket is minted again before it expires, so a long action's later calls are not refused", async () => {
    let clock = 1_000_000;
    const minted: Array<{ hashedTicket: string; now: number }> = [];
    const ctx = { runMutation: async (_ref: unknown, args: { hashedTicket: string; now: number }) => void minted.push(args) };
    const sent: string[] = [];
    const stub = doorStub(ctx as never, "ws1" as never, {
      env: { STORAGE_MOVER_ORIGIN: "https://gateway.example.invalid", GATEWAY_SECRET: "test-secret" },
      now: () => clock,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sent.push((init.headers as Record<string, string>)["x-workspace-ticket"]!);
        return new Response(null);
      }) as typeof fetch,
    })!;
    const call = () => stub.fetch(new Request("https://store.internal/get", { method: "POST", headers: { "x-tex-call": "{}" } }));
    await call();
    clock += 60_000;
    await call();
    expect(minted).toHaveLength(1);
    expect(sent[1]).toBe(sent[0]);
    // Past the ticket's life (less the margin) a fresh one is minted and sent.
    clock += TEX_STORE_TICKET_TTL_MS;
    await call();
    expect(minted).toHaveLength(2);
    expect(sent[2]).not.toBe(sent[0]);
    expect(minted[1]!.now).toBe(clock);
  });

  // The gateway counts the door's calls by this label (2026-11-06: a control-plane caller made thousands of reads a
  // minute and nothing named it). Sabotage: drop the header in objectDoor.ts → this fails.
  test("every call names its caller with a fixed label, and an unusable label is sent as convex", async () => {
    const ctx = { runMutation: async () => undefined };
    const labels: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      labels.push((init.headers as Record<string, string>)["x-door-caller"]!);
      return new Response(null);
    }) as typeof fetch;
    const env = { STORAGE_MOVER_ORIGIN: "https://gateway.example.invalid", GATEWAY_SECRET: "test-secret" };
    for (const caller of ["file:maintainIndex", undefined, "Bad Label!"]) {
      const stub = doorStub(ctx as never, "ws1" as never, { env, fetchImpl, ...(caller === undefined ? {} : { caller }) })!;
      await stub.fetch(new Request("https://store.internal/get", { method: "POST", headers: { "x-tex-call": "{}" } }));
    }
    expect(labels).toEqual(["file:maintainIndex", "convex", "convex"]);
  });
});
