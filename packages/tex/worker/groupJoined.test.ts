import { describe, expect, it } from "vitest";
import { acceptGroup, drainGroup, type GroupDeps } from "./groupInbox";
import { setChatBound } from "./groupChat";
import type { GroupMessage } from "./sendblueGroups";
import { acceptJoined, INTRO_KEY, JOINED_PATH, joinedOf, joinedWired, type Joined } from "./groupJoined";
import type { Fetch } from "./clients";
import { MemoryStorage } from "./memoryStorage.testing";
import { photonGroupChange } from "./photonInbound";
import { TEX_CONFIG } from "../../../packages/tex/src/texConfig.cjs";

/*
 * Tex says hello when it is added to a group (Dev2, 2026-11-25: "Tex should have an intro when added to a group").
 *
 * Sabotage record (2026-11-25), each fails a test here:
 *  - `acceptJoined` without the `joinedWired` check: "a config with node `joined` off queues nothing";
 *  - `acceptJoined` without the `INTRO_KEY` check: "a group hears its hello once";
 *  - `photonGroupChange` marking every `participantAdded` as Tex's: "only Tex's own number added is a join".
 * Sabotage record (2026-11-26):
 *  - `acceptGroup` without its `bindAtJoin` call: "a link shared right after Tex is added is kept";
 *  - `bindAtJoin` without its JOIN_BOUND_KEY check: "a chat a turn unbound is not bound again by its next line";
 *  - `answerGroup` without the hello's unbind: "added by someone not on Context, the chat keeps nothing after its hello".
 */

const LINE = "+15555550199";
const ADA = "+15555550101";
const BO = "+15555550102";
const GROUP = "11111111-2222-3333-4444-555555555555";
const JOINED: Joined = { groupId: GROUP, line: LINE, by: ADA, participants: [LINE, ADA, BO] };

/** Main's config, node `joined` wired (since 2026-11-25), and the same with it off, as a Lab draft may have it. */
const WIRED = TEX_CONFIG;
const OFF = { ...TEX_CONFIG, nodes: TEX_CONFIG.nodes.map((node) => (node.id === "joined" ? { ...node, on: false } : node)) };

type World = { sends: Record<string, unknown>[]; control: Record<string, unknown>[]; asks: Record<string, unknown>[] };

function deps(world: World, status = "ready"): GroupDeps {
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.startsWith("/api/v2/groups/")) return Response.json({ data: { group_id: GROUP, participants: [ADA, BO].map((number) => ({ number })) } });
    const body = JSON.parse(String(init.body));
    if (path === "/api/send-group-message") {
      world.sends.push(body);
      return Response.json({ message_handle: `h_out_${world.sends.length}` });
    }
    if (path === "/agent-texts/group") {
      world.control.push(body);
      return Response.json({ status, slug: "crystal-care", intro: true, bound: true, timeZone: "UTC", handle: "ada", minted: true, accessToken: "cat_group" });
    }
    if (path === "/agent") {
      world.asks.push(body);
      return Response.json({ answer: "Hey all, I'm Tex." });
    }
    throw new Error(`unexpected ${path}`);
  }) as unknown as Fetch;
  return { fetch: fetcher, controlPlaneOrigin: "https://control.example.test", workerSecret: "secret", gatewayOrigin: "https://gateway.example.test", sendblue: { keyId: "id", secret: "key" }, now: () => 1_000 };
}

