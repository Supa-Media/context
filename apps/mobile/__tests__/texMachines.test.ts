/**
 * The Tex "Your machines" data and words, checked without drawing anything:
 * the gateway's machine answers read defensively (`texMachineRead.ts`), the
 * page's place in its address (`texPlace.ts`), the strings every machine
 * screen shows (`texMachineFormat.ts`), the home's slot pool
 * (`texPageRead.ts`), and the visual fixture's mock gateway
 * (`texMachineFixture.ts`).
 *
 * The security property that matters most here: computer use is on only for
 * a Mac app machine, whatever the gateway sends.
 */

import { slotLine } from "../features/tex/page/texPageFormat";
import { describe, expect, test } from "@jest/globals";

import {
  MAX_MACHINE_SLOTS,
  readAsk,
  readMachine,
  readMachineChat,
  readMachinesPage,
  readPairing,
  readPlaces,
} from "../features/tex/page/texMachineRead";
import {
  askFacts,
  hm,
  limitChoices,
  pairingFacts,
  poolFoot,
  rowLine,
  rowRight,
  runningLine,
  sharedLine,
  toolLine,
  whoLabel,
} from "../features/tex/page/texMachineFormat";
import type { Machine, MachineChat, MachinesPage } from "../features/tex/page/texMachineTypes";
import { placeHref, readPlace } from "../features/tex/page/texPlace";
import { readJob, readOverview } from "../features/tex/page/texPageRead";
import { machineFixtureSource } from "../features/tex/page/texMachineFixture";

/** A valid online Mac, with every field the reader keeps, for the format tests to change. */
function machine(over: Partial<Machine> = {}): Machine {
  return {
    id: "m-mbp",
    name: "Ada's MacBook Pro",
    kind: "mac",
    os: "macOS",
    state: "online",
    slots: 4,
    recommended: 4,
    most: 8,
    running: [],
    usedMin: 100,
    limitMin: 240,
    othersPerDay: 5,
    pauseNearPlan: true,
    tools: { claude: "signedIn", codex: "missing" },
    folders: [],
    computerUse: false,
    chats: [],
    ...over,
  };
}

const at = (h: number, m: number) => new Date(2026, 10, 2, h, m).getTime();

describe("texMachineRead: readMachine", () => {
  const good = { id: "m1", name: "Box", state: "online" };

  test("drops a machine without an id, a name, or a known state", () => {
    expect(readMachine({ name: "Box", state: "online" })).toBeNull();
    expect(readMachine({ id: "m1", state: "online" })).toBeNull();
    expect(readMachine({ id: "m1", name: "Box" })).toBeNull();
    expect(readMachine({ id: "m1", name: "Box", state: "sleeping" })).toBeNull();
    expect(readMachine(good)).not.toBeNull();
    expect(readMachine(null)).toBeNull();
  });

  test("clamps slots, recommended and most to MAX_MACHINE_SLOTS (8)", () => {
    expect(MAX_MACHINE_SLOTS).toBe(8);
    const m = readMachine({ ...good, slots: 20, recommended: 50, most: 99 });
    expect(m?.slots).toBe(8);
    expect(m?.recommended).toBe(8);
    expect(m?.most).toBe(8);
  });

  test("computer use is never on unless the machine is the Mac app", () => {
    expect(readMachine({ ...good, kind: "cli", computerUse: true })?.computerUse).toBe(false);
    expect(readMachine({ ...good, computerUse: true })?.computerUse).toBe(false);
    expect(readMachine({ ...good, kind: "mac", computerUse: true })?.computerUse).toBe(true);
    expect(readMachine({ ...good, kind: "mac", computerUse: "yes" })?.computerUse).toBe(false);
    expect(readMachine({ ...good, kind: "mac" })?.computerUse).toBe(false);
  });

  test("an unknown tool state reads as missing", () => {
    const m = readMachine({ ...good, tools: { claude: "bogus", codex: "signedIn" } });
    expect(m?.tools).toEqual({ claude: "missing", codex: "signedIn" });
  });
});

describe("texMachineRead: chats and who", () => {
  test("askFirst defaults to true when the gateway does not say", () => {
    expect(readMachineChat({ key: "g", name: "G" })?.askFirst).toBe(true);
    expect(readMachineChat({ key: "g", name: "G", askFirst: false })?.askFirst).toBe(false);
  });

  test("who reads 'everyone' and a string array, and anything else as 'me'", () => {
    const who = (w: unknown) => readMachineChat({ key: "g", who: w })?.who;
    expect(who("everyone")).toBe("everyone");
    expect(who(["Bo", "Cy"])).toEqual(["Bo", "Cy"]);
    expect(who("Bo")).toBe("me");
    expect(who(5)).toBe("me");
    expect(who(null)).toBe("me");
    expect(who({})).toBe("me");
    expect(who(undefined)).toBe("me");
    expect(who([])).toBe("me");
    expect(who([1, 2])).toBe("me");
  });
});

