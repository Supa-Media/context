import { describe, expect, it } from "vitest";
import { withGateway } from "./gatewayOver.testing";
import worker, { type Env } from "./index";
import { acceptGroup, drainGroup, groupInboxName } from "./groupInbox";
import { groupLineFor } from "./groupLine";
import { MemoryStorage } from "./memoryStorage.testing";
import { deps, message, world, ADA, BO, CY } from "./groupInboxWorld.testing";
import { isSimulatedGroup, mintSimGroupId, SIM_GROUP_ID, SIM_GROUP_LINE } from "./simulatedGroup";
import { simulatedGroupInbox } from "./simulatorGroup";
import type { SimEntry } from "./simulatorLog";
import { SIMULATOR_PAGE } from "./simulatorPage";

const SIM = `sim-group-${"ab".repeat(16)}`;
const NOT_SIM_PHONE = "+14155552671"; // not 555-01XX: a real-looking number, refused as a member
const KEY = "ab".repeat(24);
const OTHER_KEY = "cd".repeat(24);
const MEMBERS = [ADA, BO, CY];

const logOf = async (storage: MemoryStorage) => [...(await storage.list<SimEntry>({ prefix: "sim:log:" })).values()];

/** A Worker whose group objects run the real group intake over memory, with the simulator on or off. */
function setup(simulator: string | undefined) {
  const objects = new Map<string, MemoryStorage>();
  const namespace = {
    idFromName: (name: string) => ({ name: name.replace(/^enam:/, "") }),
    get: (id: { name: string }) => ({
      fetch: async (input: string, init: RequestInit) => {
        const storage = objects.get(id.name) ?? new MemoryStorage();
        objects.set(id.name, storage);
        const path = new URL(input).pathname;
        if (!path.startsWith("/sim-group/")) throw new Error(`unexpected ${path}`);
        const body = JSON.parse(String(init.body));
        return simulatedGroupInbox(storage, path.slice("/sim-group/".length), body, 1_000, (m) => acceptGroup(storage, m, 1_000));
      },
    }),
  } as unknown as DurableObjectNamespace;
  const env: Env = { SENDER_INBOX: namespace, LINQ_WEBHOOK_SECRET: "", LINQ_API_KEY: "k", AGENT_WORKER_SECRET: "s", CONTROL_PLANE_ORIGIN: "https://cp.example", GATEWAY_ORIGIN: "https://gw.example", SIMULATOR: simulator };
  withGateway(env);
  return { env, objects };
}

