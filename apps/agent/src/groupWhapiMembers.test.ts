import { describe, expect, it } from "vitest";
import { acceptGroup, drainGroup, type GroupDeps } from "./groupInbox";
import type { GroupMessage } from "./sendblueGroups";
import { MemoryStorage } from "./memoryStorage.testing";
import type { Fetch } from "./clients";
import { fakeJudge, setup } from "./groupWorld.testing";
import { membersChanged } from "./groupMembers";

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
    if (path === "/agent-texts/decide") return Response.json(fakeJudge(JSON.parse(String(init.body))));
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

/**
 * Everyone's words reach Tex, not only the last tagger's. WhatsApp names only the sender, so until 2026-11-12 the
 * chat was bound to the hash of whoever last tagged Tex and every other member's untagged line was dropped as
 * "said in front of other people", and Tex told the next asker it couldn't see a line everyone else had read. A WhatsApp message now carries the group's kept member list (`groupMembers.ts`).
 */
describe("a WhatsApp group's untagged lines", () => {
  const GROUP_ID = `whapi:${JID}`;
  const CY = "+15555550103";
  const said = (w: ReturnType<typeof setup>, from: string, text: string) => w.message(text, { from, participants: [from] });

  it("keeps another member's line and hands it to the next tag", async () => {
    const storage = new MemoryStorage();
    const w = setup(GROUP_ID, { decide: fakeJudge, members: [[ADA, BO, LINE]] });
    await acceptGroup(storage, said(w, ADA, "Tex, when is the party?"), 1);
    await drainGroup(storage, w.deps);
    expect(w.asks).toHaveLength(1);

    expect(await acceptGroup(storage, said(w, BO, "The poster should say Saturday, not Sunday"), 2)).toBe("kept");
    await drainGroup(storage, w.deps); // the judge leaves it as chat
    expect(w.asks).toHaveLength(1);
    await acceptGroup(storage, said(w, ADA, "Tex, draft an email asking for this fix"), 3);
    await drainGroup(storage, w.deps);
    expect(w.asks).toHaveLength(2);
    expect(JSON.stringify(w.asks.at(-1))).toContain("say Saturday, not Sunday");
  });

  it("drops a line before any member list was read, as it always did: nothing says who is here", async () => {
    const storage = new MemoryStorage();
    const w = setup(GROUP_ID, { decide: fakeJudge, members: [[ADA, BO, LINE]] });
    expect(await acceptGroup(storage, said(w, BO, "Saturday, not Sunday"), 1)).toBe("ignored");
  });

  it("drops a newcomer's line the kept list does not name, and a line after the app said the people changed", async () => {
    const storage = new MemoryStorage();
    const w = setup(GROUP_ID, { decide: fakeJudge, members: [[ADA, BO, LINE]] });
    await acceptGroup(storage, said(w, ADA, "Tex, hi"), 1);
    await drainGroup(storage, w.deps);
    expect(await acceptGroup(storage, said(w, CY, "who are you all"), 2)).toBe("ignored");
    await membersChanged(storage, 2_000); // after the read, which the world clocks at 1,000
    expect(await acceptGroup(storage, said(w, BO, "Saturday, not Sunday"), 4)).toBe("ignored");
  });

  it("never hands a turn lines said before someone joined, even when the join event was missed", async () => {
    const storage = new MemoryStorage();
    // The second read (the next tag's) finds Cy, whose join Whapi never reported.
    const w = setup(GROUP_ID, { decide: fakeJudge, members: [[ADA, BO, LINE], [ADA, BO, LINE], [ADA, BO, CY, LINE]] });
    await acceptGroup(storage, said(w, ADA, "Tex, hi"), 1);
    await drainGroup(storage, w.deps);
    expect(await acceptGroup(storage, said(w, BO, "the secret plan for Cy's party"), 2)).toBe("kept");
    await acceptGroup(storage, said(w, ADA, "Tex, what did Bo say?"), 3);
    await drainGroup(storage, w.deps);
    expect(w.asks.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(w.asks.at(-1))).not.toContain("secret plan");
  });
});
