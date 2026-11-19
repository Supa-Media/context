// The chat object skips the old-number step for an in-app chat, as it does for the simulator (`oldLineStep.ts`):
// the old number is a phone's, so an app chat never asks the gateway's old-line node.
import { describe, expect, it, vi } from "vitest";
import { SenderInbox } from "./chatObject";
import { MemoryStorage } from "./memoryStorage.testing";
import type { Env } from "./env";

const USER = "k7m2q9x4b8n3c6v1";

/** A chat object over an in-memory store, with the gateway's old-line node recorded and answered "pass". */
function object() {
  const asked: string[] = [];
  const texts = {
    fetch: async (input: string | URL) => {
      asked.push(String(input));
      return Response.json({ to: "pass" });
    },
  };
  const state = {
    storage: new MemoryStorage(),
    blockConcurrencyWhile: async <T>(run: () => Promise<T>) => run(),
    waitUntil: () => undefined,
  };
  const env = { GATEWAY_TEXTS: texts, FETCH: async () => new Response(null, { status: 200 }) } as unknown as Env;
  const inbox = new SenderInbox(state as unknown as DurableObjectState, env);
  return { inbox, asked };
}

function message(chatId: string, from: string) {
  return { kind: "message", eventId: "evt_1", chatId, from, messageId: "msg_1", text: "what's on my list?" };
}

describe("the chat object's old-line step", () => {
  it("is skipped for an in-app chat: the gateway's old-line node is never asked", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { inbox, asked } = object();
    const response = await inbox.fetch(new Request("https://inbox/", { method: "POST", body: JSON.stringify(message(`app:${USER}`, `app:${USER}`)) }));
    expect(response.status).toBe(200);
    expect(asked.filter((url) => url.includes("old-line"))).toEqual([]);
  });

  it("still runs for a phone's chat", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { inbox, asked } = object();
    const phone = "+15555550100";
    await inbox.fetch(new Request("https://inbox/", { method: "POST", body: JSON.stringify(message(`sendblue:+15555550199:${phone}`, phone)) }));
    expect(asked.filter((url) => url.includes("old-line"))).toHaveLength(1);
  });
});
