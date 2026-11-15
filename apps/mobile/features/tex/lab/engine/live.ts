/**
 * Live mode (Dev2, 2026-11-15): a saved Lab version is a draft that a staff member in the Lab and an AI client over
 * the MCP's `tex_dev` tool edit at the same time. The page keeps `synced`, the draft's unfolded graph as the server
 * last confirmed it at `rev`; an edit is sent as the small edits between that and the page's graph (`diffGraphs`),
 * with `rev` as its base, and the server answers ok, "someone changed that first", or bad. The server's graph comes
 * back through the reactive version list (`store.ts` calls `onRemote`), and is taken when nothing local is waiting,
 * or rebased under the local edits when something is.
 *
 * Everything is diffed and applied on UNFOLDED graphs; the shown graph is folded again at the current focus.
 * `texLabOps.cjs` is the one set of rules the Lab, the control plane and the gateway share.
 */
import { applyOps, diffGraphs, keysOf } from "@context/shared/src/texLabOps.cjs";
import type { LabGraphJson, LabOp } from "@context/shared/src/texLabOps.d.cts";
import type { LabGraph } from "../types";
import { unfoldGroups } from "./groups";
import { clone, emit, isMain, lab, saveVersion, shownGraph, toast } from "./state";

export type Answer =
  | { status: "ok"; rev: number; said: string[]; others: unknown[] }
  | { status: "conflict"; rev: number; keys: string[]; now: Record<string, unknown>; others: unknown[] }
  | { status: "bad_request"; error: string };
export type Send = (versionId: string, baseRev: number, ops: string) => Promise<Answer>;
/** The Run tab's test picks and areas for a live draft, sent whole (`texLabDrafts.setRunSetup`). */
export type SendSetup = (versionId: string, picks: string, areas: string | null) => Promise<{ status: string; rev?: number; error?: string }>;
/** One revision of a draft: who, through which door, what it said, and the keys it touched (`n:<step>`, `e:<from>><to>>…`). */
export type Change = { rev: number; who: string; via: string; said: string[]; at: number; keys?: string[] };
export type Feed = { rev: number; live: { client: string; who: string; at: number } | null; changes: Change[] };
export type Hl = { by: "ai" | "lab"; until: number };

export const DEBOUNCE_MS = 400;
export const HIGHLIGHT_MS = 3000;
export const LIVE_MS = 10 * 60_000;

type Remote = { rev: number; graph: LabGraph };
export const live = {
  id: null as string | null,
  /** The draft's unfolded graph at `rev`, as the server last confirmed it; null when this version is not live (main, or not saved yet). */
  synced: null as LabGraph | null,
  rev: 0,
  /** The first revision of the change feed to read (a little before the one opened). */
  since: 0,
  inflight: false,
  /** Something merged (or refused) on the server that the page has not read yet: nothing is sent until `needRev` arrives. */
  stale: false,
  needRev: 0,
  /** The server's graph replaces the page's, local edits and all (a conflict). */
  discard: false,
  remote: null as Remote | null,
  timer: null as ReturnType<typeof setTimeout> | null,
  send: null as Send | null,
  sendSetup: null as SendSetup | null,
  hl: {} as Record<string, Hl>,
  feed: { rev: 0, live: null, changes: [] } as Feed,
};
export const setSender = (f: Send | null) => {
  live.send = f;
};
export const setSetupSender = (f: SendSetup | null) => {
  live.sendSetup = f;
};

/** A version's Run tab setup (its picks and areas) as one comparable value. */
export const setupOf = (v: { picks?: Record<string, string[]> | null; areas?: string[] | null } | undefined) => JSON.stringify([v?.picks || {}, v?.areas ?? null]);
const savedOf = () => lab.versions.find((v) => v.id === lab.cur.id);
/** Has the page's Run tab setup changed from the saved draft's? (A change of picks or areas is not a graph edit.) */
export const setupPending = () => {
  const saved = savedOf();
  return !!saved && setupOf(saved) !== setupOf(lab.cur);
};
/** Forget everything (a test, or leaving the Lab). */
export function resetLive() {
  if (live.timer) clearTimeout(live.timer);
  Object.assign(live, { id: null, synced: null, rev: 0, since: 0, inflight: false, stale: false, needRev: 0, discard: false, remote: null, timer: null, hl: {}, feed: { rev: 0, live: null, changes: [] } });
}

/** Is the open version a live draft: saved, not main, and read from the server? */
export const isLive = () => !isMain() && live.id === lab.cur.id && live.synced !== null;

const unfold = (g: LabGraph): LabGraph => unfoldGroups(clone(g));
const asJson = (g: LabGraph) => g as unknown as LabGraphJson;
const asGraph = (g: LabGraphJson) => g as unknown as LabGraph;

/** The edits between the server's draft and the page's graph: what the next request carries. */
export function pendingOps(synced: LabGraph, cur: LabGraph): LabOp[] {
  return diffGraphs(asJson(synced), asJson(unfold(cur)));
}