describe("Tex's hello when it is added to a group", () => {
  it("a config with node `joined` off queues nothing; main's has it on", async () => {
    expect(joinedWired()).toBe(true);
    expect(joinedWired(OFF)).toBe(false);
    const storage = new MemoryStorage();
    expect(await acceptJoined(storage, JOINED, 1_000, OFF)).toBe("off");
    expect(await storage.get(INTRO_KEY)).toBeUndefined();
  });

  it("wired, the hello is one turn of the chat's own, asked by whoever added Tex, its event named, and said once", async () => {
    const w: World = { sends: [], control: [], asks: [] };
    const storage = new MemoryStorage();
    expect(await acceptJoined(storage, JOINED, 1_000, WIRED)).toBe("queued");
    expect(await acceptJoined(storage, JOINED, 1_100, WIRED)).toBe("already");
    await drainGroup(storage, deps(w));
    expect(w.control).toHaveLength(1);
    expect(w.control[0]).toMatchObject({ sender: ADA, routine: true });
    expect(w.asks).toHaveLength(1);
    expect(w.asks[0]).toMatchObject({ event: "joined", group: { cause: "joined" } });
    // Its own words only: the routine's intro line is never added after it.
    expect(w.sends.map((send) => send.content)).toEqual(["Hey all, I'm Tex."]);
    expect(await acceptJoined(storage, JOINED, 2_000, WIRED)).toBe("already");
  });

  it("an event names a group, Tex's line and someone else who added it, or is refused", () => {
    expect(joinedOf(JOINED)).toEqual(JOINED);
    expect(joinedOf({ ...JOINED, by: LINE })).toBeNull();
    expect(joinedOf({ ...JOINED, by: "ada" })).toBeNull();
    expect(joinedOf({ ...JOINED, groupId: "" })).toBeNull();
    expect(joinedOf(null)).toBeNull();
    expect(JOINED_PATH).toBe("(joined)");
  });

  it("only Tex's own number added is a join, and only by someone", () => {
    const changed = (address: string, from?: string, change = "participantAdded") => ({ type: "group.changed", eventId: "photon:group.changed:g:1", seq: 1, line: LINE, chat: { guid: `any;+;${GROUP}`, kind: "group" }, ...(from ? { from } : {}), fromMe: false, at: "2026-11-25T05:00:00Z", group: { change, address } });
    expect(photonGroupChange(changed(LINE, ADA))).toMatchObject({ change: "members", texAdded: true, from: ADA });
    expect(photonGroupChange(changed(BO, ADA))).not.toHaveProperty("texAdded");
    expect(photonGroupChange(changed(LINE))).not.toHaveProperty("texAdded");
    expect(photonGroupChange(changed(LINE, ADA, "participantRemoved"))).not.toHaveProperty("texAdded");
  });
});

/** A line of the chat, from Ada, with its people, as the line's webhook brings one. */
function line(text: string, eventId: string, extra: Partial<GroupMessage> = {}): GroupMessage {
  return { kind: "group-message", eventId, groupId: GROUP, line: LINE, from: ADA, participants: [LINE, ADA, BO], messageId: eventId, text, ...extra } as GroupMessage;
}

describe("a group Tex was added to keeps what is said from then on", () => {
  // Dev2, 2026-11-26: "Tex should be able to read from the point when it gets added". The link shared right before
  // "Tex, summarize the action items for them" was dropped unread, and Tex guessed another meeting.
  const LINK = "https://context.lc/note/@ada/inbox/meetings/standup.md";

  it("a link shared right after Tex is added is kept, not judged alone and dropped", async () => {
    const storage = new MemoryStorage();
    expect(await acceptJoined(storage, JOINED, 1_000, WIRED)).toBe("queued");
    expect(await acceptGroup(storage, line(LINK, "e1"), 1_100)).toBe("kept");
  });

  it("a chat Tex was never added to still keeps nothing untagged", async () => {
    const storage = new MemoryStorage();
    expect(await acceptGroup(storage, line("lunch at noon?", "e1"), 1_100)).toBe("ignored");
  });

  it("an SMS never binds a chat, even right after the hello", async () => {
    const storage = new MemoryStorage();
    await acceptJoined(storage, JOINED, 1_000, WIRED);
    expect(await acceptGroup(storage, line("lunch at noon?", "e1", { sms: true }), 1_100)).toBe("ignored");
  });

  it("a chat a turn unbound is not bound again by its next line", async () => {
    const storage = new MemoryStorage();
    await acceptJoined(storage, JOINED, 1_000, WIRED);
    expect(await acceptGroup(storage, line("lunch at noon?", "e1"), 1_100)).toBe("kept");
    await setChatBound(storage, null); // a turn found nobody there shares a workspace
    expect(await acceptGroup(storage, line("still on?", "e2"), 1_200)).toBe("ignored");
  });

  it("a muted chat stays muted", async () => {
    const storage = new MemoryStorage();
    await acceptJoined(storage, JOINED, 1_000, WIRED);
    await setChatBound(storage, null, true);
    expect(await acceptGroup(storage, line("lunch at noon?", "e1"), 1_100)).toBe("ignored");
  });

  it("added by someone not on Context, the chat keeps nothing after its hello", async () => {
    const w: World = { sends: [], control: [], asks: [] };
    const storage = new MemoryStorage();
    await acceptJoined(storage, JOINED, 1_000, WIRED);
    expect(await acceptGroup(storage, line("lunch at noon?", "e1"), 1_100)).toBe("kept");
    await drainGroup(storage, deps(w, "unknown_sender"));
    expect(w.asks).toHaveLength(0);
    expect(await acceptGroup(storage, line("still on?", "e2"), 1_200)).toBe("ignored");
  });
});
