/**
 * The machine screens on the gateway's own computer routes
 * (`apps/mcp/src/machines/appRoutes.js`, docs/decisions/texting-assistant/machines.md):
 * `POST /machines/app/{list,set,disconnect,lend,unlend,answer}` with the app's
 * own session, and pairing approved in the control plane
 * (`approveTexMachinePairing`). Pure translation both ways, so the screens keep
 * the page's shapes (`texMachineTypes.ts`) and every answer still goes through
 * the page's defensive reader.
 *
 * - A computer the person does not run (another member's, in a shared
 *   workspace) arrives as a glimpse with no settings and is left off: the
 *   screens are for computers the person runs.
 * - The person's own texts are the rule `texts-<ownerId>`; a group chat is
 *   `group-<first 58 hex of its key>`, the page's group key.
 * - People are named by handle (`@bo`): a rule keeps user ids, read against the
 *   chat's people; an id the page cannot name is left off rather than guessed.
 */

import { readMachinesPage } from "./texMachineRead";
import type { MachineAction, MachineAsk, MachinesPage, MachineWho, Pairing, ToolName, ToolState } from "./texMachineTypes";

type Rec = Record<string, unknown>;

const rec = (v: unknown): Rec | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const MIN = 60_000;
const TOOLS: readonly ToolName[] = ["claude", "codex"];
const OS_LABEL: Record<string, string> = { macos: "macOS", linux: "Linux", windows: "Windows" };
const GROUP_KEY = /^[0-9a-f]{64}$/;

export type MachineRoute = "list" | "set" | "disconnect" | "lend" | "unlend" | "answer" | "raise" | "chat-people";

/** A group chat's people with their ids (`/machines/app/chat-people`): a rule names people by id, the page by handle. */
export type ChatPeople = ReadonlyMap<string, readonly { userId: string; handle: string }[]>;

/** How the page names a person: their handle. */
export const handleLabel = (handle: string): string => `@${handle}`;

export function machineAppUrl(mcpEndpoint: string, route: MachineRoute): string | null {
  try {
    const parsed = new URL(mcpEndpoint);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return `${parsed.origin}/machines/app/${route}`;
  } catch {
    return null;
  }
}

/** The rule key a page chat is under on a computer: the owner's own texts, or a group by its key. */
export function ruleKeyOf(chat: string, ownerId: string): string | null {
  if (chat === "me") return `texts-${ownerId}`;
  return GROUP_KEY.test(chat) ? `group-${chat.slice(0, 58)}` : null;
}

/** The page chat a rule key is for, matched against the chats the page knows. */
function chatOfRule(rule: string, ownerId: string, groupKeys: readonly string[]): string | null {
  if (rule === `texts-${ownerId}`) return "me";
  if (!rule.startsWith("group-")) return null;
  const prefix = rule.slice("group-".length);
  return groupKeys.find((k) => k.slice(0, 58) === prefix) ?? null;
}

function toolState(name: ToolName, enabled: boolean, facts: unknown[]): ToolState {
  const fact = facts.map(rec).find((f) => typeof f?.name === "string" && (f.name as string).toLowerCase().startsWith(name));
  if (!fact || fact.installed !== true) return "missing";
  if (fact.signedIn !== true) return "installed";
  return enabled ? "signedIn" : "off";
}

function whoOf(v: unknown, people: readonly { userId: string; handle: string }[]): MachineWho {
  if (v === "everyone") return "everyone";
  if (!Array.isArray(v)) return "me";
  const named = v.map((id) => people.find((p) => p.userId === id)).filter((p): p is { userId: string; handle: string } => p !== undefined);
  return named.length ? named.map((p) => handleLabel(p.handle)) : "me";
}

/** The day a time falls on in a zone, as the gateway keys a raise (`dayOf` in `workspaceStore/machines.js`). */
function dayOf(at: number, timeZone: unknown): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: typeof timeZone === "string" && timeZone ? timeZone : "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

