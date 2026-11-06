/**
 * The gateway's machine answers, field by field. Pure, like `texPageRead.ts`:
 * anything missing or mistyped reads as empty or is dropped, and nothing here
 * invents a value the gateway did not send. A machine without an id, a name or
 * a known state is dropped whole, because a row that cannot say what it is
 * would only mislead.
 */

import type {
  Machine,
  MachineAsk,
  MachineChat,
  MachineRun,
  MachineInstall,
  MachineSignIn,
  MachinesPage,
  MachineState,
  MachineWho,
  Pairing,
  SlotPlace,
  ToolName,
  ToolState,
} from "./texMachineTypes";

type Rec = Record<string, unknown>;

const rec = (v: unknown): Rec | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const count = (v: unknown, fallback = 0): number => {
  const n = num(v);
  return n === undefined || n < 0 ? fallback : Math.floor(n);
};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const list = <T>(v: unknown, read: (x: unknown) => T | null): T[] =>
  arr(v)
    .map(read)
    .filter((x): x is T => x !== null);
const strings = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === "string" && x.length > 0);

const STATES = new Set<MachineState>(["online", "offline", "paused", "notReady", "pending"]);
const TOOL_STATES = new Set<ToolState>(["signedIn", "installed", "missing", "off"]);
const TOOL_NAMES: readonly ToolName[] = ["claude", "codex"];

/** Most slots a machine may be set to, whatever it reports: the stepper's top (design spec, screen 2). */
export const MAX_MACHINE_SLOTS = 8;

function readWho(v: unknown): MachineWho {
  if (v === "everyone") return "everyone";
  const people = strings(v);
  return people.length ? people : "me";
}

export function readMachineChat(v: unknown): MachineChat | null {
  const r = rec(v);
  const key = str(r?.key);
  if (!r || !key) return null;
  return {
    key,
    name: str(r.name) ?? key,
    who: readWho(r.who),
    // Asking first is the safe answer when the gateway did not say.
    askFirst: r.askFirst !== false,
    slots: count(r.slots),
  };
}

function readRun(v: unknown): MachineRun | null {
  const r = rec(v);
  const job = str(r?.job);
  if (!r || !job) return null;
  return { job, title: str(r.title) ?? "", startedAt: num(r.startedAt) ?? 0, ...(str(r.for) ? { for: str(r.for) } : {}) };
}

const SIGN_IN_STATES: ReadonlySet<string> = new Set(["starting", "link", "checking", "done", "failed"]);

export function readSignIn(v: unknown): MachineSignIn | null {
  const r = rec(v);
  const id = str(r?.id);
  if (!r || !id || !SIGN_IN_STATES.has(r.state as string) || !(TOOL_NAMES as readonly string[]).includes(r.tool as string)) return null;
  const url = str(r.url);
  const error = str(r.error);
  const userCode = str(r.userCode);
  return {
    id,
    tool: r.tool as ToolName,
    state: r.state as MachineSignIn["state"],
    at: num(r.at) ?? 0,
    ...(url && url.startsWith("https://") ? { url } : {}),
    ...(userCode && /^[A-Z0-9-]{4,16}$/.test(userCode) ? { userCode } : {}),
    ...(error ? { error } : {}),
  };
}

const INSTALL_STATES: ReadonlySet<string> = new Set(["starting", "working", "done", "failed"]);
const INSTALL_STEPS: ReadonlySet<string> = new Set(["finding", "downloading", "checking", "unpacking"]);

export function readInstall(v: unknown): MachineInstall | null {
  const r = rec(v);
  const id = str(r?.id);
  if (!r || !id || !INSTALL_STATES.has(r.state as string) || !(TOOL_NAMES as readonly string[]).includes(r.tool as string)) return null;
  const percent = num(r.percent);
  const version = str(r.version);
  const error = str(r.error);
  return {
    id,
    tool: r.tool as ToolName,
    state: r.state as MachineInstall["state"],
    at: num(r.at) ?? 0,
    ...(INSTALL_STEPS.has(r.step as string) ? { step: r.step as MachineInstall["step"] } : {}),
    ...(percent !== undefined && percent >= 0 && percent <= 100 ? { percent: Math.round(percent) } : {}),
    ...(version ? { version } : {}),
    ...(error ? { error } : {}),
  };
}

