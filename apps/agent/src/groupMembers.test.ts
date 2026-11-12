/**
 * Who is in a group before an answer goes out (`groupMembers.ts`,
 * `docs/decisions/texting-assistant/group-members.md`). The Crystal Care WhatsApp group, 2026-11-11: a finished
 * answer was held as "Something broke on my side" because both reads of the member list after the turn failed.
 */

import { describe, expect, it } from "vitest";
import { acceptGroup, drainGroup } from "./groupInbox";
import { MemoryStorage } from "./memoryStorage.testing";
import { ADA, BO, CY, LINES, chatLog, setup } from "./groupWorld.testing";
import { KEPT_FRESH_MS, membersBeforeSend, membersChanged, readMembersNow } from "./groupMembers";
import type { GroupLine } from "./groupLine";

const [IMESSAGE, WHATSAPP] = LINES;
const FAILED = "Something broke on my side and I couldn't answer that. Ask me again in a few minutes.";

describe("the member list before an answer goes out", () => {
  it("on WhatsApp, a turn's own list stands when the app's reads fail and nobody changed (Crystal Care, 2026-11-11)", async () => {
    const storage = new MemoryStorage();
    const w = setup(WHATSAPP.groupId, { members: [[ADA, BO], null] });
    await acceptGroup(storage, w.message("Tex how many active staff do we have?"), 0);
    await drainGroup(storage, w.deps);
    expect(w.texts).toEqual(["answer to Tex how many active staff do we have?"]);
    const outs = (await chatLog(storage, w, WHATSAPP.groupId)).filter((event) => event.from.kind !== "person");
    expect(outs.some((event) => event.reason === "held_newcomer")).toBe(false);
  });

  it("on iMessage, which reports no changes, the app is still read before sending, and an unread list still holds", async () => {
    const storage = new MemoryStorage();
    const w = setup(IMESSAGE.groupId, { members: [[ADA, BO], null] });
    await acceptGroup(storage, w.message("Tex how many active staff do we have?"), 0);
    await drainGroup(storage, w.deps);
    expect(w.texts).toEqual([FAILED]);
  });

  it("on WhatsApp, a change Whapi reports during the turn reads the app again, and a newcomer holds the answer", async () => {
    const storage = new MemoryStorage();
    const w = setup(WHATSAPP.groupId, { members: [[ADA, BO], [ADA, BO, CY]] });
    const fetch = w.deps.fetch;
    w.deps.fetch = (async (url: string, init?: RequestInit) => {
      if (new URL(url).pathname === "/agent") await membersChanged(storage, w.deps.now());
      return await fetch(url, init);
    }) as typeof fetch;
    await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
    await drainGroup(storage, w.deps);
    expect(w.texts).toEqual(["Someone joined while I was working on that, so I didn't send it. Ask me again."]);
  });

  it("on WhatsApp, a change Whapi reports whose read then fails twice holds the answer, as before", async () => {
    const storage = new MemoryStorage();
    const w = setup(WHATSAPP.groupId, { members: [[ADA, BO], null] });
    const fetch = w.deps.fetch;
    w.deps.fetch = (async (url: string, init?: RequestInit) => {
      if (new URL(url).pathname === "/agent") await membersChanged(storage, w.deps.now());
      return await fetch(url, init);
    }) as typeof fetch;
    await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
    await drainGroup(storage, w.deps);
    expect(w.texts).toEqual([FAILED]);
  });
});

/** A WhatsApp-like line whose reads answer `reads` in turn (the last repeated), counting them. */
function line(reads: (string[] | null)[], events = true): GroupLine & { count: number } {
  const app = {
    count: 0,
    ...(events ? { membershipEvents: true as const } : {}),
    readMembers: async () => reads[Math.min(app.count++, reads.length - 1)],
  };
  return app as unknown as GroupLine & { count: number };
}

const PLACE = { line: "+15555550199", groupId: "whapi:120363012345678901@g.us" };

describe("the kept list", () => {
  it("is used, without reading the app, only while fresh and unchanged", async () => {
    const storage = new MemoryStorage();
    const app = line([[ADA, BO], null]);
    let now = 10_000;
    expect(await readMembersNow(storage, app, PLACE, () => now)).toEqual([ADA, BO]);
    now += KEPT_FRESH_MS;
    expect(await membersBeforeSend(storage, app, PLACE, () => now)).toEqual([ADA, BO]);
    expect(app.count).toBe(1);
    // Past the window the app is read, and an unread list holds.
    now += 1;
    expect(await membersBeforeSend(storage, app, PLACE, () => now)).toBeNull();
    expect(app.count).toBe(3);
  });

  it("keeps a change reported while the read was out marked, and a read after the change clears it", async () => {
    const storage = new MemoryStorage();
    let now = 10_000;
    const slow = line([[ADA, BO]]);
    await readMembersNow(storage, slow, PLACE, () => now);
    // A change lands while a second read is out: the read started before it, so it does not cover it.
    const racing = {
      membershipEvents: true as const,
      readMembers: async () => {
        await membersChanged(storage, now + 5);
        now += 10;
        return [ADA, BO];
      },
    } as unknown as GroupLine;
    await readMembersNow(storage, racing, PLACE, () => now);
    const after = line([[ADA, BO, CY]]);
    expect(await membersBeforeSend(storage, after, PLACE, () => now)).toEqual([ADA, BO, CY]);
    expect(after.count).toBe(1);
    // That read started after the change: the next check needs no read.
    expect(await membersBeforeSend(storage, after, PLACE, () => now)).toEqual([ADA, BO, CY]);
    expect(after.count).toBe(1);
  });

  it("is never kept for an app that reports no changes, and a change for a group with nothing kept writes nothing", async () => {
    const storage = new MemoryStorage();
    expect(await membersChanged(storage, 1)).toBe(false);
    expect(await storage.get("gmembers")).toBeUndefined();
    const app = line([[ADA, BO]], false);
    await readMembersNow(storage, app, PLACE, () => 1);
    expect(await storage.get("gmembers")).toBeUndefined();
    await membersBeforeSend(storage, app, PLACE, () => 2);
    expect(app.count).toBe(2);
  });
});
