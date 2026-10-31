/**
 * The gateway's warm copy, kept in the sender's object (`warm.ts`).
 *
 * Sabotage (temporary local edits, reverted):
 *  - `warm: await deps.warm?.get()` dropped from `reply.ts`: "the next text
 *    hands back the copy the last answer gave" fails;
 *  - `keep` skipping the drop on an answer with none: "an answer with no copy
 *    drops the old one" fails;
 *  - `dropWarm` dropped from `textRoutine`: "a routine's text drops it" fails;
 *  - `keep` not comparing the drop count: "a routine that texts while a turn
 *    runs keeps that turn's copy from being kept" fails.
 */
import { describe, expect, it } from "vitest";
import { accept, drain, type InboxDeps } from "./inbox";
import type { Message } from "./reply";
import type { Fetch } from "./clients";
import { MemoryStorage } from "./memoryStorage.testing";
import { textRoutine } from "./routines";
import { KEEP_WARM_MS } from "./warm";

const msg = (eventId: string, text = "hi"): Message => ({ kind: "message", eventId, chatId: "chat_1", from: "+15555550100", messageId: `m_${eventId}`, text });

function deps(bodies: Record<string, unknown>[], answers: Record<string, unknown>[], now = () => 1_000): InboxDeps {
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body));
    if (path.endsWith("/typing") || path.endsWith("/read")) return new Response(null, { status: 204 });
    if (path.endsWith("/share_contact_card")) return new Response("{}", { status: 200 });
    if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t" });
    if (path === "/agent/events") return Response.json({ written: body.events.map((event: { id: string }) => event.id) });
    if (path === "/agent") {
      bodies.push(body);
      return Response.json(answers.shift() ?? { answer: "ok" });
    }
    if (path.endsWith("/messages")) return new Response("{}", { status: 200 });
    throw new Error(`unexpected ${path}`);
  }) as unknown as Fetch;
  return { fetch: fetcher, controlPlaneOrigin: "https://cp.example", workerSecret: "s", gatewayOrigin: "https://gw.example", linqApiKey: "k", now };
}

describe("the warm copy", () => {
  it("the next text hands back the copy the last answer gave, with the chat's newest events", async () => {
    const storage = new MemoryStorage();
    const bodies: Record<string, unknown>[] = [];
    await accept(storage, msg("e1", "hi Tex"), 1_000);
    await drain(storage, deps(bodies, [{ answer: "Hey.", warm: "tw1.sealed-one" }]));
    expect(bodies[0].warm).toBeUndefined();
    await accept(storage, msg("e2", "what's up"), 2_000);
    await drain(storage, deps(bodies, [{ answer: "Not much.", warm: "tw1.sealed-two" }], () => 2_000));
    expect(bodies[1].warm).toBe("tw1.sealed-one");
    const recent = bodies[1].recent as { text?: string; from: { kind: string } }[];
    expect(recent.map((event) => event.text)).toEqual(expect.arrayContaining(["hi Tex", "what's up"]));
    expect(recent.some((event) => event.from.kind === "tex")).toBe(true);
  });

  it("an answer with no copy drops the old one, and a day-old copy is not sent", async () => {
    const storage = new MemoryStorage();
    const bodies: Record<string, unknown>[] = [];
    await accept(storage, msg("e1"), 1_000);
    await drain(storage, deps(bodies, [{ answer: "Hey.", warm: "tw1.sealed-one" }]));
    await accept(storage, msg("e2"), 2_000);
    await drain(storage, deps(bodies, [{ answer: "Hey again." }], () => 2_000));
    await accept(storage, msg("e3"), 3_000);
    await drain(storage, deps(bodies, [{ answer: "Hi.", warm: "tw1.sealed-three" }], () => 3_000));
    expect(bodies[2].warm).toBeUndefined();
    await accept(storage, msg("e4"), 3_000 + KEEP_WARM_MS);
    await drain(storage, deps(bodies, [{ answer: "Hi." }], () => 3_000 + KEEP_WARM_MS));
    expect(bodies[3].warm).toBeUndefined();
  });

  it("a routine's text drops it: the chat holds words the copy hasn't seen", async () => {
    const storage = new MemoryStorage();
    const bodies: Record<string, unknown>[] = [];
    await accept(storage, msg("e1"), 1_000);
    await drain(storage, deps(bodies, [{ answer: "Hey.", warm: "tw1.sealed-one" }]));
    await textRoutine(storage, { text: "Morning! Here's your day.", idempotencyKey: "r1" }, { fetch: deps([], []).fetch, linqApiKey: "k", now: () => 1_500, simulator: false } as never);
    await accept(storage, msg("e2"), 2_000);
    await drain(storage, deps(bodies, [{ answer: "Hi." }], () => 2_000));
    expect(bodies[1].warm).toBeUndefined();
  });

  it("a routine that texts while a turn runs keeps that turn's copy from being kept", async () => {
    const storage = new MemoryStorage();
    const bodies: Record<string, unknown>[] = [];
    await accept(storage, msg("e1"), 1_000);
    await drain(storage, deps(bodies, [{ answer: "Hey.", warm: "tw1.sealed-one" }]));
    await accept(storage, msg("e2"), 2_000);
    const during = deps(bodies, [{ answer: "Hi.", warm: "tw1.made-before-the-routine" }], () => 2_000);
    const inner = during.fetch;
    during.fetch = (async (url: string, init: RequestInit) => {
      if (new URL(url).pathname === "/agent") await textRoutine(storage, { text: "Morning!", idempotencyKey: "r1" }, { fetch: inner, linqApiKey: "k", now: () => 2_000, simulator: false } as never);
      return inner(url, init);
    }) as unknown as Fetch;
    await drain(storage, during);
    await accept(storage, msg("e3"), 3_000);
    await drain(storage, deps(bodies, [{ answer: "Ok." }], () => 3_000));
    expect(bodies[2].warm).toBeUndefined();
  });
});
