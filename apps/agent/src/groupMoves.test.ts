import { beforeEach, describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import { unwritten } from "./events";
import { groupLineFor } from "./groupLine";
import { MemoryStorage } from "./memoryStorage.testing";
import { photonGroupId } from "./photon";
import {
  GROUP_MOVE_TOLD_KEY,
  arrivedAs,
  asOldGroup,
  clearGroupMoveCache,
  groupMovedTo,
  moveGroup,
  peopleOf,
  removeOldNumber,
  serveGroupMoves,
} from "./groupMoves";

const OLD_LINE = "+15555550199";
const NEW_LINE = "+15555550142";
const ADA = "+15555550100";
const BO = "+15555550101";
const GROUP_ID = "sb-group-1";
const GROUP_KEY = "a".repeat(64);
const PHOTON_GROUP = photonGroupId("any;+;chat-123");
const NOTE = "Hey all, swapping numbers here: same Tex, different phone number.";
const NOW = 1_800_000_000_000;

/** A namespace whose every object is the `group-moves` object, kept in one storage. */
function movesObject() {
  const storage = new MemoryStorage();
  const calls: string[] = [];
  const ns = {
    idFromName: (name: string) => ({ name }),
    get: () => ({
      fetch: async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        calls.push(path);
        return await serveGroupMoves(storage, path, JSON.parse(String(init?.body ?? "{}")), NOW);
      },
    }),
  } as unknown as DurableObjectNamespace;
  return { ns, storage, calls };
}

beforeEach(() => clearGroupMoveCache());

describe("the group-moves object", () => {
  it("ties the new line's group to the old one when it hears the old number's note among the same people", async () => {
    const { storage } = movesObject();
    const body = (b: unknown) => b as Record<string, unknown>;
    await serveGroupMoves(storage, "/group-move/pending", body({ line: OLD_LINE, groupId: GROUP_ID, groupKey: GROUP_KEY, people: [BO, ADA], askedAt: 7 }), NOW);
    // Someone else's group, or the same people heard from another number, ties nothing.
    expect(await (await serveGroupMoves(storage, "/group-move/arrive", body({ photonGroupId: PHOTON_GROUP, photonLine: NEW_LINE, from: OLD_LINE, participants: [OLD_LINE, NEW_LINE, ADA] }), NOW)).json()).toEqual({});
    expect(await (await serveGroupMoves(storage, "/group-move/arrive", body({ photonGroupId: PHOTON_GROUP, photonLine: NEW_LINE, from: ADA, participants: [OLD_LINE, NEW_LINE, ADA, BO] }), NOW)).json()).toEqual({});
    const tied = await (await serveGroupMoves(storage, "/group-move/arrive", body({ photonGroupId: PHOTON_GROUP, photonLine: NEW_LINE, from: OLD_LINE, participants: [ADA, OLD_LINE, BO, NEW_LINE] }), NOW)).json();
    expect(tied).toEqual({ from: { line: OLD_LINE, groupId: GROUP_ID }, matched: { groupKey: GROUP_KEY, line: OLD_LINE, groupId: GROUP_ID, askedAt: 7 } });
    // From then on, both ways, and the note is not matched twice.
    expect(await (await serveGroupMoves(storage, "/group-move/to", body({ groupId: GROUP_ID }), NOW)).json()).toEqual({ to: { line: NEW_LINE, groupId: PHOTON_GROUP } });
    expect(await (await serveGroupMoves(storage, "/group-move/arrive", body({ photonGroupId: PHOTON_GROUP, photonLine: NEW_LINE, from: ADA, participants: [] }), NOW)).json()).toEqual({ from: { line: OLD_LINE, groupId: GROUP_ID } });
  });

  it("forgets a note the new line never heard after a day", async () => {
    const { storage } = movesObject();
    await serveGroupMoves(storage, "/group-move/pending", { line: OLD_LINE, groupId: GROUP_ID, groupKey: GROUP_KEY, people: [ADA], askedAt: 7 }, NOW);
    const late = NOW + 24 * 60 * 60 * 1000 + 1;
    expect(await (await serveGroupMoves(storage, "/group-move/arrive", { photonGroupId: PHOTON_GROUP, photonLine: NEW_LINE, from: OLD_LINE, participants: [ADA] }, late)).json()).toEqual({});
  });

  it("refuses a body it cannot read and a path it does not know", async () => {
    const { storage } = movesObject();
    expect((await serveGroupMoves(storage, "/group-move/pending", { line: "nope" }, NOW)).status).toBe(400);
    expect((await serveGroupMoves(storage, "/group-move/arrive", {}, NOW)).status).toBe(400);
    expect((await serveGroupMoves(storage, "/group-move/elsewhere", {}, NOW)).status).toBe(404);
  });

  it("counts people without Tex's lines, once each", () => {
    expect(peopleOf([OLD_LINE, BO, ADA, NEW_LINE, ADA], [OLD_LINE, NEW_LINE])).toEqual([ADA, BO]);
  });
});

