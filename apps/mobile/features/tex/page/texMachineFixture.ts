/**
 * The machine artboards' example data, for the visual fixture, the screenshot
 * pass and the tests only (same rule as `texPageFixture.ts`: never reachable
 * in production). Every name is made up.
 *
 * `machineFixtureSource(scenario)` is the mock's gateway plus machines: it
 * answers `/tex/page/machines`, adds the places and the waiting ask to the
 * overview, and applies machine actions to its copy, then patches the open
 * feed as the gateway does.
 */

import { fixtureNow, fixtureSource } from "./texPageFixture";
import type { Read, TexPageSource } from "./texPageSource";
import { readOverview } from "./texPageRead";
import type { Machine, MachineAsk, MachinesPage, Pairing, SlotPlace } from "./texMachineTypes";
import type { JobSummary, Overview, Slot } from "./texPageTypes";

/**
 * - `full`: the MacBook and the VM online (screens 1, 2, 4, 6).
 * - `states`: one machine in each state (screen 8).
 * - `empty`: no machines yet.
 * - `pairing`: a code waiting for a yes (screen 3b).
 * - `notReady`: the Mac connected with nothing signed in (screen 9).
 * - `limit`: the Mac's day used up (screen 10).
 * - `offline`: the VM asleep, its slots on the home dimmed (screen 6).
 */
export type MachineScenario = "full" | "states" | "empty" | "pairing" | "notReady" | "limit" | "offline";

export const MACHINE_SCENARIOS: readonly MachineScenario[] = ["full", "states", "empty", "pairing", "notReady", "limit", "offline"];

const now = fixtureNow();
const min = 60_000;
const today = (h: number, m: number) => {
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  return d.getTime();
};

const TEAM = { key: "g-team", name: "Team Night" };

function macbook(): Machine {
  return {
    id: "m-mbp",
    name: "Ada's MacBook Pro",
    kind: "mac",
    os: "macOS",
    state: "online",
    connectedAt: new Date(2026, 9, 28).getTime(),
    slots: 4,
    recommended: 4,
    most: 8,
    running: [{ job: "upload-test", title: "Fix the flaky upload test", for: "Bo", startedAt: now - 24 * min }],
    usedMin: 100,
    limitMin: 240,
    othersPerDay: 5,
    pauseNearPlan: true,
    tools: { claude: "signedIn", codex: "missing" },
    folders: ["~/code/context", "~/code/supa-framework"],
    computerUse: false,
    chats: [
      { key: "me", name: "Just you", who: "me", askFirst: true, slots: 4 },
      { ...TEAM, who: ["Bo"], askFirst: true, slots: 2 },
    ],
  };
}

function vm(): Machine {
  return {
    id: "m-vm",
    name: "team-night-vm",
    kind: "cli",
    os: "Linux",
    state: "online",
    connectedAt: new Date(2026, 10, 1).getTime(),
    slots: 2,
    recommended: 2,
    most: 3,
    running: [],
    lastEndedAt: today(13, 52),
    usedMin: 20,
    limitMin: 120,
    othersPerDay: 5,
    pauseNearPlan: true,
    tools: { claude: "signedIn", codex: "signedIn" },
    folders: ["~/work"],
    computerUse: false,
    chats: [{ key: "me", name: "Just you", who: "me", askFirst: true, slots: 2 }],
  };
}

const PAIRING: Pairing = { code: "KQ7-4MP", name: "team-night-vm", os: "Linux", tools: ["claude", "codex"], at: today(14, 14) };

function machinesFor(scenario: MachineScenario): MachinesPage {
  const cloud = { slots: 3, busy: 1 };
  switch (scenario) {
    case "empty":
      return { machines: [], cloud, pairing: null };
    case "pairing":
      return { machines: [macbook()], cloud, pairing: PAIRING };
    case "notReady":
      return {
        machines: [
          {
            ...macbook(),
            state: "notReady",
            connectedAt: now - 2 * min,
            running: [],
            usedMin: 0,
            tools: { claude: "installed", codex: "missing" },
            folders: [],
            chats: [{ key: "me", name: "Just you", who: "me", askFirst: true, slots: 2 }],
            slots: 2,
          },
        ],
        cloud,
        pairing: null,
      };
    case "limit":
      return {
        machines: [{ ...macbook(), state: "paused", paused: "limit", running: [], lastEndedAt: today(13, 52), usedMin: 240 }, vm()],
        cloud,
        pairing: null,
      };
    case "offline":
      return { machines: [macbook(), { ...vm(), state: "offline", since: today(9, 40) }], cloud, pairing: null };
    case "states":
      return {
        machines: [
          { ...macbook(), state: "paused", paused: "limit", running: [], usedMin: 240 },
          { ...macbook(), id: "m-mini", name: "Studio Mac mini", state: "notReady", running: [], usedMin: 0, tools: { claude: "installed", codex: "missing" } },
          { ...vm(), state: "offline", since: today(9, 40) },
          { ...vm(), id: "m-new", name: "build-box", state: "pending", since: today(14, 14), code: "KQ7-4MP" },
        ],
        cloud,
        pairing: null,
      };
    case "full":
    default:
      return { machines: [macbook(), vm()], cloud, pairing: null };
  }
}

const job = (id: string, title: string, startedAt: number, extra: Partial<JobSummary> = {}): JobSummary => ({
  id,
  title,
  state: "running",
  startedAt,
  failedSteps: 0,
  ...extra,
});

