/**
 * The machine screens on the gateway's own computer routes: the list answer
 * read into the page's shapes, page actions turned into route calls, and the
 * wrapped source's pairing and asks.
 *
 * ## Sabotage record (2026-11-04, temporary local edits, reverted)
 *
 *   keeping a glimpse (`runs` not checked) in the list           1 failing
 *   a named-people pick saved as "owner" instead of by id          1 failing
 *   looking the pairing code up on every read                     1 failing
 *   a handle the chat does not have dropped instead of refused    1 failing
 *   a raise from another day counted today                         1 failing
 */

import { describe, expect, test } from "@jest/globals";
import { asksOf, machineCallOf, machinesPageOf, ruleKeyOf } from "../features/tex/page/texMachineGateway";
import { slotPlacesOf, withGatewayMachines } from "../features/tex/page/texMachineSource";
import { fixtureSource } from "../features/tex/page/texPageFixture";

const NOW = 1_800_000_000_000;
const GROUP = "a".repeat(64);
const OWNER = "user_1";

const mac = (extra: Record<string, unknown> = {}) => ({
  id: "m1",
  name: "Ada's MacBook Pro",
  os: "macos",
  ownerId: OWNER,
  runs: true,
  online: true,
  folders: ["/Users/ada/code"],
  tools: ["claude"],
  limits: { slots: 3, dayMs: 4 * 3_600_000, othersRunsPerDay: 5, pauseNearPlanLimit: true },
  slotCounts: { recommended: 3, most: 6 },
  status: { ready: true, tools: [{ name: "claude", installed: true, signedIn: true }, { name: "codex", installed: true, signedIn: false }] },
  used: { todayMs: 90 * 60_000 },
  computerUse: false,
  chats: { [`group-${GROUP.slice(0, 58)}`]: { name: "", who: "everyone", askFirst: true, slots: 2 } },
  running: [{ runId: "run_1", jobId: "j1", title: "Fix the test", startedAt: NOW - 60_000 }],
  asks: [],
  ...extra,
});

const page = (machines: unknown[]) => machinesPageOf({ ok: true, machines }, { now: NOW, groupChats: [{ key: GROUP, name: "Team Night" }] });

describe("the list answer, in the page's shapes", () => {
  test("a computer the person runs reads with its settings", () => {
    const m = page([mac()])?.machines[0];
    expect(m).toMatchObject({ id: "m1", kind: "mac", os: "macOS", state: "online", slots: 3, recommended: 3, most: 6, usedMin: 90, limitMin: 240, othersPerDay: 5 });
    expect(m?.tools).toEqual({ claude: "signedIn", codex: "installed" });
    expect(m?.running[0]).toMatchObject({ job: "j1", title: "Fix the test" });
  });

  test("the owner's own texts come first, then each group by the page's own key and name", () => {
    const chats = page([mac()])?.machines[0].chats ?? [];
    expect(chats.map((c) => c.key)).toEqual(["me", GROUP]);
    expect(chats[1]).toMatchObject({ name: "Team Night", who: "everyone", askFirst: true, slots: 2 });
  });

  test("a glimpse of somebody else's computer is left off", () => {
    expect(page([{ id: "m2", name: "Bo's", os: "linux", ownerId: "u2", online: true }])?.machines).toEqual([]);
  });

  test("states: offline, not ready, the day used up, paused near the plan", () => {
    const states = page([
      mac({ id: "a", online: false, seenAt: NOW - 1000 }),
      mac({ id: "b", status: { ready: false } }),
      mac({ id: "c", used: { todayMs: 4 * 3_600_000 } }),
      mac({ id: "d", pausedUntil: NOW + 60_000 }),
    ])?.machines.map((m) => [m.state, m.paused ?? null]);
    expect(states).toEqual([["offline", null], ["notReady", null], ["paused", "limit"], ["paused", "plan"]]);
  });

  test("today's raise counts, another day's does not, and a rule's people read as handles", () => {
    const today = new Date(NOW).toISOString().slice(0, 10);
    const [raised, stale] = page([
      mac({ id: "a", used: { todayMs: 4 * 3_600_000 }, raise: { day: today, extraMs: 2 * 3_600_000 } }),
      mac({ id: "b", used: { todayMs: 4 * 3_600_000 }, raise: { day: "2001-01-01", extraMs: 2 * 3_600_000 } }),
    ])?.machines ?? [];
    expect([raised?.state, raised?.raisedMin]).toEqual(["online", 120]);
    expect([stale?.state, stale?.raisedMin]).toEqual(["paused", undefined]);
    const named = machinesPageOf(
      { ok: true, machines: [mac({ chats: { [`group-${GROUP.slice(0, 58)}`]: { who: ["user_bo", "user_gone"], askFirst: true, slots: 1 } } })] },
      { now: NOW, groupChats: [{ key: GROUP, name: "Team Night" }], people: new Map([[GROUP, [{ userId: "user_bo", handle: "bo" }]]]) },
    );
    expect(named?.machines[0].chats[1].who).toEqual(["@bo"]);
  });

  test("an answer that is not ok reads as nothing", () => {
    expect(machinesPageOf({ ok: false }, { now: NOW })).toBeNull();
  });

  test("an ask names who asked by handle when the gateway knows it", () => {
    expect(asksOf([mac({ asks: [{ id: "ask_2", askerHandle: "bo", chatName: "Team Night", askedAt: NOW }] })])[0].who).toBe("@bo");
  });

  test("asks carry the computer and the ask in the job id, named by their chat", () => {
    const asks = asksOf([mac({ asks: [{ id: "ask_1", chat: `group-${GROUP.slice(0, 58)}`, chatName: "Team Night", title: "Fix it", askedAt: NOW }] })]);
    expect(asks[0]).toMatchObject({ job: "m1/ask_1", who: "Someone in Team Night", title: "Fix it", machine: "m1", slotsFor: 2 });
  });
});