describe("texMachineRead: pages and pairing", () => {
  test("readMachinesPage on junk is null, and on {} is an empty page", () => {
    expect(readMachinesPage("junk")).toBeNull();
    expect(readMachinesPage(null)).toBeNull();
    expect(readMachinesPage({})).toEqual({ machines: [], cloud: { slots: 0, busy: 0 }, pairing: null });
  });

  test("readPairing keeps only the coding tools it knows", () => {
    const p = readPairing({ code: "KQ7-4MP", name: "vm", os: "Linux", tools: ["claude", "gemini", "codex"], at: 5 });
    expect(p?.tools).toEqual(["claude", "codex"]);
    expect(p?.code).toBe("KQ7-4MP");
    expect(readPairing({ name: "vm" })).toBeNull();
  });

  test("readPlaces is undefined for a non-array and for an array with no valid place", () => {
    expect(readPlaces("x")).toBeUndefined();
    expect(readPlaces(null)).toBeUndefined();
    expect(readPlaces({})).toBeUndefined();
    expect(readPlaces([])).toBeUndefined();
    expect(readPlaces([{ key: "x" }, { key: "y", kind: "moon", slots: 2 }])).toBeUndefined();
    expect(readPlaces([{ key: "cloud", kind: "cloud", slots: 3 }])).toEqual([
      { key: "cloud", kind: "cloud", name: "cloud", slots: 3 },
    ]);
  });

  test("readAsk requires a job and who", () => {
    expect(readAsk({ who: "Bo" })).toBeNull();
    expect(readAsk({ job: "j" })).toBeNull();
    const a = readAsk({ job: "j", who: "Bo" });
    expect(a).not.toBeNull();
    expect(a?.tool).toBe("claude");
    expect(a?.slotsFor).toBe(0);
  });
});

