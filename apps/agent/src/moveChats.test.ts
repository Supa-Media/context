import { describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import type { Line } from "./line";
import { unwritten } from "./events";
import { CHAT_KEY } from "./inbox";
import { MemoryStorage } from "./memoryStorage.testing";
import { MOVE_TOLD_KEY, movePerson, noteMoved, parseDueMoves, reportOf, runDueMoves, type MoveOutcome } from "./moveChats";

const PHONE = "+15555550100";
const OLD_CHAT = `sendblue:+15555550199:${PHONE}`;
const NEW_CHAT = `photon:+15555550142:${PHONE}`;
const NUMBER = "+15555550142";
const NOW = 1_800_000_000_000;
const TEXT = "Tex here, swapping numbers: I'm on the new one now.";
const body = { askedAt: 42, number: NUMBER, archiveOn: null };

function world(options: { gateway?: () => Response | Promise<Response>; sendFails?: boolean; noTexts?: boolean } = {}) {
  const sent: { chatId: string; text: string; key: string }[] = [];
  const asked: unknown[] = [];
  const texts = {
    fetch: async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://gateway/texts/move");
      asked.push(JSON.parse(String(init?.body)));
      return options.gateway ? options.gateway() : Response.json({ to: "person", text: TEXT });
    },
  };
  const line = {
    sendText: async (chatId: string, text: string, key: string) => {
      if (options.sendFails) throw new Error("line down");
      sent.push({ chatId, text, key });
    },
  } as unknown as Line;
  const deps = { fetch: (async () => new Response(null)) as unknown as Fetch, linqApiKey: "", now: () => NOW, remoteLine: () => line, ...(options.noTexts ? {} : { texts }) };
  return { deps, sent, asked };
}

async function remembering(chatId: string) {
  const storage = new MemoryStorage();
  await storage.put(CHAT_KEY, { chatId, at: 1 });
  return storage;
}

describe("movePerson", () => {
  it("asks the node for the words and sends them once on the person's old Sendblue chat", async () => {
    const storage = await remembering(OLD_CHAT);
    const { deps, sent, asked } = world();
    expect(await movePerson(storage, body, deps)).toBe("told");
    expect(asked).toEqual([{ kind: "person", number: NUMBER }]);
    expect(sent).toEqual([{ chatId: OLD_CHAT, text: TEXT, key: `move:${OLD_CHAT}:42` }]);
    expect(await storage.get(MOVE_TOLD_KEY)).toEqual({ askedAt: 42, at: NOW });
    // The same ask again (a cron that retried) texts nobody.
    expect(await movePerson(storage, body, deps)).toBe("already_told");
    expect(sent).toHaveLength(1);
    // A new ask from staff sends again.
    expect(await movePerson(storage, { ...body, askedAt: 43 }, deps)).toBe("told");
    expect(sent).toHaveLength(2);
  });

  it("logs the step with what it saw and how it went, never the number, the phone or the words", async () => {
    const storage = await remembering(OLD_CHAT);
    await movePerson(storage, body, world().deps);
    const steps = (await unwritten(storage)).filter((event) => event.kind === "step");
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ chat: OLD_CHAT, step: { name: "moveChat", ok: true, input: { kind: "person", number: true, archiveOn: false }, output: { outcome: "told", textChars: TEXT.length } } });
    const logged = JSON.stringify(steps[0].step);
    expect(logged).not.toContain("555555");
    expect(logged).not.toContain("swapping");
  });

  it("sends nothing to a chat already on the new line, one not on Sendblue, or a phone with no chat", async () => {
    for (const [chatId, outcome] of [[NEW_CHAT, "on_new_line"], [`whapi:+15555550199:${PHONE}`, "not_old_line"]] as const) {
      const { deps, sent } = world();
      expect(await movePerson(await remembering(chatId), body, deps)).toBe(outcome);
      expect(sent).toEqual([]);
    }
    const { deps, sent } = world();
    expect(await movePerson(new MemoryStorage(), body, deps)).toBe("no_chat");
    expect(sent).toEqual([]);
  });

  it("fails honestly when the gateway, the node or the line fails, and a failed send can be asked again", async () => {
    expect(await movePerson(await remembering(OLD_CHAT), body, world({ noTexts: true }).deps)).toBe("no_gateway");
    expect(await movePerson(await remembering(OLD_CHAT), body, world({ gateway: () => new Response(null, { status: 422 }) }).deps)).toBe("node_failed");
    expect(await movePerson(await remembering(OLD_CHAT), body, world({ gateway: () => Response.json({ to: "skip" }) }).deps)).toBe("no_number");
    const storage = await remembering(OLD_CHAT);
    const steps = async () => (await unwritten(storage)).filter((event) => event.kind === "step");
    expect(await movePerson(storage, body, world({ sendFails: true }).deps)).toBe("send_failed");
    expect(await storage.get(MOVE_TOLD_KEY)).toBeUndefined();
    expect((await steps())[0]).toMatchObject({ step: { name: "moveChat", ok: false, cause: "send_failed" } });
    expect(await movePerson(storage, body, world().deps)).toBe("told");
  });
});