describe("page actions, as route calls", () => {
  const listed = (id: string) => (id === "m1" ? (mac() as Record<string, unknown>) : null);

  test("settings become one patch, limits merged, tools as the list", () => {
    const call = machineCallOf({ type: "machine.set", id: "m1", values: { slots: 2, limitMin: 120, codex: true } }, listed);
    expect(call).toEqual({
      route: "set",
      body: { machineId: "m1", patch: { limits: { slots: 2, dayMs: 7_200_000, othersRunsPerDay: 5, pauseNearPlanLimit: true }, tools: ["claude", "codex"] } },
    });
  });

  test("a chat rule is set under its own key; named people go by id, and a handle the chat lacks is refused", () => {
    const call = machineCallOf({ type: "machine.chat", id: "m1", chat: GROUP, values: { askFirst: false } }, listed);
    expect(call).toMatchObject({ route: "set", body: { patch: { chats: { [`group-${GROUP.slice(0, 58)}`]: { askFirst: false, who: "everyone" } } } } });
    const people = new Map([[GROUP, [{ userId: "user_bo", handle: "bo" }]]]);
    expect(machineCallOf({ type: "machine.chat", id: "m1", chat: GROUP, values: { who: ["@bo"] } }, listed, people)).toMatchObject({
      body: { patch: { chats: { [`group-${GROUP.slice(0, 58)}`]: { who: ["user_bo"] } } } },
    });
    expect(machineCallOf({ type: "machine.chat", id: "m1", chat: GROUP, values: { who: ["@bo", "@eve"] } }, listed, people)).toEqual({ refused: "unknown_person" });
    expect(machineCallOf({ type: "machine.chat", id: "m1", chat: GROUP, values: { who: ["@bo"] } }, listed)).toEqual({ refused: "unknown_person" });
    expect(ruleKeyOf("me", OWNER)).toBe(`texts-${OWNER}`);
  });

  test("lending, the answer to an ask, and what is not kept", () => {
    expect(machineCallOf({ type: "machine.chat.add", id: "m1", chat: GROUP }, listed)).toMatchObject({ route: "lend", body: { chat: GROUP, who: "owner", askFirst: true } });
    expect(machineCallOf({ type: "job.allow", job: "m1/ask_1", mode: "always" }, listed)).toEqual({ route: "answer", body: { machineId: "m1", askId: "ask_1", yes: true, always: true } });
    expect(machineCallOf({ type: "job.allow", job: "m1/ask_1", mode: "decline" }, listed)).toMatchObject({ body: { yes: false, always: false } });
    expect(machineCallOf({ type: "machine.raise", id: "m1", minutes: 120 }, listed)).toEqual({ route: "raise", body: { machineId: "m1", minutes: 120 } });
  });
});