export function readMachine(v: unknown): Machine | null {
  const r = rec(v);
  const id = str(r?.id);
  const name = str(r?.name);
  if (!r || !id || !name || !STATES.has(r.state as MachineState)) return null;
  const tools = rec(r.tools) ?? {};
  const slots = Math.min(MAX_MACHINE_SLOTS, count(r.slots, 1));
  const machine: Machine = {
    id,
    name,
    kind: r.kind === "mac" ? "mac" : "cli",
    os: str(r.os) ?? "",
    state: r.state as MachineState,
    slots,
    recommended: Math.min(MAX_MACHINE_SLOTS, count(r.recommended, slots)),
    most: Math.min(MAX_MACHINE_SLOTS, count(r.most, MAX_MACHINE_SLOTS)),
    running: list(r.running, readRun),
    usedMin: count(r.usedMin),
    limitMin: count(r.limitMin),
    othersPerDay: count(r.othersPerDay),
    pauseNearPlan: r.pauseNearPlan !== false,
    tools: Object.fromEntries(
      TOOL_NAMES.map((t) => [t, TOOL_STATES.has(tools[t] as ToolState) ? (tools[t] as ToolState) : "missing"]),
    ) as Record<ToolName, ToolState>,
    folders: strings(r.folders),
    // Never on for a machine that is not the Mac app: only the Mac app can offer it.
    computerUse: r.kind === "mac" && r.computerUse === true,
    chats: list(r.chats, readMachineChat),
    canSignIn: strings(r.canSignIn).filter((t): t is ToolName => (TOOL_NAMES as readonly string[]).includes(t)),
    canInstall: strings(r.canInstall).filter((t): t is ToolName => (TOOL_NAMES as readonly string[]).includes(t)),
  };
  if (r.paused === "limit" || r.paused === "plan") machine.paused = r.paused;
  for (const key of ["since", "connectedAt", "lastEndedAt", "raisedMin"] as const) {
    const n = num(r[key]);
    if (n !== undefined) machine[key] = n;
  }
  const code = str(r.code);
  if (code) machine.code = code;
  const signIn = readSignIn(r.signIn);
  if (signIn) machine.signIn = signIn;
  const install = readInstall(r.install);
  if (install) machine.install = install;
  return machine;
}

export function readPairing(v: unknown): Pairing | null {
  const r = rec(v);
  const code = str(r?.code);
  if (!r || !code) return null;
  return {
    code,
    name: str(r.name) ?? "",
    os: str(r.os) ?? "",
    tools: strings(r.tools).filter((t): t is ToolName => (TOOL_NAMES as readonly string[]).includes(t)),
    at: num(r.at) ?? 0,
  };
}

export function readMachinesPage(v: unknown): MachinesPage | null {
  const r = rec(v);
  if (!r) return null;
  const cloud = rec(r.cloud) ?? {};
  const chatPeople = strings(r.chatPeople);
  return {
    machines: list(r.machines, readMachine),
    cloud: { slots: count(cloud.slots), busy: count(cloud.busy) },
    pairing: readPairing(r.pairing),
    ...(chatPeople.length ? { chatPeople } : {}),
  };
}

export function readPlace(v: unknown): SlotPlace | null {
  const r = rec(v);
  const key = str(r?.key);
  if (!r || !key || (r.kind !== "cloud" && r.kind !== "machine")) return null;
  const place: SlotPlace = { key, kind: r.kind, name: str(r.name) ?? key, slots: Math.min(MAX_MACHINE_SLOTS, count(r.slots)) };
  if (r.machineKind === "mac" || r.machineKind === "cli") place.machineKind = r.machineKind;
  if (r.offline === true) place.offline = true;
  const since = num(r.since);
  if (since !== undefined) place.since = since;
  return place;
}

export function readPlaces(v: unknown): SlotPlace[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const places = list(v, readPlace);
  return places.length ? places : undefined;
}

export function readAsk(v: unknown): MachineAsk | null {
  const r = rec(v);
  const job = str(r?.job);
  const who = str(r?.who);
  if (!r || !job || !who) return null;
  return {
    job,
    who,
    title: str(r.title) ?? "",
    machine: str(r.machine) ?? "",
    machineName: str(r.machineName) ?? str(r.machine) ?? "",
    tool: r.tool === "codex" ? "codex" : "claude",
    ...(str(r.folder) ? { folder: str(r.folder) } : {}),
    slotsFor: count(r.slotsFor),
    at: num(r.at) ?? 0,
  };
}

export const readAsks = (v: unknown): MachineAsk[] => list(v, readAsk);