/** The home page's pool for the person's own chat: Tex's cloud first, then each connected machine. */
function placesFor(page: MachinesPage): { places: SlotPlace[]; minions: (Slot & { place: string })[] } {
  const places: SlotPlace[] = [{ key: "cloud", kind: "cloud", name: "Tex's cloud", slots: page.cloud.slots }];
  const minions: (Slot & { place: string })[] = [
    { place: "cloud", slot: 1, job: job("maritime", "Research maritime.sh pricing", now - 12 * min) },
  ];
  for (const m of page.machines) {
    if (m.state === "pending") continue;
    places.push({
      key: m.id,
      kind: "machine",
      machineKind: m.kind,
      name: m.name,
      slots: m.slots,
      ...(m.state === "offline" ? { offline: true, ...(m.since ? { since: m.since } : {}) } : {}),
    });
    // Each machine run is a Claude Code job in this fixture; the tool shows on the slot's line.
    m.running.forEach((r, i) =>
      minions.push({ place: m.id, slot: i + 1, job: job(r.job, r.title, r.startedAt, { tool: "Claude Code", ranOn: `On ${m.name}`, machine: m.id, machineName: m.name, ...(r.for ? { for: r.for } : {}) }) }),
    );
  }
  return { places, minions };
}

const ASK: MachineAsk = {
  job: "upload-test-2",
  who: "Bo",
  title: "Fix the flaky upload test",
  machine: "m-mbp",
  machineName: "MacBook Pro",
  tool: "claude",
  folder: "~/code/context",
  slotsFor: 2,
  at: today(14, 31),
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The mock's gateway, with machines in the given scenario. */
export function machineFixtureSource(scenario: MachineScenario = "full", options: { ask?: boolean } = {}): TexPageSource {
  const base = fixtureSource();
  const page = machinesFor(scenario);
  let asks: MachineAsk[] = options.ask ? [ASK] : [];
  const feeds = new Set<{ chat: string; onPatch: Parameters<TexPageSource["live"]>[1] }>();
  const changed = () => {
    for (const f of feeds) f.onPatch({ section: "machines" });
  };
  const ok = <T>(value: T): Read<T> => ({ kind: "ok", value: clone(value) });
  const find = (id: string) => page.machines.find((m) => m.id === id);

  return {
    ...base,
    async overview(chat) {
      const read = await base.overview(chat);
      if (read.kind !== "ok") return read;
      const o: Overview = read.value;
      if (chat !== "me") return ok({ ...o, places: undefined });
      const { places, minions } = placesFor(page);
      // Through the reader, as the gateway's answer goes: it fills each place's free slots.
      const read2 = readOverview(clone({
        ...o,
        places,
        minions,
        asks,
        status: { ...o.status, needsYou: o.status.needsYou + asks.length },
        earlier: o.earlier.map((j, i) => (i === 0 && page.machines[0] ? { ...j, ranOn: `On ${page.machines[0].name}` } : j)),
      }));
      return read2 ? ok(read2) : { kind: "failed" };
    },
    async machines(chat) {
      if (chat !== "me" && chat !== TEAM.key && chat !== "g-care") return { kind: "notYours" };
      return ok(page);
    },
    async act(chat, action) {
      switch (action.type) {
        case "machine.set": {
          const m = find(action.id);
          if (!m) return { ok: false, error: "not_found" };
          const { claude, codex, ...rest } = action.values;
          Object.assign(m, rest);
          if (claude !== undefined && m.tools.claude !== "missing" && m.tools.claude !== "installed") m.tools.claude = claude ? "signedIn" : "off";
          if (codex !== undefined && m.tools.codex !== "missing" && m.tools.codex !== "installed") m.tools.codex = codex ? "signedIn" : "off";
          for (const c of m.chats) c.slots = Math.min(c.slots, m.slots);
          break;
        }
        case "machine.disconnect":
          page.machines = page.machines.filter((m) => m.id !== action.id);
          break;
        case "machine.pair": {
          const p = page.pairing;
          if (!p || p.code !== action.code) return { ok: false, error: "not_found" };
          page.pairing = null;
          if (action.approve) {
            page.machines.push({ ...vm(), id: `m-${p.code}`, name: p.name, connectedAt: now, usedMin: 0, slots: 2, limitMin: 120, lastEndedAt: undefined });
          }
          break;
        }
        case "machine.chat": {
          const c = find(action.id)?.chats.find((x) => x.key === action.chat);
          if (!c) return { ok: false, error: "not_found" };
          Object.assign(c, action.values);
          break;
        }
        case "machine.chat.add": {
          const m = find(action.id);
          if (!m) return { ok: false, error: "not_found" };
          if (!m.chats.some((c) => c.key === action.chat)) {
            m.chats.push({ key: action.chat, name: action.chat === TEAM.key ? TEAM.name : action.chat, who: "me", askFirst: true, slots: Math.ceil(m.slots / 2) });
          }
          break;
        }
        case "machine.chat.remove": {
          const m = find(action.id);
          if (m) m.chats = m.chats.filter((c) => c.key !== action.chat);
          break;
        }
        case "machine.raise": {
          const m = find(action.id);
          if (!m) return { ok: false, error: "not_found" };
          m.raisedMin = (m.raisedMin ?? 0) + action.minutes;
          if (m.state === "paused" && m.paused === "limit") {
            m.state = "online";
            delete m.paused;
          }
          break;
        }
        case "job.allow":
          asks = asks.filter((a) => a.job !== action.job);
          break;
        default:
          return base.act(chat, action);
      }
      changed();
      return { ok: true };
    },
    live(chat, onPatch, onLive) {
      const feed = { chat, onPatch };
      feeds.add(feed);
      const inner = base.live(chat, onPatch, onLive);
      return {
        watch(next) {
          feed.chat = next;
          inner?.watch(next);
        },
        close() {
          feeds.delete(feed);
          inner?.close();
        },
      };
    },
  };
}
