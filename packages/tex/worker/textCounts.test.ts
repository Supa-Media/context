import { describe, expect, it } from "vitest";
import { countInbound, countOutbound, counted, inboundPoint, outboundPoint, type CountDataset } from "./textCounts";
import { lineFor } from "./line";
import { groupLineFor } from "./groupLine";

function dataset(): CountDataset & { points: Array<{ blobs?: string[]; doubles?: number[]; indexes?: string[] }> } {
  const points: Array<{ blobs?: string[]; doubles?: number[]; indexes?: string[] }> = [];
  return { points, writeDataPoint: (point) => void points.push(point) };
}

const ok = async () => new Response(JSON.stringify({ message_handle: "h1" }), { status: 200, headers: { "content-type": "application/json" } });
const refused = async () => new Response("no", { status: 500 });
const keys = { keyId: "test-key", secret: "test-secret" };

describe("text counts for the staff dashboard (textCounts.ts)", () => {
  it("an inbound point names the person by an id only, and no words", () => {
    expect(inboundPoint("one", "text", "abc123")).toEqual({ blobs: ["in", "one", "text"], doubles: [1], indexes: ["abc123"] });
    expect(outboundPoint("group", "media")).toEqual({ blobs: ["out", "group", "media"], doubles: [1], indexes: ["out:group"] });
  });

  it("writes nothing without a binding or a person, and a throwing binding never throws", () => {
    expect(() => countInbound(undefined, "one", "text", "abc")).not.toThrow();
    const data = dataset();
    countInbound(data, "one", "text", "");
    expect(data.points).toEqual([]);
    const broken: CountDataset = {
      writeDataPoint: () => {
        throw new Error("down");
      },
    };
    expect(() => countOutbound(broken, "one", "text")).not.toThrow();
  });

  it("counts a send only once it went", async () => {
    const data = dataset();
    expect(await counted(data, "one", "text", async () => "sent")).toBe("sent");
    await expect(counted(data, "one", "text", async () => Promise.reject(new Error("refused")))).rejects.toThrow("refused");
    expect(data.points.length).toBe(1);
  });

  it("a 1:1 line counts each text it sends, and not one that failed", async () => {
    const data = dataset();
    const chat = "sendblue:+15550000001:+15550000002";
    await lineFor({ fetch: ok, linqApiKey: "", sendblue: keys, textCounts: data }, chat).sendText(chat, "hello", "k1");
    await expect(lineFor({ fetch: refused, linqApiKey: "", sendblue: keys, textCounts: data }, chat).sendText(chat, "hello", "k2")).rejects.toThrow();
    expect(data.points.map((p) => p.blobs)).toEqual([["out", "one", "text"]]);
    // No phone number anywhere in what was written.
    expect(JSON.stringify(data.points)).not.toContain("555");
  });

  it("a group line counts what it sends", async () => {
    const data = dataset();
    await groupLineFor({ fetch: ok, sendblue: keys, textCounts: data }, "group-1").sendText({ line: "+15550000001", groupId: "group-1" }, "hi all");
    expect(data.points.map((p) => p.blobs)).toEqual([["out", "group", "text"]]);
  });
});

describe("a person's counting key (objectPlace.ts inboxIdOf)", () => {
  it("is their inbox's id under its placed name, and empty without a name", async () => {
    const { inboxIdOf } = await import("./objectPlace");
    const names: string[] = [];
    const namespace = { idFromName: (name: string) => (names.push(name), { toString: () => `id-of-${name.length}` }) } as unknown as DurableObjectNamespace;
    expect(inboxIdOf(namespace, "+15550000003")).toBe("id-of-17");
    expect(names).toEqual(["enam:+15550000003"]);
    expect(inboxIdOf(namespace, "")).toBe("");
    expect(inboxIdOf(namespace, undefined)).toBe("");
  });
});