const api = (path: string, init: { method?: string; key?: string; body?: unknown } = {}) =>
  new Request(`https://agent.example/texts-simulator/api${path}`, {
    method: init.method ?? "POST",
    headers: init.key === undefined ? {} : { "x-simulator-key": init.key },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

describe("the simulator's group mode: the group object", () => {
  it("the first key claims a simulated group, and another key is refused", async () => {
    const storage = new MemoryStorage();
    const body = (keyHash: string) => ({ keyHash, groupId: SIM, phone: ADA, members: MEMBERS, text: "Tex, hi" });
    const accept = async () => "queued";
    expect((await simulatedGroupInbox(storage, "thread", body("a"), 1_000, accept)).status).toBe(200);
    expect((await simulatedGroupInbox(storage, "send", body("b"), 1_000, accept)).status).toBe(409);
    expect((await simulatedGroupInbox(storage, "send", body("a"), 1_000, accept)).status).toBe(200);
  });

  it("a send reaches the group queue with channel simulator, from the group's own line", async () => {
    const storage = new MemoryStorage();
    const response = await simulatedGroupInbox(storage, "send", { keyHash: "a", groupId: SIM, phone: ADA, members: MEMBERS, text: "Tex, hi" }, 1_000, (m) => acceptGroup(storage, m, 1_000));
    expect(await response.json()).toEqual({ outcome: "queued" });
    const queued = [...(await storage.list<{ message: Record<string, unknown> }>({ prefix: "gpending:" })).values()];
    expect(queued).toHaveLength(1);
    expect(queued[0].message).toMatchObject({ kind: "group-message", channel: "simulator", groupId: SIM, line: SIM_GROUP_LINE, from: ADA, text: "Tex, hi" });
    expect(await logOf(storage)).toMatchObject([{ dir: "out", text: "Tex, hi", from: ADA }]);
  });
});

describe("the simulator's group mode: the Worker's routes", () => {
  it("does not exist unless the Worker's SIMULATOR var is on", async () => {
    const { env } = setup(undefined);
    expect((await worker.fetch(api("/group/send", { key: KEY, body: { phone: ADA, members: MEMBERS, text: "Tex, hi" } }), env)).status).toBe(404);
  });

  it("refuses a member that is not a 555-01XX number, and a sender who is not among the members", async () => {
    const { env, objects } = setup("on");
    const send = (phone: string, members: string[]) => worker.fetch(api("/group/send", { key: KEY, body: { phone, members, text: "Tex, hi" } }), env);
    expect((await send(ADA, [ADA, NOT_SIM_PHONE])).status).toBe(400);
    expect((await send(ADA, [ADA, BO, "+15555550100x"])).status).toBe(400);
    expect((await send(NOT_SIM_PHONE, [ADA, BO])).status).toBe(400);
    expect((await send(ADA, [BO, CY])).status).toBe(400);
    expect(objects.size).toBe(0);
  });

  it("takes 2 to 8 distinct members", async () => {
    const { env } = setup("on");
    const send = (members: string[]) => worker.fetch(api("/group/send", { key: KEY, body: { phone: ADA, members, text: "Tex, hi" } }), env);
    expect((await send([ADA])).status).toBe(400);
    expect((await send([ADA, ADA])).status).toBe(400);
    expect((await send(Array.from({ length: 9 }, (_, i) => `+1555555010${i}`))).status).toBe(400);
  });

  it("refuses any group id that is not a simulated one, and mints one that is when none is given", async () => {
    const { env, objects } = setup("on");
    const real = "11111111-2222-3333-4444-555555555555";
    expect((await worker.fetch(api("/group/send", { key: KEY, body: { groupId: real, phone: ADA, members: MEMBERS, text: "Tex, hi" } }), env)).status).toBe(400);
    expect((await worker.fetch(api("/group/send", { key: KEY, body: { groupId: "sim-group-xyz", phone: ADA, members: MEMBERS, text: "Tex, hi" } }), env)).status).toBe(400);
    expect((await worker.fetch(api(`/group/thread?group=${real}`, { method: "GET", key: KEY }), env)).status).toBe(400);
    const minted = await worker.fetch(api("/group/send", { key: KEY, body: { phone: ADA, members: MEMBERS, text: "Tex, hi" } }), env);
    expect(minted.status).toBe(200);
    const { group, outcome } = (await minted.json()) as { group: string; outcome: string };
    expect(group).toMatch(SIM_GROUP_ID);
    expect(outcome).toBe("queued");
    expect(objects.has(groupInboxName(group))).toBe(true);
  });

  it("a second browser's key cannot read or send in a claimed group", async () => {
    const { env } = setup("on");
    expect((await worker.fetch(api("/group/send", { key: KEY, body: { groupId: SIM, phone: ADA, members: MEMBERS, text: "Tex, hi" } }), env)).status).toBe(200);
    expect((await worker.fetch(api(`/group/thread?group=${SIM}`, { method: "GET", key: OTHER_KEY }), env)).status).toBe(409);
    expect((await worker.fetch(api("/group/send", { key: OTHER_KEY, body: { groupId: SIM, phone: ADA, members: MEMBERS, text: "Tex, hi" } }), env)).status).toBe(409);
  });
});

describe("the simulator's group mode: the page", () => {
  it("has a script that parses, and every element it looks up exists in the markup", () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(SIMULATOR_PAGE)?.[1] ?? "";
    expect(script).not.toBe("");
    expect(() => new Function(script)).not.toThrow();
    const looked = [...script.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]);
    const missing = [...new Set(looked)].filter((id) => !SIMULATOR_PAGE.includes(`id="${id}"`));
    expect(missing).toEqual([]);
    expect(SIMULATOR_PAGE).toContain('id="mode-group"');
  });
});

describe("the simulator's group mode: where a simulated group's replies go", () => {
  it("a reply to a simulated group is logged, and no real line is called", async () => {
    const w = world();
    const storage = new MemoryStorage();
    const app = groupLineFor({ ...deps(w), simulatorStorage: storage }, SIM);
    const handle = await app.sendText({ line: SIM_GROUP_LINE, groupId: SIM }, "Friday at 6.");
    expect(handle).toMatch(/^simh_/);
    expect(await app.readOwnMessage({ line: SIM_GROUP_LINE, groupId: SIM }, handle as string)).toBe("Friday at 6.");
    expect(await logOf(storage)).toMatchObject([{ dir: "in", text: "Friday at 6." }]);
    expect(w.sends).toEqual([]);
    expect(w.reacted).toEqual([]);
  });

  it("with no log to write to, a simulated group's send refuses rather than going out", async () => {
    const w = world();
    await expect(groupLineFor(deps(w), SIM).sendText({ line: SIM_GROUP_LINE, groupId: SIM }, "Friday at 6.")).rejects.toThrow();
    expect(w.sends).toEqual([]);
  });

  it("a simulated group's message is answered into its log, and nothing is sent", async () => {
    const w = world();
    const storage = new MemoryStorage();
    // Through the object's own send route, which keeps the members the turn reads (`SIM_MEMBERS_KEY`) as a send does.
    const sent = await simulatedGroupInbox(storage, "send", { keyHash: "a", groupId: SIM, phone: ADA, members: MEMBERS, text: "Tex, hi" }, 1_000, (m) => acceptGroup(storage, m, 1_000));
    expect(await sent.json()).toEqual({ outcome: "queued" });
    await drainGroup(storage, { ...deps(w), simulatorStorage: storage });
    expect(w.sends).toEqual([]);
    expect((await logOf(storage)).some((entry) => entry.dir === "in" && entry.text.trim() !== "")).toBe(true);
  });

  it("ids: the simulator's prefix and shape, and a minted id's", () => {
    expect(isSimulatedGroup(SIM)).toBe(true);
    expect(isSimulatedGroup("sim-group-xyz")).toBe(true); // refused by shape, but never given a real line
    expect(isSimulatedGroup("11111111-2222-3333-4444-555555555555")).toBe(false);
    expect(mintSimGroupId()).toMatch(SIM_GROUP_ID);
  });
});