describe("a moved group, as the Worker reads and sends it", () => {
  it("files the new line's message as the old group, with the old line standing for the new one", () => {
    const message = { groupId: PHOTON_GROUP, line: NEW_LINE, participants: [NEW_LINE, ADA, BO], from: ADA };
    expect(asOldGroup(message, { line: OLD_LINE, groupId: GROUP_ID })).toEqual({ groupId: GROUP_ID, line: OLD_LINE, participants: [OLD_LINE, ADA, BO], from: ADA });
  });

  it("caches where a moved group lives, and reads an unmoved one again later", async () => {
    const { ns, storage, calls } = movesObject();
    const to = groupMovedTo(ns);
    expect(await to(GROUP_ID)).toBeNull();
    await storage.put(`gm:to:${GROUP_ID}`, { line: NEW_LINE, groupId: PHOTON_GROUP });
    expect(await to(GROUP_ID)).toBeNull(); // still the read from a moment ago
    clearGroupMoveCache();
    expect(await to(GROUP_ID)).toEqual({ line: NEW_LINE, groupId: PHOTON_GROUP });
    const before = calls.length;
    expect(await to(GROUP_ID)).toEqual({ line: NEW_LINE, groupId: PHOTON_GROUP });
    expect(calls.length).toBe(before);
  });

  it("an arrival the object cannot answer leaves the message as it came", async () => {
    const broken = { idFromName: () => ({}), get: () => ({ fetch: async () => new Response(null, { status: 500 }) }) } as unknown as DurableObjectNamespace;
    expect(await arrivedAs(broken, { photonGroupId: PHOTON_GROUP, photonLine: NEW_LINE, from: ADA, participants: [] })).toEqual({ from: null });
  });

  it("sends a moved Sendblue group's text through the new line, and an unmoved one through Sendblue", async () => {
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const photon = {
      fetch: async (url: string, init?: RequestInit) => {
        sent.push({ url, body: JSON.parse(String(init?.body)) });
        return Response.json({ ok: true, guid: "g1" });
      },
    } as unknown as Fetcher;
    const sendblue: string[] = [];
    const fetch = (async (url: string) => {
      sendblue.push(url);
      return Response.json({ message_handle: "h1" });
    }) as unknown as Fetch;
    const moved = groupLineFor({ fetch, photon, sendblue: { keyId: "k", secret: "s" }, movedTo: async (id) => (id === GROUP_ID ? { line: NEW_LINE, groupId: PHOTON_GROUP } : null) }, GROUP_ID);
    await moved.sendText({ line: OLD_LINE, groupId: GROUP_ID }, "hello all");
    expect(sendblue).toEqual([]);
    expect(sent[0].url).toContain("send/text");
    expect(sent[0].body).toMatchObject({ line: NEW_LINE, chat: "any;+;chat-123", text: "hello all" });
    const unmoved = groupLineFor({ fetch, photon, sendblue: { keyId: "k", secret: "s" }, movedTo: async () => null }, "sb-group-2");
    await unmoved.sendText({ line: OLD_LINE, groupId: "sb-group-2" }, "hello all");
    expect(sendblue.some((url) => url.endsWith("/api/send-group-message"))).toBe(true);
  });

  it("reads a moved group's people from the new line, with the old line in its place", async () => {
    const photon = { fetch: async () => Response.json({ ok: true, participants: [NEW_LINE, ADA, BO] }) } as unknown as Fetcher;
    const line = groupLineFor({ fetch: (async () => new Response(null)) as unknown as Fetch, photon, movedTo: async () => ({ line: NEW_LINE, groupId: PHOTON_GROUP }) }, GROUP_ID);
    expect(await line.readMembers({ line: OLD_LINE, groupId: GROUP_ID })).toEqual([OLD_LINE, ADA, BO]);
  });

  it("takes the old number out through the bridge, and says so when it could not", async () => {
    const calls: unknown[] = [];
    const ok = { fetch: async (url: string, init?: RequestInit) => (calls.push([new URL(url).pathname, JSON.parse(String(init?.body))]), Response.json({ ok: true, participants: [] })) } as unknown as Fetcher;
    expect(await removeOldNumber(ok, NEW_LINE, PHOTON_GROUP, OLD_LINE)).toBe(true);
    expect(calls).toEqual([["/group/remove", { line: NEW_LINE, chat: "any;+;chat-123", address: OLD_LINE }]]);
    const refused = { fetch: async () => Response.json({ ok: false, error: "refused" }, { status: 502 }) } as unknown as Fetcher;
    expect(await removeOldNumber(refused, NEW_LINE, PHOTON_GROUP, OLD_LINE)).toBe(false);
    expect(await removeOldNumber(null, NEW_LINE, PHOTON_GROUP, OLD_LINE)).toBe(false);
    expect(await removeOldNumber(ok, NEW_LINE, "sb-group-1", OLD_LINE)).toBe(false);
  });
});