/** The steps an edit touched: `n:id:field` and `e:from>to>mode` name them. */
export function stepsOf(ops: LabOp[]): string[] {
  const ids = new Set<string>();
  for (const k of ops.flatMap(keysOf)) {
    if (k === "*") continue;
    if (k.startsWith("n:")) ids.add(k.split(":")[1]);
    else if (k.startsWith("e:")) k.slice(2).split(">").slice(0, 2).forEach((i) => ids.add(i));
  }
  return [...ids];
}

/** What the canvas draws a step as: itself, or the folded box it is inside. */
function shownId(unfolded: LabGraph, id: string): string | null {
  if (lab.cur.graph.nodes.some((n) => n.id === id)) return id;
  const g = unfolded.nodes.find((n) => n.id === id)?.group;
  return g && lab.cur.graph.nodes.some((n) => n.id === g) ? g : null;
}

/** Highlight the steps an edit changed, for a few seconds (AI colour for an AI's change). */
export function highlight(ids: string[], by: Hl["by"], now = Date.now()) {
  for (const id of ids) live.hl[id] = { by, until: now + HIGHLIGHT_MS };
  setTimeout(() => {
    const t = Date.now();
    for (const [id, h] of Object.entries(live.hl)) if (h.until <= t) delete live.hl[id];
    emit();
  }, HIGHLIGHT_MS + 50);
}
/** The canvas's class for a step the other side just changed. */
export const hlClass = (id: string, now = Date.now()) => {
  const h = live.hl[id];
  return h && h.until > now ? " hl hl-" + h.by : "";
};

/** Start (or stop) treating the open version as a draft, from what the list says about it. */
export function bind(id: string, graph: LabGraph | null, rev: number) {
  if (live.timer) clearTimeout(live.timer);
  Object.assign(live, { id, synced: graph && id !== "main" ? unfold(graph) : null, rev, since: Math.max(0, rev - 30), inflight: false, stale: false, discard: false, remote: null, timer: null, hl: {}, feed: { rev: 0, live: null, changes: [] } });
}

/** Called after every state change: bind to a newly opened version, and send a batch soon after an edit. */
export function tick() {
  if (lab.cur.id !== live.id) {
    const saved = lab.versions.find((v) => v.id === lab.cur.id);
    bind(lab.cur.id, saved && !isMain() && saved.rev !== undefined ? saved.graph : null, saved?.rev ?? 0);
  }
  if (isLive() && lab.dirty && !live.timer && !live.inflight && !live.stale) live.timer = setTimeout(() => void flush(), DEBOUNCE_MS);
}

const who = () => {
  const c = live.feed.changes.filter((x) => x.via !== "lab").at(-1);
  return c?.via ?? live.feed.live?.client ?? "Someone";
};
const say = (keys: string[]) => {
  const names = [...new Set(keys.map((k) => (k.startsWith("n:") ? k.split(":").slice(1).join(" ") : k.startsWith("e:") ? "a wire" : "the graph")))];
  return names.slice(0, 2).join(" and ") || "the same thing";
};

/** Send what changed since the last confirmed draft. One request at a time; edits made meanwhile go in the next. */
export async function flush(): Promise<void> {
  live.timer = null;
  if (live.inflight || !isLive() || live.stale || !live.send) return;
  const base = live.synced!;
  const ops = pendingOps(base, lab.cur.graph);
  if (!ops.length) {
    // The Run tab's picks and areas are not graph edits: they are sent on their own (they used to be dropped here).
    if (await flushSetup()) return;
    // Only a rename can be left: the name is not an edit, so it keeps its Save.
    const saved = lab.versions.find((v) => v.id === lab.cur.id);
    if (lab.dirty && saved && saved.name === lab.cur.name) {
      lab.dirty = false;
      emit();
    }
    return;
  }
  live.inflight = true;
  const id = live.id!;
  let ans: Answer;
  try {
    ans = await live.send(id, live.rev, JSON.stringify(ops));
  } catch (e) {
    live.inflight = false;
    toast(e instanceof Error && e.message && !/Server Error/i.test(e.message) ? e.message : "Couldn't reach the shared draft");
    return;
  }
  live.inflight = false;
  if (live.id !== id) return;
  if (ans.status === "ok") {
    try {
      live.synced = asGraph(applyOps(asJson(base), ops).graph);
    } catch {
      live.synced = unfold(lab.cur.graph);
    }
    live.rev = ans.rev;
    if (ans.others.length) {
      live.stale = true;
      live.needRev = ans.rev;
    }
    lab.dirty = pendingOps(live.synced, lab.cur.graph).length > 0 || lab.cur.name !== lab.versions.find((v) => v.id === id)?.name || setupPending();
  } else if (ans.status === "conflict") {
    toast(who() + " changed " + say(ans.keys) + " first; showing theirs");
    Object.assign(live, { stale: true, needRev: ans.rev, discard: true });
  } else {
    // The server will never take these edits: go back to what it has.
    toast(ans.error);
    lab.cur.graph = shownGraph(unfold(live.synced!), lab.cfocus);
    lab.dirty = false;
  }
  reconcile();
  emit();
}

