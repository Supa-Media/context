// A repeat tag in a group reuses the chat's token and asks the control plane behind the turn
// (src/groupKept.ts, docs/decisions/texting-assistant/texting-in-objects.md "Group chats too").
import { describe, expect, it } from "vitest";
import { acceptGroup, drainGroup, type GroupDeps } from "./groupInbox";
import type { GroupMessage } from "./sendblueGroups";
import { MemoryStorage } from "./memoryStorage.testing";
import type { Fetch } from "./clients";
import { KEPT_KEY, REUSE_MS } from "./groupKept";

const LINE = "+15555550199";
const ADA = "+15555550101";
const BO = "+15555550102";
const CY = "+15555550103";
const GROUP = "11111111-2222-3333-4444-555555555555";

let n = 0;
const message = (text: string, extra: Partial<GroupMessage> = {}): GroupMessage => {
  n += 1;
  return { kind: "group-message", eventId: `sendblue:k_${n}`, groupId: GROUP, line: LINE, from: ADA, participants: [ADA, BO, LINE], messageId: `h_in_${n}`, text, ...extra };
};

const READY = (token: string, extra: Record<string, unknown> = {}) => ({ status: "ready", slug: "band", intro: false, bound: false, timeZone: "UTC", handle: "ada", minted: true, accessToken: token, ...extra });

type World = { control: Record<string, unknown>[]; tokens: (string | null)[]; members: string[]; now: number; answers: unknown[]; sent: string[] };

function deps(w: World): GroupDeps {
  let handles = 0;
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.startsWith("/api/v2/groups/")) return Response.json({ data: { group_id: GROUP, participants: w.members.map((number) => ({ number })) } });
    const body = JSON.parse(String(init.body));
    if (path === "/api/send-group-message") return w.sent.push(String(body.content)), Response.json({ message_handle: `h_out_${++handles}` });
    if (path === "/api/send-reaction") return Response.json({});
    if (path === "/agent/events") return Response.json({ written: body.events.map((event: { id: string }) => event.id) });
    if (path === "/agent-texts/group") {
      w.control.push(body);
      const next = w.answers.length > 1 ? w.answers.shift() : w.answers[0];
      return Response.json(body.mint === true ? next : { ...(next as object), minted: false, accessToken: undefined });
    }
    if (path === "/agent") {
      w.tokens.push(new Headers(init.headers).get("authorization"));
      return Response.json({ answer: "The opener." });
    }
    throw new Error(`unexpected ${path}`);
  }) as unknown as Fetch;
  return { fetch: fetcher, controlPlaneOrigin: "https://control.example.test", workerSecret: "secret", gatewayOrigin: "https://gateway.example.test", sendblue: { keyId: "id", secret: "key" }, now: () => w.now };
}

const world = (answers: unknown[] = [READY("cat_one")]): World => ({ control: [], tokens: [], members: [ADA, BO], now: 1_000, answers, sent: [] });

async function tag(storage: MemoryStorage, w: World, text: string, extra: Partial<GroupMessage> = {}) {
  await acceptGroup(storage, message(text, extra), w.now);
  await drainGroup(storage, deps(w));
}

describe("a repeat tag in a group", () => {
  it("reuses the token, and the control plane is asked only behind the turn, without minting", async () => {
    const storage = new MemoryStorage();
    const w = world();
    await tag(storage, w, "Tex, what's on the setlist?");
    expect(w.control.map((body) => body.mint)).toEqual([true]);
    w.now += 60_000;
    await tag(storage, w, "Tex, and the encore?");
    expect(w.tokens).toEqual(["Bearer cat_one", "Bearer cat_one"]);
    expect(w.control.map((body) => body.mint)).toEqual([true, undefined]); // the second ask came after the answer, minting nothing
    expect(w.sent.filter((text) => text === "The opener.")).toHaveLength(2);
  });

  it("ATTACK: another sender never gets the kept token: it is the tagger's grant", async () => {
    const storage = new MemoryStorage();
    const w = world([READY("cat_ada"), READY("cat_bo", { handle: "bo" })]);
    await tag(storage, w, "Tex, hi");
    await tag(storage, w, "Tex, hi from me", { from: BO });
    expect(w.tokens).toEqual(["Bearer cat_ada", "Bearer cat_bo"]);
    expect(w.control.map((body) => body.mint)).toEqual([true, true]);
  });

  it("ATTACK: somebody joining the chat asks first: more people only narrow it", async () => {
    const storage = new MemoryStorage();
    const w = world([READY("cat_two"), READY("cat_three")]);
    await tag(storage, w, "Tex, hi");
    w.members = [ADA, BO, CY];
    await tag(storage, w, "Tex, again");
    expect(w.tokens).toEqual(["Bearer cat_two", "Bearer cat_three"]);
    expect(w.control[1]).toMatchObject({ participants: [ADA, BO, CY], mint: true });
  });

  it("an old token is never handed to a new turn", async () => {
    const storage = new MemoryStorage();
    const w = world([READY("cat_old"), READY("cat_new")]);
    await tag(storage, w, "Tex, hi");
    w.now += REUSE_MS;
    await tag(storage, w, "Tex, again");
    expect(w.tokens).toEqual(["Bearer cat_old", "Bearer cat_new"]);
  });

  it("a command always asks, and drops what was kept", async () => {
    const storage = new MemoryStorage();
    const w = world([READY("cat_a"), { status: "stopped" }, READY("cat_b")]);
    await tag(storage, w, "Tex, hi");
    await tag(storage, w, "Tex, stop");
    expect(w.control[1]).toMatchObject({ command: { kind: "stop" } });
    expect(await storage.get(KEPT_KEY)).toBeUndefined();
  });

  it("ATTACK: a chat the control plane stops answering behind a reused turn asks first next time", async () => {
    const storage = new MemoryStorage();
    const w = world([READY("cat_x"), { status: "muted" }]);
    await tag(storage, w, "Tex, hi");
    await tag(storage, w, "Tex, again"); // reused; the ask behind it says muted
    expect(await storage.get(KEPT_KEY)).toBeUndefined();
    await tag(storage, w, "Tex, and again");
    expect(w.control.at(-1)).toMatchObject({ mint: true });
    expect(w.tokens).toEqual(["Bearer cat_x", "Bearer cat_x"]); // muted: no third turn
  });

  it("a reused turn that fails drops the kept token, so the retry asks first", async () => {
    const storage = new MemoryStorage();
    const w = world([READY("cat_r"), READY("cat_s")]);
    await tag(storage, w, "Tex, hi");
    const refusing = deps(w);
    const fetcher = refusing.fetch;
    refusing.fetch = (async (url: string, init: RequestInit) => (new URL(url).pathname === "/agent" ? Response.json({ error: "invalid_token" }, { status: 401 }) : fetcher(url, init))) as unknown as Fetch;
    await acceptGroup(storage, message("Tex, again"), w.now);
    await drainGroup(storage, refusing);
    expect(await storage.get(KEPT_KEY)).toBeUndefined();
  });

  it("the introduction is never given twice from a kept answer", async () => {
    const storage = new MemoryStorage();
    const w = world([READY("cat_i", { intro: true, reach: ["band"] }), READY("cat_i")]);
    await tag(storage, w, "Tex, hi");
    const intros = w.sent.length - 1;
    await tag(storage, w, "Tex, again");
    expect(w.sent.length - 1 - intros).toBe(1 + 0); // one more answer, no second introduction
  });
});
