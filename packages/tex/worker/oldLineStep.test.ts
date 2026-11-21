import { beforeEach, describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import type { Line } from "./line";
import { unwritten } from "./events";
import { MemoryStorage } from "./memoryStorage.testing";
import { clearOldLineCache } from "./oldLine";
import { OLD_LINE_TOLD_KEY, oldLineStep } from "./oldLineStep";

const CHAT = "sendblue:+15555550199:+15555550100";
const NUMBER = "+15555550142";
const NOW = 1_800_000_000_000;

type Sent = { chatId: string; text: string; key: string };

/** The control plane answering the setting, the gateway answering the node, and a line that records what it sends. */
function world(options: { mode?: "off" | "redirect"; gateway?: (input: Record<string, unknown>) => Response | Promise<Response>; sendFails?: boolean } = {}) {
  const sent: Sent[] = [];
  const asked: Record<string, unknown>[] = [];
  const fetch = (async () => Response.json({ mode: options.mode ?? "redirect", number: NUMBER, archiveOn: "2026-12-01" })) as unknown as Fetch;
  const texts = {
    fetch: async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://gateway/texts/old-line");
      const input = JSON.parse(String(init?.body)) as Record<string, unknown>;
      asked.push(input);
      return options.gateway ? options.gateway(input) : Response.json({ to: "redirect", answer: "I've moved." });
    },
  };
  const line = {
    sendText: async (chatId: string, text: string, key: string) => {
      if (options.sendFails) throw new Error("line down");
      sent.push({ chatId, text, key });
    },
  } as unknown as Line;
  const deps = { fetch, controlPlaneOrigin: "https://cp.example", workerSecret: "s", now: () => NOW, linqApiKey: "", texts, remoteLine: () => line };
  return { deps, sent, asked };
}

beforeEach(() => clearOldLineCache());

describe("oldLineStep", () => {
  it("hands the node the setting and the chat, sends the reply on the chat's line, and notes when", async () => {
    const storage = new MemoryStorage();
    const { deps, sent, asked } = world();
    expect(await oldLineStep(storage, CHAT, deps)).toBe("redirected");
    expect(asked).toEqual([{ chatId: CHAT, mode: "redirect", number: NUMBER, archiveOn: "2026-12-01", now: NOW }]);
    expect(sent).toEqual([{ chatId: CHAT, text: "I've moved.", key: `old-line:${CHAT}:${Math.floor(NOW / 86_400_000)}` }]);
    expect(await storage.get(OLD_LINE_TOLD_KEY)).toBe(NOW);
  });

  it("logs the step to the chat's ledger with what it saw and chose, never the number or the reply's words", async () => {
    const storage = new MemoryStorage();
    const { deps } = world();
    await oldLineStep(storage, CHAT, deps);
    const steps = (await unwritten(storage)).filter((event) => event.kind === "step");
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ chat: CHAT, step: { name: "oldLine", ok: true, input: { mode: "redirect", number: true, archiveOn: true }, output: { to: "redirect", answerChars: 11 } } });
    expect(JSON.stringify(steps[0].step)).not.toContain(NUMBER);
    expect(JSON.stringify(steps[0].step)).not.toContain("moved");
  });

  it("passes the last time this chat was told, and holds the text with no reply when the node says hold", async () => {
    const storage = new MemoryStorage();
    await storage.put(OLD_LINE_TOLD_KEY, NOW - 1000);
    const { deps, sent, asked } = world({ gateway: () => Response.json({ to: "hold" }) });
    expect(await oldLineStep(storage, CHAT, deps)).toBe("held");
    expect(asked[0]).toMatchObject({ lastToldAt: NOW - 1000 });
    expect(sent).toEqual([]);
  });

  it("passes a text on Tex's new line at once, with no setting read and no gateway call, and logs why", async () => {
    // An iMessage text on Photon's line paid a control-plane read and a gateway round trip (up to 0.9 s) for a node
    // that can only pass it (2026-11-21).
    let reads = 0;
    const storage = new MemoryStorage();
    const { deps, sent, asked } = world();
    const counted = { ...deps, fetch: (async (...args: Parameters<Fetch>) => (reads++, deps.fetch(...args))) as unknown as Fetch };
    for (const chat of ["photon:+15555550199:+15555550100", "whapi:+15555550100"]) expect(await oldLineStep(storage, chat, counted)).toBe("pass");
    expect(reads).toBe(0);
    expect(asked).toEqual([]);
    expect(sent).toEqual([]);
    const steps = (await unwritten(storage)).filter((event) => event.kind === "step");
    expect(steps[0]).toMatchObject({ step: { name: "oldLine", ok: true, output: { to: "pass", why: "new_line" } } });
  });

  it("passes the text on when the node says pass, the gateway fails, or there is no gateway", async () => {
    for (const gateway of [() => Response.json({ to: "pass" }), () => new Response(null, { status: 422 }), () => Promise.reject(new Error("gone"))]) {
      const storage = new MemoryStorage();
      const { deps, sent } = world({ gateway });
      expect(await oldLineStep(storage, CHAT, deps)).toBe("pass");
      expect(sent).toEqual([]);
      expect(await storage.get(OLD_LINE_TOLD_KEY)).toBeUndefined();
    }
    const { deps } = world();
    expect(await oldLineStep(new MemoryStorage(), CHAT, { ...deps, texts: undefined })).toBe("pass");
  });

  it("passes the text on to Tex, and forgets the note, when the reply could not be sent", async () => {
    const storage = new MemoryStorage();
    const { deps } = world({ sendFails: true });
    expect(await oldLineStep(storage, CHAT, deps)).toBe("pass");
    expect(await storage.get(OLD_LINE_TOLD_KEY)).toBeUndefined();
  });

  it("passes the text on when the setting cannot be read", async () => {
    const { deps, asked } = world();
    const broken = { ...deps, fetch: (async () => new Response("no", { status: 500 })) as unknown as Fetch };
    expect(await oldLineStep(new MemoryStorage(), CHAT, broken)).toBe("pass");
    expect(asked).toEqual([]);
  });
});