/** One computer from the list, in the page's shape (still read by `readMachine` after), or null for a glimpse. */
function machineOf(raw: unknown, now: number, chats: { keys: string[]; names: Map<string, string>; people: ChatPeople }): Rec | null {
  const m = rec(raw);
  if (!m || m.runs !== true || !str(m.id)) return null;
  const ownerId = str(m.ownerId) ?? "";
  const limits = rec(m.limits) ?? {};
  const used = rec(m.used) ?? {};
  const status = rec(m.status);
  const facts = rec(m.facts);
  const counts = rec(m.slotCounts);
  const enabled = Array.isArray(m.tools) ? (m.tools as unknown[]) : [];
  const toolFacts = Array.isArray(status?.tools) ? (status?.tools as unknown[]) : Array.isArray(facts?.tools) ? (facts?.tools as unknown[]) : [];
  const usedMin = Math.floor((num(used.todayMs) ?? 0) / MIN);
  const limitMin = Math.floor((num(limits.dayMs) ?? 0) / MIN);
  // Today's raise ("2 more hours today") counts only on the day it was given, in the owner's zone.
  const raise = rec(m.raise);
  const raisedMin = raise && raise.day === dayOf(now, limits.timeZone) ? Math.floor((num(raise.extraMs) ?? 0) / MIN) : 0;
  const pausedUntil = num(m.pausedUntil);
  const online = m.online === true;
  const state = !online ? "offline" : status?.ready === false ? "notReady" : (pausedUntil ?? 0) > now || (limitMin > 0 && usedMin >= limitMin + raisedMin) ? "paused" : "online";
  const slots = num(limits.slots) ?? 1;
  const ruleChats: Rec[] = [];
  for (const [key, value] of Object.entries(rec(m.chats) ?? {})) {
    const chat = chatOfRule(key, ownerId, chats.keys);
    const rule = rec(value);
    if (chat === null || rule === null) continue;
    ruleChats.push({
      key: chat,
      name: chat === "me" ? "Just you" : chats.names.get(chat) ?? str(rule.name) ?? "A group chat",
      who: chat === "me" ? "me" : whoOf(rule.who, chats.people.get(chat) ?? []),
      askFirst: rule.askFirst !== false,
      slots: chat === "me" ? slots : num(rule.slots) ?? 1,
    });
  }
  // The owner's own texts always reach their own computer, rule or none.
  if (!ruleChats.some((c) => c.key === "me")) ruleChats.unshift({ key: "me", name: "Just you", who: "me", askFirst: false, slots });
  const os = str(m.os) ?? "";
  return {
    id: m.id,
    name: str(m.name) ?? "Computer",
    // The gateway does not say how it connected; a Mac is taken as the Mac app, which is how most connect.
    kind: os === "macos" ? "mac" : "cli",
    os: OS_LABEL[os] ?? "",
    state,
    ...(state === "paused" ? { paused: (pausedUntil ?? 0) > now ? "plan" : "limit" } : {}),
    ...(state === "offline" && num(m.seenAt) !== undefined ? { since: m.seenAt } : {}),
    slots,
    recommended: num(counts?.recommended) ?? slots,
    most: num(counts?.most) ?? slots,
    running: (Array.isArray(m.running) ? (m.running as unknown[]) : []).map(rec).filter((r): r is Rec => r !== null).map((r) => ({ job: r.jobId, title: str(r.title) ?? "", startedAt: num(r.startedAt) ?? 0 })),
    usedMin,
    limitMin,
    ...(raisedMin > 0 ? { raisedMin } : {}),
    othersPerDay: num(limits.othersRunsPerDay) ?? 0,
    pauseNearPlan: limits.pauseNearPlanLimit !== false,
    tools: Object.fromEntries(TOOLS.map((t) => [t, toolState(t, enabled.includes(t), toolFacts)])),
    folders: Array.isArray(m.folders) ? m.folders : [],
    computerUse: m.computerUse === true,
    chats: ruleChats,
  };
}