describe("the wrapped source", () => {
  function harness(code: string | null) {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    let looks = 0;
    const answers: [string, boolean][] = [];
    const source = withGatewayMachines(fixtureSource(), {
      endpoint: "https://gateway.example/mcp",
      workspaceId: "ws_1",
      token: async () => "t",
      pairingCode: () => code,
      now: () => NOW,
      pairing: {
        find: async () => ((looks += 1), { name: "build-box", os: "linux", createdAt: NOW }),
        answer: async (c, approve) => (answers.push([c, approve]), true),
      },
      selfHandle: "ada",
      fetch: (async (url: string, init: { body: string }) => {
        calls.push({ url, body: JSON.parse(init.body) });
        if (url.endsWith("/chat-people")) return { status: 200, json: async () => ({ ok: true, people: [{ userId: "user_ada", handle: "ada" }, { userId: "user_bo", handle: "bo" }] }) };
        return { status: 200, json: async () => ({ ok: true, machines: [mac({ asks: [{ id: "ask_1", chat: "x", title: "T", askedAt: NOW }] })] }) };
      }) as unknown as typeof fetch,
    });
    return { source, calls, answers, looks: () => looks };
  }

  test("reads the list from the gateway's own route, for the workspace", async () => {
    const h = harness(null);
    const read = await h.source.machines("me");
    expect(read.kind).toBe("ok");
    expect(h.calls[0]).toEqual({ url: "https://gateway.example/machines/app/list", body: { workspaceId: "ws_1" } });
  });

  test("a group's page lists its other people by handle, read once", async () => {
    const h = harness(null);
    const first = await h.source.machines(GROUP);
    await h.source.machines(GROUP);
    expect(first.kind === "ok" ? first.value.chatPeople : null).toEqual(["@bo"]);
    expect(h.calls.filter((c) => c.url.endsWith("/chat-people"))).toEqual([{ url: "https://gateway.example/machines/app/chat-people", body: { workspaceId: "ws_1", chat: GROUP } }]);
  });

  test("the own overview carries the waiting asks", async () => {
    const read = await harness(null).source.overview("me");
    expect(read.kind === "ok" ? read.value.asks?.map((a) => a.job) : null).toEqual(["m1/ask_1"]);
  });

  test("the pool shows each computer's slots beside Tex's cloud, on the own page and in a group it serves", async () => {
    const own = await harness(null).source.overview("me");
    const places = own.kind === "ok" ? own.value.places ?? [] : [];
    expect(places[0]).toMatchObject({ key: "cloud", kind: "cloud" });
    expect(places.find((p) => p.key === "m1")).toEqual({ key: "m1", kind: "machine", machineKind: "mac", name: "Ada's MacBook Pro", slots: 3 });
    expect(own.kind === "ok" ? own.value.minions.filter((s) => s.place === "m1").length : 0).toBe(3);
    // In a group it is lent to: two of its slots there, as the rule says; a group it does not serve sees none of it.
    expect(slotPlacesOf(page([mac()]), GROUP)).toEqual([{ key: "m1", kind: "machine", machineKind: "mac", name: "Ada's MacBook Pro", slots: 2 }]);
    expect(slotPlacesOf(page([mac()]), "b".repeat(64))).toEqual([]);
    expect(slotPlacesOf(page([mac({ online: false, seenAt: NOW - 5 })]), "me")[0]).toMatchObject({ offline: true, since: NOW - 5 });
  });

  test("a code in the address is looked up once, answered, and then gone", async () => {
    const h = harness("KQ7-4MP");
    const first = await h.source.machines("me");
    await h.source.machines("me");
    expect(first.kind === "ok" ? first.value.pairing : null).toMatchObject({ code: "KQ7-4MP", name: "build-box", os: "Linux" });
    expect(h.looks()).toBe(1);
    expect(await h.source.act("me", { type: "machine.pair", code: "KQ7-4MP", approve: true })).toEqual({ ok: true });
    expect(h.answers).toEqual([["KQ7-4MP", true]]);
    const after = await h.source.machines("me");
    expect(after.kind === "ok" ? after.value.pairing : "x").toBeNull();
  });
});
