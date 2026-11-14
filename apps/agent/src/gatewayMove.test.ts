/**
 * The gateway move of a chat's inbox (`gatewayMove.ts`, `inboxMove.ts` gateway branch).
 *
 * Sabotage record (each break run alone on the source, then reverted; fake values only):
 * - `forward` sends a gateway-moved call to the sibling stub instead of the gateway binding:
 *   4 fail (forwarded calls, 502 passthrough, 503 without binding, purged copy still forwarding).
 * - `readChatMove` drops the `job:` refusal: 1 fails (the refusal test; `job:j1` accepted).
 * - `readChatMove` drops the `group-key:` directory refusal: 1 fails (the refusal test; `group-key:` accepted).
 * - `serveMoveOut` drops the arrival fields from the gateway copy: 2 fail (out keeps arrival; back restores).
 * - `moveBack` drops the arrival fields: 2 fail (back restores; hand-back takes calls again).
 * - `serveMoveOut` drops the stub guard on the sibling move: 2 fail (this file's stub-ask test; inboxMove's
 *   existing "a call through the Worker's stub" test).
 * - the VIA_NEW hand-back is skipped for a gateway-moved copy: 1 fails (the hand-back test).
 * Reverted after each run: 19 of 19 green.
 */

import { describe, expect, test } from "vitest";
import { chatMove, readChatMove } from "./gatewayMove";
import { GATEWAY, KEEP_OLD_MS, OLD_NAME, PLACE_KEY, movedAlarm, placedName, type Place } from "./inboxMove";
import { PHONE, World, oldInboxWith } from "./inboxMoveWorld.testing";

/** The namespace `objectByName` reaches: a stub per name, as the world keeps them. */
function namespaceOf(world: World): DurableObjectNamespace {
  const get = (id: string) => ({
    fetch: (input: string | Request, init?: RequestInit) => world.stub(id).fetch(input instanceof Request ? input : new Request(input, init)),
  });
  return { idFromName: (name: string) => name, get } as unknown as DurableObjectNamespace;
}

/** The gateway's binding, recording what it was sent and answering a status the test sets. */
function gatewayFake() {
  const calls: { url: string; method: string; inbox: string | null; body: string }[] = [];
  const answer = { status: 200 };
  return {
    calls,
    answer,
    fetch: async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body = init?.body === undefined || init.body === null ? "" : new TextDecoder().decode(init.body as ArrayBuffer);
      calls.push({ url, method: init?.method ?? "GET", inbox: headers.get("x-inbox-name"), body });
      return new Response(`gateway ${answer.status}`, { status: answer.status });
    },
  };
}

/** The old inbox's keys copied into the placed inbox, which has arrived. */
async function arrivedWorld() {
  const world = new World();
  const old = await oldInboxWith(world);
  await world.placed(PHONE).fetch("https://inbox/get?k=count");
  const placed = world.inbox(placedName(PHONE));
  return { world, old, placed };
}

describe("refusing the calls that never move", () => {
  test("a job's object, a group's directory entry, a bad name and an unknown op are refused before anything is asked", async () => {
    const world = new World();
    const ns = namespaceOf(world);
    const refused: unknown[] = [
      { inbox: "job:j1", op: "out" },
      { inbox: "job:j1", op: "back" },
      { inbox: "group-key:abc123", op: "out" },
      { inbox: "", op: "out" },
      { inbox: "a\0b", op: "out" },
      { inbox: "a".repeat(513), op: "back" },
      { inbox: 7, op: "out" },
      { inbox: PHONE, op: "sideways" },
      null,
      "x",
    ];
    for (const call of refused) {
      expect(() => readChatMove(call)).toThrow(TypeError);
      await expect(chatMove(ns, call)).rejects.toThrow(TypeError);
    }
    expect(world.calls).toEqual([]);
    expect(OLD_NAME.test("a".repeat(512))).toBe(true);
    expect(readChatMove({ inbox: PHONE, op: "out" })).toEqual({ inbox: PHONE, op: "out" });
  });
});