/** The asks waiting on the person's computers, newest first, for the home's cards and the approval screen. */
export function asksOf(list: unknown): MachineAsk[] {
  const out: MachineAsk[] = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const m = rec(raw);
    if (!m || m.runs !== true || !str(m.id)) continue;
    for (const a of Array.isArray(m.asks) ? (m.asks as unknown[]) : []) {
      const ask = rec(a);
      const id = str(ask?.id);
      if (!ask || !id) continue;
      const chatName = str(ask.chatName);
      out.push({
        // The answer needs the computer and the ask; both ride in the job id the card sends back.
        job: `${m.id as string}/${id}`,
        who: str(ask.askerHandle) ? handleLabel(str(ask.askerHandle) as string) : chatName ? `Someone in ${chatName}` : "Someone",
        title: str(ask.title) ?? "A job",
        machine: m.id as string,
        machineName: str(m.name) ?? "computer",
        tool: "claude",
        slotsFor: num(rec(rec(m.chats)?.[str(ask.chat) ?? ""])?.slots) ?? 0,
        at: num(ask.askedAt) ?? 0,
      });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/** The list answer as the page's machines, with the pairing a code in the address names. */
export function machinesPageOf(body: unknown, options: { now: number; groupChats?: { key: string; name: string }[]; pairing?: Pairing | null; people?: ChatPeople }): MachinesPage | null {
  const r = rec(body);
  if (!r || r.ok !== true || !Array.isArray(r.machines)) return null;
  const groups = (options.groupChats ?? []).filter((c) => GROUP_KEY.test(c.key));
  const chats = { keys: groups.map((c) => c.key), names: new Map(groups.map((c) => [c.key, c.name])), people: options.people ?? new Map() };
  const machines = (r.machines as unknown[]).map((m) => machineOf(m, options.now, chats)).filter((m): m is Rec => m !== null);
  return readMachinesPage({ machines, cloud: { slots: 0, busy: 0 }, pairing: options.pairing ?? null });
}

/** One route call for a page action, or a refusal the page shows; `machine.pair` is the control plane's, not here. */
export type MachineCall = { route: MachineRoute; body: Rec } | { refused: string } | { pair: { code: string; approve: boolean } };

/** A page action as the gateway call that does it. `machine` is the computer as the gateway listed it. */
export function machineCallOf(action: MachineAction, machine: (id: string) => Rec | null, people: ChatPeople = new Map()): MachineCall {
  switch (action.type) {
    case "machine.pair":
      return { pair: { code: action.code, approve: action.approve } };
    case "machine.disconnect":
      return { route: "disconnect", body: { machineId: action.id } };
    case "machine.raise":
      // Today only: the gateway adds it to today's limit and drops it tomorrow.
      return { route: "raise", body: { machineId: action.id, minutes: Math.max(1, Math.min(24 * 60, Math.round(action.minutes))) } };
    case "job.allow": {
      const [machineId, askId] = action.job.split("/");
      if (!machineId || !askId) return { refused: "unknown_ask" };
      return { route: "answer", body: { machineId, askId, yes: action.mode !== "decline", always: action.mode === "always" } };
    }
    case "machine.set": {
      const m = machine(action.id);
      if (!m) return { refused: "unknown_machine" };
      const v = action.values;
      const patch: Rec = {};
      const limits: Rec = { ...(rec(m.limits) ?? {}) };
      let limitsChanged = false;
      const setLimit = (key: string, value: number | boolean | undefined) => {
        if (value === undefined) return;
        limits[key] = value;
        limitsChanged = true;
      };
      setLimit("slots", v.slots);
      setLimit("dayMs", v.limitMin === undefined ? undefined : Math.max(0, v.limitMin * MIN));
      setLimit("othersRunsPerDay", v.othersPerDay);
      setLimit("pauseNearPlanLimit", v.pauseNearPlan);
      if (limitsChanged) patch.limits = limits;
      if (v.claude !== undefined || v.codex !== undefined) {
        const tools = new Set(Array.isArray(m.tools) ? (m.tools as string[]) : []);
        for (const t of TOOLS) {
          const on = t === "claude" ? v.claude : v.codex;
          if (on === true) tools.add(t);
          if (on === false) tools.delete(t);
        }
        patch.tools = [...tools];
      }
      if (v.computerUse !== undefined) patch.computerUse = v.computerUse;
      if (v.folders !== undefined) patch.folders = v.folders;
      return { route: "set", body: { machineId: action.id, patch } };
    }
    case "machine.chat": {
      const m = machine(action.id);
      const rule = m ? ruleKeyOf(action.chat, str(m.ownerId) ?? "") : null;
      if (!m || rule === null) return { refused: "unknown_chat" };
      const chats = rec(m.chats) ?? {};
      const next: Rec = { ...(rec(chats[rule]) ?? {}) };
      const v = action.values;
      if (Array.isArray(v.who)) {
        // Each handle read back to its id in this chat; one the chat's people don't have is refused, never dropped.
        const known = people.get(action.chat) ?? [];
        const ids = v.who.map((h) => known.find((p) => handleLabel(p.handle) === h || p.handle === h)?.userId);
        if (ids.length === 0 || ids.some((id) => id === undefined)) return { refused: "unknown_person" };
        next.who = ids;
      } else if (v.who !== undefined) next.who = v.who === "everyone" ? "everyone" : "owner";
      if (v.askFirst !== undefined) next.askFirst = v.askFirst;
      if (v.slots !== undefined) next.slots = v.slots;
      return { route: "set", body: { machineId: action.id, patch: { chats: { ...chats, [rule]: next } } } };
    }
    case "machine.chat.add":
      return GROUP_KEY.test(action.chat) ? { route: "lend", body: { machineId: action.id, chat: action.chat, who: "owner", askFirst: true } } : { refused: "unknown_chat" };
    case "machine.chat.remove":
      return GROUP_KEY.test(action.chat) ? { route: "unlend", body: { machineId: action.id, chat: action.chat } } : { refused: "unknown_chat" };
  }
}
