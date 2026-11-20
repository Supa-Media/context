import { describe, expect, it } from "vitest";
import { TEXTS_WORKSPACE_KEY } from "./gatewaySession";
import { sha256Hex } from "./groupChat";
import { MemoryStorage } from "./memoryStorage.testing";
import { photonSendStatusOf } from "./photonSendStatus";
import type { SendStatus } from "./sendblueStatus";
import { ASK_AGAIN_MS, warmOnRead } from "./warmStep";

const NOW = 1_800_000_000_000;
const LINE = "+15555550199";
const GROUP_GUID = "any;+;chat123456789";

function gateway(status = 200) {
  const asked: Record<string, unknown>[] = [];
  const texts = {
    fetch: async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://gateway/texts/warm");
      asked.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response("{}", { status });
    },
  };
  return { asked, texts };
}

const readOf = (chat: Record<string, unknown>): SendStatus => {
  const status = photonSendStatusOf({ type: "message.read", fromMe: false, line: LINE, chat, read: { targetGuid: "p:0/ABCDEF01-2345-6789-ABCD-EF0123456789" }, at: "2026-11-20T10:00:00.000Z" });
  if (status === null) throw new Error("not a read");
  return status;
};

describe("warm on read (node warm, the cache rules)", () => {
  it("a person's read asks to warm their own home, once in ten minutes", async () => {
    const storage = new MemoryStorage();
    await storage.put(TEXTS_WORKSPACE_KEY, "ws_1");
    const { asked, texts } = gateway();
    const status = readOf({ kind: "dm", guid: "any;-;+15555550100" });
    expect(status.line).toBe(LINE);
    expect(await warmOnRead(storage, status, { texts, now: () => NOW })).toBe("asked");
    expect(asked).toEqual([{ person: "ws_1", cause: "read" }]);
    expect(await warmOnRead(storage, status, { texts, now: () => NOW + 60_000 })).toBe("recent");
    expect(await warmOnRead(storage, status, { texts, now: () => NOW + ASK_AGAIN_MS + 1 })).toBe("asked");
    expect(asked).toHaveLength(2);
  });

  it("a group's read names its home by its ledger key, never a person", async () => {
    const storage = new MemoryStorage();
    const { asked, texts } = gateway();
    const status = readOf({ kind: "group", guid: GROUP_GUID });
    expect(await warmOnRead(storage, status, { texts, now: () => NOW })).toBe("asked");
    const groupId = (status.object as { groupId: string }).groupId;
    expect(asked).toEqual([{ chat: await sha256Hex(`${LINE}:${groupId}`), cause: "read" }]);
  });

  it("asks nothing with no home known, no gateway, or a status that is not a read", async () => {
    const { asked, texts } = gateway();
    const status = readOf({ kind: "dm", guid: "any;-;+15555550100" });
    expect(await warmOnRead(new MemoryStorage(), status, { texts, now: () => NOW })).toBe("no_home");
    expect(await warmOnRead(new MemoryStorage(), status, { now: () => NOW })).toBe("no_gateway");
    const sent = { ...status, report: { ...status.report!, status: "sent" as const } };
    expect(await warmOnRead(new MemoryStorage(), sent, { texts, now: () => NOW })).toBe("not_read");
    expect(asked).toEqual([]);
  });
});