describe("moving a chat's inbox out to the gateway", () => {
  test("out answers the entries, digest and alarm, and marks the inbox moved to the gateway, keeping its arrival", async () => {
    const { world, placed } = await arrivedWorld();
    const answer = await chatMove(namespaceOf(world), { inbox: PHONE, op: "out" });
    expect(answer.status).toBe(200);
    const body = answer.body as { entries: Record<string, unknown>; digest: string; alarm: number | null };
    expect(body.entries.count).toBe(3);
    expect(body.entries["media:chunk:0"]).toEqual({ __bytes: "AQID+g==" });
    expect(body.entries[PLACE_KEY]).toBeUndefined();
    expect(body.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(body.alarm).toBe(1_234_567);
    const place = placed.storage.data.get(PLACE_KEY) as Place;
    expect(place).toMatchObject({ movedTo: GATEWAY, name: PHONE, movedAt: world.now, arrivedAt: world.now, keys: 3 });
    expect(placed.storage.alarm).toBe(world.now + KEEP_OLD_MS);
    expect(placed.storage.data.get("pending:1")).toEqual({ text: "hi", at: 5, tags: ["a"], nested: { n: 1, flag: true, none: null } });
  });

  test("later calls to the inbox's names are forwarded to the gateway with the original path, query, body and inbox header", async () => {
    const { world, placed } = await arrivedWorld();
    const gateway = gatewayFake();
    world.gateway = gateway;
    await chatMove(namespaceOf(world), { inbox: PHONE, op: "out" });

    const late = await world.placed(PHONE).fetch("https://inbox/put?k=late", { method: "POST", body: "x" });
    expect(await late.text()).toBe("gateway 200");
    expect(gateway.calls).toEqual([{ url: "https://gateway/texts/chat-call/put?k=late", method: "POST", inbox: PHONE, body: "x" }]);
    expect(placed.storage.data.has("late")).toBe(false);

    // Through the old, unplaced name: its copy passes the call to the placed inbox, which passes it to the gateway.
    expect(await (await world.stub(PHONE).fetch(new Request("https://inbox/get?k=count"))).text()).toBe("gateway 200");
    expect(gateway.calls[1]).toEqual({ url: "https://gateway/texts/chat-call/get?k=count", method: "GET", inbox: PHONE, body: "" });
  });

  test("a gateway answer that fails is passed back as it is", async () => {
    const { world } = await arrivedWorld();
    const gateway = gatewayFake();
    gateway.answer.status = 502;
    world.gateway = gateway;
    await chatMove(namespaceOf(world), { inbox: PHONE, op: "out" });
    const reply = await world.placed(PHONE).fetch("https://inbox/get?k=count");
    expect(reply.status).toBe(502);
    expect(await reply.text()).toBe("gateway 502");
  });

  test("with no gateway binding, a forwarded call answers 503", async () => {
    const { world } = await arrivedWorld();
    await chatMove(namespaceOf(world), { inbox: PHONE, op: "out" });
    expect(world.gateway).toBeUndefined();
    expect((await world.placed(PHONE).fetch("https://inbox/get?k=count")).status).toBe(503);
  });

  test("a busy inbox answers 409 and stays where it is", async () => {
    const { world, placed } = await arrivedWorld();
    const slow = world.placed(PHONE).fetch("https://inbox/slow", { method: "POST" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const answer = await chatMove(namespaceOf(world), { inbox: PHONE, op: "out" });
    expect(answer.status).toBe(409);
    expect(answer.body).toEqual({ busy: true });
    expect((placed.storage.data.get(PLACE_KEY) as Place).movedTo).toBeUndefined();
    placed.release!();
    await slow;
    expect((await chatMove(namespaceOf(world), { inbox: PHONE, op: "out" })).status).toBe(200);
  });

  test("the gateway's ask carries no more than a sibling's: a stub call with to other than gateway is refused, one with to gateway is answered", async () => {
    const { world, placed } = await arrivedWorld();
    const stub = world.placed(PHONE);
    const elsewhere = await stub.fetch("https://inbox/__move_out", { method: "POST", body: JSON.stringify({ name: PHONE, to: "elsewhere" }) });
    expect(elsewhere.status).toBe(400);
    const sibling = await stub.fetch("https://inbox/__move_out", { method: "POST", body: JSON.stringify({ name: PHONE }) });
    expect(sibling.status).toBe(400);
    expect((placed.storage.data.get(PLACE_KEY) as Place).movedTo).toBeUndefined();
    const gateway = await stub.fetch("https://inbox/__move_out", { method: "POST", body: JSON.stringify({ name: PHONE, to: GATEWAY }) });
    expect(gateway.status).toBe(200);
  });
});

describe("taking a chat's inbox back, and the copy's end", () => {
  test("back restores the arrived inbox: its calls are served there again, its alarm as it was", async () => {
    const { world, placed } = await arrivedWorld();
    const gateway = gatewayFake();
    world.gateway = gateway;
    await chatMove(namespaceOf(world), { inbox: PHONE, op: "out" });
    const back = await chatMove(namespaceOf(world), { inbox: PHONE, op: "back" });
    expect(back.status).toBe(200);
    expect(placed.storage.data.get(PLACE_KEY)).toEqual({ arrivedAt: world.now, keys: 3 });
    expect(placed.storage.alarm).toBe(1_234_567);
    expect(await (await world.placed(PHONE).fetch("https://inbox/get?k=count")).text()).toBe("3");
    expect(gateway.calls).toEqual([]);
    // And it can move out again.
    expect((await chatMove(namespaceOf(world), { inbox: PHONE, op: "out" })).status).toBe(200);
  });

  test("a call the gateway hands back to a moved copy takes the calls again, as a sibling's does", async () => {
    const { world, placed } = await arrivedWorld();
    const gateway = gatewayFake();
    world.gateway = gateway;
    await chatMove(namespaceOf(world), { inbox: PHONE, op: "out" });
    const handed = await world.stub(placedName(PHONE)).fetch(
      new Request("https://inbox/get?k=count", { headers: { "x-inbox-via-new": "1", "x-inbox-name": PHONE } }),
    );
    expect(await handed.text()).toBe("3");
    expect(gateway.calls).toEqual([]);
    const place = placed.storage.data.get(PLACE_KEY) as Place;
    expect(place.movedTo).toBeUndefined();
    expect(place.arrivedAt).toBe(world.now);
  });

  test("the moved copy's alarm runs nothing and clears the copy after three days; calls still reach the gateway", async () => {
    const { world, placed } = await arrivedWorld();
    const gateway = gatewayFake();
    world.gateway = gateway;
    await chatMove(namespaceOf(world), { inbox: PHONE, op: "out" });
    expect(await movedAlarm(placed.storage, world.now + 10)).toBe(true);
    expect(placed.storage.data.get("count")).toBe(3);
    expect(placed.storage.alarm).toBe(world.now + KEEP_OLD_MS);
    expect(await movedAlarm(placed.storage, world.now + KEEP_OLD_MS)).toBe(true);
    expect([...placed.storage.data.keys()]).toEqual([PLACE_KEY]);
    expect(placed.storage.alarm).toBeNull();
    expect(await (await world.placed(PHONE).fetch("https://inbox/get?k=count")).text()).toBe("gateway 200");
    expect(gateway.calls).toHaveLength(1);
  });
});