describe("noteMoved", () => {
  const calls: unknown[] = [];
  const fetch = (async (_url: string, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)));
    return Response.json({ outcome: "noted" });
  }) as unknown as Fetch;
  const deps = { fetch, controlPlaneOrigin: "https://cp.example", workerSecret: "s" };

  it("reports a told person's first text on the new line once, and nothing for the old line or someone never told", async () => {
    calls.length = 0;
    const storage = await remembering(NEW_CHAT);
    await noteMoved(storage, PHONE, NEW_CHAT, deps);
    expect(calls).toEqual([]);
    await storage.put(MOVE_TOLD_KEY, { askedAt: 42, at: NOW });
    await noteMoved(storage, PHONE, OLD_CHAT, deps);
    expect(calls).toEqual([]);
    await noteMoved(storage, PHONE, NEW_CHAT, deps);
    await noteMoved(storage, PHONE, NEW_CHAT, deps);
    expect(calls).toEqual([{ kind: "person", key: PHONE, status: "moved" }]);
  });
});

describe("runDueMoves", () => {
  it("runs each move asked for and reports how it went", async () => {
    const reports: unknown[] = [];
    const logs: Record<string, unknown>[] = [];
    const moved: [string, unknown][] = [];
    const fetch = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/agent-texts/moves")) return Response.json({ number: NUMBER, archiveOn: null, moves: [{ kind: "person", key: PHONE, askedAt: 7 }, { kind: "group", key: "a".repeat(64), askedAt: 8 }, { kind: "person", key: "nope", askedAt: 9 }] });
      reports.push(JSON.parse(String(init?.body)));
      return Response.json({ outcome: "noted" });
    }) as unknown as Fetch;
    await runDueMoves({
      fetch,
      controlPlaneOrigin: "https://cp.example",
      workerSecret: "s",
      movePerson: async (phone, asked): Promise<MoveOutcome> => {
        moved.push([phone, asked]);
        return "told";
      },
      log: (entry) => logs.push(entry),
    });
    expect(moved).toEqual([[PHONE, { askedAt: 7, number: NUMBER, archiveOn: null }]]);
    expect(reports).toEqual([
      { kind: "person", key: PHONE, askedAt: 7, status: "told" },
      { kind: "group", key: "a".repeat(64), askedAt: 8, status: "failed", detail: "group_soon" },
    ]);
    expect(JSON.stringify(logs)).not.toContain(PHONE);
  });

  it("logs an unreachable control plane and texts nobody", async () => {
    const logs: Record<string, unknown>[] = [];
    let moved = 0;
    await runDueMoves({
      fetch: (async () => new Response(null, { status: 500 })) as unknown as Fetch,
      controlPlaneOrigin: "https://cp.example",
      workerSecret: "s",
      movePerson: async () => {
        moved++;
        return "told";
      },
      log: (entry) => logs.push(entry),
    });
    expect(moved).toBe(0);
    expect(logs).toEqual([{ event: "chat_move", outcome: "unreachable" }]);
  });

  it("reads the control plane strictly and maps each outcome to what the console shows", () => {
    expect(parseDueMoves({ moves: "x", number: "123" })).toEqual({ moves: [], number: null, archiveOn: null });
    expect(reportOf("on_new_line")).toEqual({ status: "moved", detail: "on_new_line" });
    expect(reportOf("already_told")).toEqual({ status: "told", detail: "already_told" });
    expect(reportOf("send_failed")).toEqual({ status: "failed", detail: "send_failed" });
  });
});
