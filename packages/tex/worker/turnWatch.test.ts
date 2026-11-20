import { describe, expect, it } from "vitest";
import { AlarmStorage, MemoryStorage } from "./memoryStorage.testing";
import { startTurn } from "./steer";
import { dropStopped, markRunning, queueView, recoverLostTurn, retryText, stopTurn, STOPPED_PREFIX, TURN_RUN_KEY, WATCH_MS } from "./turnWatch";
import type { Entry } from "./inboxTurn";
import type { Fetch } from "./clients";

const message = (eventId: string) => ({ kind: "message" as const, eventId, chatId: "app:u1", from: "app:u1", messageId: eventId, text: `words ${eventId}` });
const entry = (key: string, ev: string): Entry => [key, { message: message(ev), attempts: 0, ev }];

describe("turnWatch", () => {
  it("never moves a sooner alarm later, and keeps the lost count when the same item runs again", async () => {
    const storage = new AlarmStorage();
    await storage.setAlarm(1_010);
    await markRunning(storage, [entry("pending:1", "e1")], 1_000);
    expect(storage.alarm).toBe(1_010);
    storage.fire();
    await markRunning(storage, [entry("pending:1", "e1")], 2_000);
    expect(storage.alarm).toBe(2_000 + WATCH_MS);
    await storage.put(TURN_RUN_KEY, { ...(await storage.get(TURN_RUN_KEY))!, lost: 1 });
    await markRunning(storage, [entry("pending:1", "e1")], 3_000);
    expect(await storage.get(TURN_RUN_KEY)).toMatchObject({ lost: 1, covers: ["e1"] });
    await markRunning(storage, [entry("pending:2", "e2")], 4_000);
    expect(await storage.get(TURN_RUN_KEY)).toMatchObject({ lost: 0 });
  });

  it("a turn live in this object's memory is never taken for a lost one", async () => {
    const storage = new MemoryStorage();
    await markRunning(storage, [entry("pending:1", "e1")], 1_000);
    const { end } = startTurn(storage, "app:u1", "app:u1", { fetch: (async () => new Response()) as unknown as Fetch, gatewayOrigin: "https://gw", controlPlaneOrigin: "https://cp", workerSecret: "s" }, ["e1"], async () => {});
    expect(await recoverLostTurn(storage, undefined, 9_000)).toBe("none");
    end();
    expect(await recoverLostTurn(storage, undefined, 9_000)).toBe("retry");
  });

  it("stop cancels the running turn, marks its texts, and its end drops only those", async () => {
    const storage = new MemoryStorage();
    await storage.put("pending:1", { message: message("e1"), attempts: 0, ev: "e1" });
    await storage.put("pending:2", { message: message("e2"), attempts: 0, ev: "e2" });
    const asked: string[] = [];
    const fetch = (async (url: string) => (asked.push(new URL(url).pathname), Response.json({ cancelled: true }))) as unknown as Fetch;
    expect((await stopTurn(storage, "app:u1", 5_000)).outcome).toBe("idle");
    const { live, steer } = startTurn(storage, "app:u1", "app:u1", { fetch, gatewayOrigin: "https://gw", controlPlaneOrigin: "https://cp", workerSecret: "s" }, ["e1"], async () => {});
    await steer.onSession("token");
    expect(await stopTurn(storage, "app:u1", 5_000)).toEqual({ outcome: "stopped", covers: ["e1"] });
    expect(asked).toEqual(["/agent/cancel"]);
    expect(live.cancelled).toBe(true);
    await dropStopped(storage, [entry("pending:1", "e1"), entry("pending:2", "e2")]);
    expect([...(await storage.list({ prefix: "pending:" })).keys()]).toEqual(["pending:2"]);
    expect((await queueView(storage)).stopped).toEqual({ e1: 5_000 });
    expect(await retryText(storage, "e1", 6_000)).toBe(true);
    expect(await storage.get(`${STOPPED_PREFIX}e1`)).toBeUndefined();
    expect(await retryText(storage, "e1", 6_000)).toBe(false);
  });
});