describe("texMachineFormat", () => {
  test("hm reads minutes as 0m, 20m, 1h 40m and 4h", () => {
    expect(hm(0)).toBe("0m");
    expect(hm(20)).toBe("20m");
    expect(hm(100)).toBe("1h 40m");
    expect(hm(240)).toBe("4h");
  });

  test("rowLine: one line per state", () => {
    expect(rowLine(machine({ usedMin: 100, limitMin: 240 }))).toBe("Online · Mac app · 1h 40m of 4h today");
    expect(rowLine(machine({ usedMin: 100, limitMin: 240, raisedMin: 60 }))).toBe("Online · Mac app · 1h 40m of 5h today");
    expect(rowLine(machine({ state: "paused", paused: "limit" }))).toBe("Daily limit reached · back at midnight");
    expect(rowLine(machine({ state: "paused", paused: "plan" }))).toBe("Plan limit close · new jobs go to Tex's cloud");
    expect(rowLine(machine({ state: "notReady" }))).toBe("Not ready · no coding tool signed in");
    expect(rowLine(machine({ state: "offline", kind: "cli", os: "Linux", since: at(9, 40) }))).toBe(
      "Offline since 9:40 AM · Linux",
    );
    expect(rowLine(machine({ state: "offline", kind: "cli", os: "Linux" }))).toBe("Offline · Linux");
    expect(rowLine(machine({ state: "pending", since: at(9, 40) }))).toBe("Wants to connect · asked 9:40 AM");
    expect(rowLine(machine({ state: "pending" }))).toBe("Wants to connect");
  });

  test("rowRight: the words beside the pips", () => {
    expect(rowRight(machine({ slots: 4 }))).toBe("4 free");
    expect(rowRight(machine({ slots: 4, running: [{ job: "j", title: "t", startedAt: 1 }] }))).toBe("1 of 4 busy");
    expect(rowRight(machine({ state: "paused" }))).toBe("Paused");
    expect(rowRight(machine({ state: "offline" }))).toBe("Offline");
    expect(rowRight(machine({ state: "notReady" }))).toBe("Not ready");
    expect(rowRight(machine({ state: "pending" }))).toBe("Review");
  });

  test("poolFoot: both branches", () => {
    const page = (machines: Machine[]): MachinesPage => ({ machines, cloud: { slots: 3, busy: 0 }, pairing: null });
    expect(poolFoot(page([machine({ slots: 4 })]))).toBe(
      "7 slots in all. Coding jobs go to a free slot on your machines first; when they are busy or off, Tex uses the cloud.",
    );
    expect(poolFoot(page([machine({ state: "offline" })]))).toBe(
      "None of your machines can take a job right now, so coding jobs go to Tex's cloud.",
    );
  });

  test("sharedLine: me, picked people with ask first, and everyone", () => {
    const m = machine({ slots: 4 });
    const chat = (c: Partial<MachineChat>): MachineChat => ({ key: "g-team", name: "Team", who: ["Bo"], askFirst: true, slots: 2, ...c });
    expect(sharedLine({ key: "me", name: "Just you", who: "me", askFirst: true, slots: 4 }, m)).toBe("All 4 slots");
    expect(sharedLine(chat({}), m)).toBe("Up to 2 slots · Bo can send it work · Ask me first");
    expect(sharedLine(chat({ who: ["Bo", "Cy"], slots: 1 }), m)).toBe("Up to 1 slot · Bo, Cy can send it work · Ask me first");
    expect(sharedLine(chat({ who: "everyone", askFirst: false }), m)).toBe("Up to 2 slots · Everyone can send it work");
    expect(sharedLine(chat({ who: "me", slots: 2 }), m)).toBe("Up to 2 slots");
  });

  test("whoLabel", () => {
    expect(whoLabel("me")).toBe("Only you");
    expect(whoLabel("everyone")).toBe("Everyone here");
    expect(whoLabel(["Bo", "Cy"])).toBe("Bo, Cy");
  });

  test("runningLine: nothing, the last finished, and running", () => {
    const now = at(14, 0);
    expect(runningLine(machine(), now)).toBe("Nothing right now");
    expect(runningLine(machine({ lastEndedAt: at(13, 52) }), now)).toBe("Nothing. The last job finished at 1:52 PM");
    const run = { job: "j", title: "Fix the flaky upload test", startedAt: now - 24 * 60_000 };
    expect(runningLine(machine({ running: [run] }), now)).toBe("Fix the flaky upload test · 24 min");
    expect(runningLine(machine({ running: [{ ...run, for: "Bo" }] }), now)).toBe(
      "Fix the flaky upload test · for Bo · 24 min",
    );
    expect(runningLine(machine({ running: [run, { ...run, job: "k" }] }), now)).toBe(
      "Fix the flaky upload test · 24 min · and 1 more",
    );
  });

  test("pairingFacts", () => {
    expect(pairingFacts({ code: "KQ7-4MP", name: "vm", os: "Linux", tools: ["claude", "codex"], at: at(14, 14) })).toBe(
      "Linux · Claude Code and Codex signed in · asked 2:14 PM",
    );
    expect(pairingFacts({ code: "KQ7-4MP", name: "vm", os: "Linux", tools: [], at: 0 })).toBe(
      "Linux · no coding tool signed in",
    );
  });

  test("askFacts", () => {
    expect(askFacts({ tool: "claude", folder: "~/code/context", slotsFor: 2, at: at(14, 31) })).toBe(
      "Claude Code in ~/code/context · uses 1 of the 2 slots for this chat · asked 2:31 PM",
    );
    expect(askFacts({ tool: "codex", slotsFor: 0, at: 0 })).toBe("Codex");
  });

  test("toolLine reads each state for the machine's own place", () => {
    const mac = { kind: "mac" as const, os: "macOS" };
    const linux = { kind: "cli" as const, os: "Linux" };
    expect(toolLine("signedIn", mac)).toBe("Signed in on this Mac");
    expect(toolLine("off", linux)).toBe("Signed in on this computer");
    expect(toolLine("installed", linux)).toBe("Installed, not signed in");
    expect(toolLine("missing", linux)).toBe("Not found on this computer");
  });

  test("limitChoices keeps a non-standard limit and drops nothing", () => {
    expect(limitChoices(240)).toEqual([60, 120, 240, 360, 480, 720]);
    expect(limitChoices(0)).toEqual([60, 120, 240, 360, 480, 720]);
    expect(limitChoices(100)).toEqual([60, 100, 120, 240, 360, 480, 720]);
  });
});

describe("texPlace: readPlace and placeHref", () => {
  test("a machine view with a valid id round-trips", () => {
    const place = readPlace({ view: "machine", machine: "m-mbp" });
    expect(place).toEqual({ chat: "me", view: "machine", machine: "m-mbp" });
    expect(placeHref("seyi", place, [])).toBe("/tex/@seyi/machine?machine=m-mbp");
    expect(readPlace({ rest: ["machine"], machine: "m-mbp" })).toEqual(place);
  });

  test("a machine view without an id falls back to the machines list", () => {
    const place = readPlace({ view: "machine" });
    expect(place.view).toBe("machines");
    expect(place.machine).toBeUndefined();
  });

  test("a machine id with bad characters is rejected", () => {
    const place = readPlace({ view: "machine", machine: "../x" });
    expect(place.view).toBe("machines");
    expect(place.machine).toBeUndefined();
  });
});