describe("moveGroup, in the old group's own object", () => {
  function world(options: { add?: number; members?: unknown; noteFails?: boolean } = {}) {
    const sendblue: { path: string; body: Record<string, unknown> }[] = [];
    const fetch = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (init?.method === "GET" || init?.method === undefined) {
        if (path.startsWith("/api/v2/groups/")) return options.members === null ? new Response(null, { status: 500 }) : Response.json(options.members ?? { participants: [OLD_LINE, ADA, BO] });
      }
      const body = JSON.parse(String(init?.body ?? "{}"));
      sendblue.push({ path, body });
      if (path === "/api/modify-group") return new Response(null, { status: options.add ?? 200 });
      if (path === "/api/send-group-message") return options.noteFails ? new Response(null, { status: 500 }) : Response.json({ message_handle: "h1" });
      return new Response(null, { status: 404 });
    }) as unknown as Fetch;
    const texts = { fetch: async () => Response.json({ to: "group", text: NOTE }) };
    const moves = movesObject();
    const deps = { fetch, sendblue: { keyId: "k", secret: "s" }, texts, moves: moves.ns, now: () => NOW };
    return { deps, sendblue, moves };
  }
  const body = { askedAt: 7, number: NEW_LINE, archiveOn: null, line: OLD_LINE, groupId: GROUP_ID, groupKey: GROUP_KEY };

  it("adds the new number, notes the move, then posts the swap note from the old number, once per ask", async () => {
    const storage = new MemoryStorage();
    const { deps, sendblue, moves } = world();
    expect(await moveGroup(storage, body, deps)).toBe("told");
    expect(sendblue.map((call) => call.path)).toEqual(["/api/modify-group", "/api/send-group-message"]);
    expect(sendblue[0].body).toEqual({ group_id: GROUP_ID, modify_type: "add_recipient", number: NEW_LINE, from_number: OLD_LINE });
    expect(sendblue[1].body).toMatchObject({ from_number: OLD_LINE, group_id: GROUP_ID, content: NOTE });
    expect(await moves.storage.get(`gm:pending:${OLD_LINE}`)).toEqual([{ groupId: GROUP_ID, groupKey: GROUP_KEY, people: [ADA, BO], askedAt: 7, at: NOW }]);
    expect(await storage.get(GROUP_MOVE_TOLD_KEY)).toBe(7);
    expect(await moveGroup(storage, body, deps)).toBe("already_told");
    expect(sendblue).toHaveLength(2);
  });

  it("logs the step to the group's ledger, never a number or the note's words", async () => {
    const storage = new MemoryStorage();
    await moveGroup(storage, body, world().deps);
    const steps = (await unwritten(storage)).filter((event) => event.kind === "step");
    expect(steps[0]).toMatchObject({ chat: GROUP_ID, step: { name: "moveChat", ok: true, input: { kind: "group", number: true, archiveOn: false }, output: { outcome: "told", textChars: NOTE.length, people: 2 } } });
    expect(JSON.stringify(steps[0].step)).not.toContain("555555");
    expect(JSON.stringify(steps[0].step)).not.toContain("swapping");
  });

  it("stops before the note when Sendblue will not add the new number or say who is in the group", async () => {
    const refused = world({ add: 400 });
    expect(await moveGroup(new MemoryStorage(), body, refused.deps)).toBe("add_failed");
    expect(refused.sendblue.map((call) => call.path)).toEqual(["/api/modify-group"]);
    const unread = world({ members: null });
    expect(await moveGroup(new MemoryStorage(), body, unread.deps)).toBe("members_unread");
    expect(unread.sendblue).toEqual([]);
    expect(await moveGroup(new MemoryStorage(), { ...body, number: null }, world().deps)).toBe("no_number");
  });

  it("a note that did not go can be asked again", async () => {
    const storage = new MemoryStorage();
    expect(await moveGroup(storage, body, world({ noteFails: true }).deps)).toBe("send_failed");
    expect(await storage.get(GROUP_MOVE_TOLD_KEY)).toBeUndefined();
    expect(await moveGroup(storage, body, world().deps)).toBe("told");
  });
});
