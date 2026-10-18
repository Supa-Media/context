import { describe, expect, it } from "vitest";
import { hostPicture, MAX_HOSTED_BYTES, MEDIA_FOR_MS, pruneMedia, serveMedia, workerOrigin } from "./media";
import { MemoryStorage } from "./memoryStorage.testing";

const OBJECT = "a".repeat(64);
const picture = { name: "p.png", mediaType: "image/png", data: btoa("png-bytes") };

describe("hosted pictures", () => {
  it("serves the bytes at an unguessable address until they expire", async () => {
    const storage = new MemoryStorage();
    const url = await hostPicture(storage, "https://agent.example", OBJECT, picture, 1_000);
    const match = /^https:\/\/agent\.example\/media\/a{64}\/([0-9a-f]{64})\.png$/.exec(url);
    expect(match).not.toBeNull();
    const token = match![1];
    const served = await serveMedia(storage, token, 2_000);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(new TextDecoder().decode(await served.arrayBuffer())).toBe("png-bytes");
    expect((await serveMedia(storage, token, 1_000 + MEDIA_FOR_MS + 1)).status).toBe(404);
    expect((await serveMedia(storage, "f".repeat(64), 2_000)).status).toBe(404);
    expect((await serveMedia(storage, "../seen:x", 2_000)).status).toBe(404);
  });

  it("gives a fresh address each time", async () => {
    const storage = new MemoryStorage();
    const a = await hostPicture(storage, "https://agent.example", OBJECT, picture, 1_000);
    const b = await hostPicture(storage, "https://agent.example", OBJECT, picture, 1_000);
    expect(a).not.toBe(b);
  });

  it("refuses with no origin, an odd type, or a picture too big to keep", async () => {
    const storage = new MemoryStorage();
    await expect(hostPicture(storage, undefined, OBJECT, picture, 1_000)).rejects.toThrow();
    await expect(hostPicture(storage, "https://agent.example", OBJECT, { ...picture, mediaType: "image/svg+xml" }, 1_000)).rejects.toThrow();
    const big = { ...picture, data: btoa("x".repeat(MAX_HOSTED_BYTES + 1)) };
    await expect(hostPicture(storage, "https://agent.example", OBJECT, big, 1_000)).rejects.toThrow();
    expect([...storage.data.keys()].filter((k) => k.startsWith("media:"))).toEqual([]);
  });

  it("prunes what expired and wakes for the rest, but never delays a waiting text", async () => {
    const storage = new MemoryStorage();
    await hostPicture(storage, "https://agent.example", OBJECT, picture, 1_000);
    await hostPicture(storage, "https://agent.example", OBJECT, picture, 1_000 + MEDIA_FOR_MS);
    await pruneMedia(storage, 1_000 + MEDIA_FOR_MS + 1);
    expect([...storage.data.keys()].filter((k) => k.startsWith("media:"))).toHaveLength(1);
    expect(storage.alarms.at(-1)).toBe(1_000 + 2 * MEDIA_FOR_MS + 1 + 1_000);
    await storage.put("pending:000000000001", {});
    const before = storage.alarms.length;
    await pruneMedia(storage, 1_000 + MEDIA_FOR_MS + 2);
    expect(storage.alarms.length).toBe(before);
  });

  it("leaves a sooner alarm alone, such as an owed ready text", async () => {
    const storage = new MemoryStorage();
    await hostPicture(storage, "https://agent.example", OBJECT, picture, 1_000);
    const soon = 5_000;
    const withAlarm = Object.assign(storage, { getAlarm: async () => soon });
    const before = storage.alarms.length;
    await pruneMedia(withAlarm, 2_000);
    expect(storage.alarms.length).toBe(before);
  });

  it("only trusts an https origin with nothing after it", () => {
    expect(workerOrigin("https://agent.example")).toBe("https://agent.example");
    expect(workerOrigin("http://agent.example")).toBeNull();
    expect(workerOrigin("https://agent.example/x")).toBeNull();
    expect(workerOrigin(null)).toBeNull();
  });
});