describe("texPageRead: readOverview slot pool", () => {
  const slotJob = { id: "j", title: "t", state: "running", startedAt: 1 };

  test("without places the minions are exactly three slots, 1 to 3", () => {
    const o = readOverview({ minions: [{ slot: 2, job: slotJob }] });
    expect(o?.places).toBeUndefined();
    expect(o?.minions.map((s) => s.slot)).toEqual([1, 2, 3]);
    expect(o?.minions[1].job?.id).toBe("j");
    expect(o?.minions[0].job).toBeNull();
    expect(o?.minions[2].job).toBeNull();
  });

  test("with places the slots are each place's own count, with the job in its place", () => {
    const o = readOverview({
      places: [
        { key: "cloud", kind: "cloud", name: "Tex's cloud", slots: 3 },
        { key: "m1", kind: "machine", name: "Mac", slots: 2 },
      ],
      minions: [{ place: "m1", slot: 2, job: slotJob }],
    });
    expect(o?.minions).toHaveLength(5);
    const filled = o?.minions.filter((s) => s.job !== null) ?? [];
    expect(filled).toHaveLength(1);
    expect(filled[0]).toMatchObject({ place: "m1", slot: 2 });
    expect(filled[0].job?.id).toBe("j");
    const free = o?.minions.filter((s) => s.job === null) ?? [];
    expect(free.map((s) => `${s.place}:${s.slot}`)).toEqual(["cloud:1", "cloud:2", "cloud:3", "m1:1"]);
  });

  test("a job's ranOn is read", () => {
    expect(readJob({ id: "j", title: "t", state: "done", startedAt: 1, ranOn: "On Ada's MacBook Pro" })?.ranOn).toBe(
      "On Ada's MacBook Pro",
    );
    const o = readOverview({ earlier: [{ id: "e", title: "x", state: "done", startedAt: 1, ranOn: "On the VM" }] });
    expect(o?.earlier[0].ranOn).toBe("On the VM");
  });
});

describe("texMachineFixture: machineFixtureSource", () => {
  test("machines for me is ok, with two machines in the full scenario", async () => {
    const read = await machineFixtureSource("full").machines("me");
    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;
    expect(read.value.machines).toHaveLength(2);
  });

  test("machine.set changes the machine's slots", async () => {
    const source = machineFixtureSource("full");
    const result = await source.act("me", { type: "machine.set", id: "m-mbp", values: { slots: 3 } });
    expect(result.ok).toBe(true);
    const read = await source.machines("me");
    if (read.kind !== "ok") throw new Error("expected ok");
    expect(read.value.machines.find((m) => m.id === "m-mbp")?.slots).toBe(3);
  });

  test("machine.pair approve on the pairing scenario adds a machine and clears the pairing", async () => {
    const source = machineFixtureSource("pairing");
    const result = await source.act("me", { type: "machine.pair", code: "KQ7-4MP", approve: true });
    expect(result.ok).toBe(true);
    const read = await source.machines("me");
    if (read.kind !== "ok") throw new Error("expected ok");
    expect(read.value.machines).toHaveLength(2);
    expect(read.value.machines.map((m) => m.name)).toContain("team-night-vm");
    expect(read.value.pairing).toBeNull();
  });

  test("job.allow removes the ask from the owner's overview", async () => {
    const source = machineFixtureSource("full", { ask: true });
    const before = await source.overview("me");
    if (before.kind !== "ok") throw new Error("expected ok");
    expect(before.value.asks).toHaveLength(1);
    const job = before.value.asks?.[0].job ?? "";
    await source.act("me", { type: "job.allow", job, mode: "once" });
    const after = await source.overview("me");
    if (after.kind !== "ok") throw new Error("expected ok");
    expect(after.value.asks).toHaveLength(0);
  });

  test("a group chat's overview has no places", async () => {
    const read = await machineFixtureSource("full").overview("g-team");
    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;
    expect(read.value.places).toBeUndefined();
  });
});

describe("audit additions: a place's machine kind and a slot's tool", () => {
  test("readPlaces keeps a machine kind it knows and drops one it does not", () => {
    const places = readPlaces([
      { key: "m-1", kind: "machine", machineKind: "cli", name: "vm", slots: 2 },
      { key: "m-2", kind: "machine", machineKind: "toaster", name: "x", slots: 1 },
    ]);
    expect(places?.[0].machineKind).toBe("cli");
    expect(places?.[1].machineKind).toBeUndefined();
  });

  test("a busy slot's line names the coding tool when the gateway sent one", () => {
    const now = 1_000_000_000;
    const base = { id: "j", title: "t", state: "running" as const, startedAt: now - 24 * 60_000, failedSteps: 0 };
    expect(slotLine({ ...base, for: "Bo", tool: "Claude Code" }, now).text).toBe("For Bo · Claude Code · 24 min");
    expect(slotLine(base, now).text).not.toContain("Claude");
  });
});
