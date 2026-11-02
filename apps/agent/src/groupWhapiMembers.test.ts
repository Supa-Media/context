import { describe, expect, it } from "vitest";
import { acceptGroup, drainGroup, type GroupDeps } from "./groupInbox";
import type { GroupMessage } from "./sendblueGroups";
import { MemoryStorage } from "./memoryStorage.testing";
import type { Fetch } from "./clients";

/**
 * A WhatsApp group's webhook names only the sender (`whapiInbound.ts`), so a turn whose member list can't be read
 * is retried, never decided as if the sender were alone. The Crystal Care chat, 2026-10-29: Tex was added moments
 * before "Tex use @crystal-care", bound the chat on one person, then refused the family's first question.
 */

const LINE = "+15555550199";
const ADA = "+15555550101";
const BO = "+15555550102";
const JID = "120363012345678901@g.us";

const message = (text: string): GroupMessage => ({
  kind: "group-message",
  eventId: `whapi:${text.length}`,
  groupId: `whapi:${JID}`,
  line: LINE,
  from: ADA,
  participants: [ADA],
  messageId: "wa_in_1",
  text,
});

function deps(reads: (string[] | null)[], control: Record<string, unknown>[]): GroupDeps {
  let read = 0;
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.startsWith("/groups/")) {
      const list = reads[Math.min(read++, reads.length - 1)];
      if (list === null) return new Response("{}", { status: 404 });
      return Response.json({ participants: list.map((phone) => ({ id: `${phone.slice(1)}@s.whatsapp.net` })) });
    }
    if (path.startsWith("/messages")) return Response.json({ sent: true, message: { id: "wa_out_1" } });
    if (path.startsWith("/presences")) return Response.json({});
    if (path === "/agent/events") return Response.json({ written: JSON.parse(String(init.body)).events.map((event: { id: string }) => event.id) });
    if (path === "/agent-texts/group") {
      control.push(JSON.parse(String(init.body)));
      return Response.json({ status: "ready", slug: "crystal-care", intro: false, bound: true, timeZone: "UTC", handle: "ada" });
    }
    throw new Error(`unexpected ${path}`);
  }) as unknown as Fetch;
  return {
    fetch: fetcher,
    controlPlaneOrigin: "https://control.example.test",
    workerSecret: "secret",
    gatewayOrigin: "https://gateway.example.test",
    whapi: { token: "whapi-test-token", line: LINE },
    hostPicture: async (picture) => `https://agent.example.test/media/${picture.name}`,
    now: () => 1_000,
  };
}

describe("a WhatsApp group whose members can't be read", () => {
  it("is retried until the member list reads, then decided on everyone in it", async () => {
    const storage = new MemoryStorage();
    const control: Record<string, unknown>[] = [];
    await acceptGroup(storage, message("Tex use @crystal-care"), 0);
    await drainGroup(storage, deps([null], control));
    expect(control).toEqual([]);
    expect((await storage.list({ prefix: "gpending:" })).size).toBe(1);

    await drainGroup(storage, deps([[ADA, BO, LINE]], control));
    expect(control).toHaveLength(1);
    expect([...(control[0].participants as string[])].sort()).toEqual([ADA, BO].sort());
  });
});
