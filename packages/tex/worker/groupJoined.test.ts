import { describe, expect, it } from "vitest";
import { drainGroup, type GroupDeps } from "./groupInbox";
import { acceptJoined, INTRO_KEY, JOINED_PATH, joinedOf, joinedWired, type Joined } from "./groupJoined";
import type { Fetch } from "./clients";
import { MemoryStorage } from "./memoryStorage.testing";
import { photonGroupChange } from "./photonInbound";
import { TEX_CONFIG } from "../../../packages/tex/src/texConfig.cjs";

/*
 * Tex says hello when it is added to a group (Dev2, 2026-11-25: "Tex should have an intro when added to a group").
 *
 * Sabotage record (2026-11-25), each fails a test here:
 *  - `acceptJoined` without the `joinedWired` check: "main's config queues nothing";
 *  - `acceptJoined` without the `INTRO_KEY` check: "a group hears its hello once";
 *  - `photonGroupChange` marking every `participantAdded` as Tex's: "only Tex's own number added is a join".
 */

const LINE = "+15555550199";
const ADA = "+15555550101";
const BO = "+15555550102";
const GROUP = "11111111-2222-3333-4444-555555555555";
const JOINED: Joined = { groupId: GROUP, line: LINE, by: ADA, participants: [LINE, ADA, BO] };

/** Main's config with node `joined` wired, as a Lab draft would have it. */
const WIRED = {
  ...TEX_CONFIG,
  nodes: [...TEX_CONFIG.nodes, { id: "joined", label: "Tex added", kind: "input", model: "code", on: true }],
  edges: [...TEX_CONFIG.edges, { from: "joined", to: "lanes", mode: "wait", when: ["intro"] }],
};

type World = { sends: Record<string, unknown>[]; control: Record<string, unknown>[]; asks: Record<string, unknown>[] };

function deps(world: World): GroupDeps {
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
      return Response.json({ status: "ready", slug: "crystal-care", intro: true, bound: true, timeZone: "UTC", handle: "ada", minted: true, accessToken: "cat_group" });
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
  it("main's config queues nothing: the node is on the shelf until a Lab draft wires it", async () => {
    expect(joinedWired()).toBe(false);
    const storage = new MemoryStorage();
    expect(await acceptJoined(storage, JOINED, 1_000)).toBe("off");
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