/**
 * Send the Run tab's setup when it changed from the saved draft's: answers whether it was the thing to send. The list's
 * copy of the draft takes the new setup at once, so it is not sent twice before the reactive list brings it back.
 */
async function flushSetup(): Promise<boolean> {
  if (!setupPending() || !live.sendSetup) return false;
  const id = live.id!;
  const saved = savedOf()!;
  const picks = JSON.stringify(lab.cur.picks || {});
  const areas = lab.cur.areas ? JSON.stringify(lab.cur.areas) : null;
  live.inflight = true;
  let ans: Awaited<ReturnType<SendSetup>>;
  try {
    ans = await live.sendSetup(id, picks, areas);
  } catch (e) {
    live.inflight = false;
    toast(e instanceof Error && e.message && !/Server Error/i.test(e.message) ? e.message : "Couldn't reach the shared draft");
    return true;
  }
  live.inflight = false;
  if (live.id !== id) return true;
  if (ans.status === "ok") {
    saved.picks = JSON.parse(picks);
    saved.areas = areas ? JSON.parse(areas) : null;
  } else {
    // The server will never take this setup: go back to the saved one.
    toast(ans.error ?? "Couldn't save the run's setup");
    lab.cur.picks = clone(saved.picks);
    lab.cur.areas = saved.areas ? clone(saved.areas) : null;
  }
  lab.dirty = pendingOps(live.synced!, lab.cur.graph).length > 0 || lab.cur.name !== saved.name;
  reconcile();
  emit();
  return true;
}

/** Save (the button, Ctrl+S): a live draft sends its edits first, then keeps a rename; any other version saves whole. */
export async function saveNow() {
  if (!isLive()) return saveVersion();
  await flush();
  if (!live.inflight && lab.dirty) await saveVersion();
}

/** The reactive list brought this draft's graph at `rev`. */
export function onRemote(id: string, rev: number, graph: LabGraph) {
  if (id !== live.id) return;
  if (live.synced === null && !isMain()) {
    live.synced = unfold(graph);
    live.rev = rev;
    live.since = Math.max(0, rev - 30);
    return;
  }
  if (rev <= live.rev && !(live.stale && rev >= live.needRev)) return;
  live.remote = { rev, graph };
  reconcile();
}

/** Take the server's newer draft when no request is out: as it is, or with the page's unsent edits rebased onto it. */
export function reconcile() {
  const r = live.remote;
  if (!r || live.inflight || !live.synced) return;
  if (r.rev <= live.rev && !(live.stale && r.rev >= live.needRev)) {
    live.remote = null;
    return;
  }
  if (live.stale && r.rev < live.needRev) return;
  const next = unfold(r.graph);
  const local = live.discard ? [] : pendingOps(live.synced, lab.cur.graph);
  let merged = next;
  if (local.length) {
    try {
      merged = asGraph(applyOps(asJson(next), local).graph);
    } catch {
      merged = next;
      toast("Your last edits no longer fit the draft; showing the saved one");
      local.length = 0;
    }
  }
  const changed = stepsOf(diffGraphs(asJson(live.synced), asJson(next)));
  const byAi = live.feed.changes.some((c) => c.rev > live.rev && c.via !== "lab");
  const sel = lab.sel;
  lab.cur.graph = shownGraph(merged, lab.cfocus);
  if (sel?.t === "node" && !lab.cur.graph.nodes.some((n) => n.id === sel.id)) lab.sel = null;
  lab.cur.rev = r.rev;
  lab.dirty = local.length > 0;
  highlight(changed.map((i) => shownId(next, i)).filter((i): i is string => !!i), byAi ? "ai" : "lab");
  Object.assign(live, { synced: next, rev: r.rev, remote: null, stale: false, discard: false });
  emit();
}

/** Remember the feed the query gave, and read a newer draft that was waiting on it. */
export function setFeed(f: Feed) {
  live.feed = f;
}

// ── What the top bar and the Changes list say ──

/** The AI client in the draft right now (inside ten minutes), else null. */
export const aiClient = (now = Date.now()) => (live.feed.live && now - live.feed.live.at < LIVE_MS ? live.feed.live.client : null);

export const ago = (at: number, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 45 ? "just now" : s < 3600 ? Math.round(s / 60) + " min ago" : s < 86400 ? Math.round(s / 3600) + " h ago" : Math.round(s / 86400) + " d ago";
};

/** "You" for this person's own Lab edits; the AI client's name for its edits; else the other person's handle. */
export const whoLabel = (c: Pick<Change, "who" | "via">, myHandle: string | null) => (c.via !== "lab" ? c.via : myHandle && c.who === myHandle ? "You" : c.who);
