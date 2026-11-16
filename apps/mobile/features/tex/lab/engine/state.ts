/**
 * The Lab's one state, as the artifact kept it in page globals: the versions,
 * the one being edited (`cur`), the selection, the view, the focused step and
 * the rest. Every view reads it through `useLab()` (`../store.ts`) and changes
 * it through the actions here; each action ends in `emit()`, the port of the
 * artifact's `renderAll()`.
 *
 * Kept as a module singleton on purpose: the artifact's functions read these
 * as globals, and porting them with the same names and the same reads is what
 * keeps the Lab "EXACTLY like the artifact" (Dev2, 2026-11-13).
 */
import { groupsOf, mainGraph } from "../data/graph";
import { BASE_MODELS } from "../data/models";
import type { LabCase, LabGraph, LabModel, LabVersion, Selection, Tool, View } from "../types";
import { foldAround } from "./groups";
import type { ChatLine, MyText, ReplayNow } from "./mine";
import type { TurnPrompt } from "./promptAt";
import type { IoLine, RealTimes } from "./realTimes";

export const clone = <T,>(o: T): T => JSON.parse(JSON.stringify(o));

export const MAIN: LabVersion = { id: "main", name: "main", graph: mainGraph(), picks: null, results: [], authorId: null };

export type LabState = {
  versions: LabVersion[];
  cur: LabVersion;
  dirty: boolean;
  sel: Selection;
  scn: string;
  view: View;
  tool: Tool;
  cfocus: string | null;
  fArea: string | null;
  modFocus: string | null;
  caseEdits: Record<string, LabCase>;
  logRows: Record<string, { calls: number; wall: number; prodMs: number; out: number; api: boolean }> | null;
  toolStats: Record<string, { calls: number; ms: number[]; err: number; why: Record<string, number> }> | null;
  undoStack: string[];
  addCtxOpen: boolean;
  tArea: string;
  tQ: string;
  ownText: string;
  /** What started the traced moment: "text" (a text arriving), "checkin", "routine" or "notify". */
  ownFrom: string;
  /** Sidebar hidden on wide screens (the artifact's `#side[hidden]`). */
  sideHidden: boolean;
  /** The Lab's sidebar folded to its icons (mockup W21NekNf2vtnFLXXzAmp7N, 2026-11-16). */
  navMin: boolean;
  /** Sidebar drawn over the page on a phone (the artifact's `.sideopen`). */
  sideOpen: boolean;
  /** The workspace browser or module viewer, when open: what the artifact's `#viewer` showed. */
  viewer: { kind: "module"; key: string } | { kind: "diff"; key: string } | { kind: "ws"; ws: string; at?: string } | null;
  toastText: string | null;
  myId: string | null;
  /** Each version author's name, as the shared list gives it (a handle, else "Someone"). */
  names: Record<string, string>;
  sync: string;
  /** Who the test cases run as: the bench's invented person, or the signed-in person's own texts, replayed read only (`mine.ts`). */
  tester: "bench" | "me";
  /** The signed-in person, as the Lab's "You": their handle, name and workspaces; null until known. */
  me: { handle: string; name: string; workspaces: Array<{ n: string; kind: string; role: string }> } | null;
  /** The chats they can replay: their one-to-one ("me") and each group chat they're in, from the Tex page. */
  myChats: Array<{ key: string; name: string; people?: number }> | null;
  /** The chat whose texts are read: "me" or a group's key. */
  myChat: string;
  /** That chat's whole conversation so far, oldest first. */
  myLines: ChatLine[];
  /**
   * The Lab, where a version is changed and a real or test chat is played (Replay is part of it since Lab live
   * sandbox, Dev2 2026-11-16: `engine/prodRun.ts`); or Testing, where the Training, Dev and Test conversations are
   * curated and labelled (Dev2, 2026-11-15).
   */
  mode: "lab" | "testing";
  /** In Testing, the conversation open: its id, or null for the first one. */
  setChat: string | null;
  /** The real text an address points at: its entry id (an old Replay link's moment). */
  moment: string | null;
  /** Their texts read so far, newest first; null before the first read, "failed" when it could not be read. */
  myTexts: MyText[] | null | "failed";
  /** The ledger seq to read older texts before, when there are older ones. */
  myOlder: number | null;
  /** The texts picked to replay, by entry id, and the notes each one's turn read. */
  myPicks: string[];
  myReads: Record<string, string[]>;
  /** What a version said now for each replayed text, from a pasted "## Lab replay": this tab only, never saved. */
  myNow: Record<string, ReplayNow>;
  /** The measured step times of the own text the canvas traces, when it is one the person sent (`realTimes.ts`). */
  real: { text: string; times: RealTimes; io?: Record<string, IoLine[]>; turn?: string; prompt?: TurnPrompt | null } | null;
  /** A draft's changes on the graph (Dev2, 2026-11-15): off, marked, or marked with the base's ghost (`changeMarks.ts`). */
  chg: "off" | "marks" | "ghost";
  /** Compared with main, or with the draft before revision N. */
  chgVs: "main" | number;
  /** The draft as it was before revision `rev`, read from the server for "last rev". */
  revBase: { rev: number; graph: LabGraph } | null;
  /**
   * How fast every playback runs, a text you send included (Dev2, 2026-11-16, Lab live sandbox mockup
   * https://claude.ai/artifact/XtEn67XPWMTFVUBYanYLG5): ¼×, ½×, 1×, 2× or 4×, ½× at first, kept for the browser session.
   * Tex itself always runs at real speed; a playback of a text still running trails it and never shows a step early.
   */
  speed: PlaySpeed;
  /**
   * A node was clicked: the step panel stays on it. False (the default) it follows the step running in the playing or
   * live test text; "Follow running" in the panel sets it back.
   */
  pin: boolean;
  /** The step panel's card ("run" = Run details, "set" = Settings; null picks Run details when a text has run) and its Run details tab. */
  card: "run" | "set" | null;
  runTab: "sum" | "out" | "in" | "think" | "calls";
};

export const PLAY_SPEEDS = [0.25, 0.5, 1, 2, 4] as const;
export type PlaySpeed = (typeof PLAY_SPEEDS)[number];
const SPEED_KEY = "texLab.speed";
/** The speed kept for this browser session, or ½×. */
export function savedSpeed(): PlaySpeed {
  try {
    const v = Number(sessionStorage.getItem(SPEED_KEY));
    return (PLAY_SPEEDS as readonly number[]).includes(v) ? (v as PlaySpeed) : 0.5;
  } catch {
    return 0.5;
  }
}
/** Sets the play speed for the session. */
export function setSpeed(v: PlaySpeed) {
  try {
    sessionStorage.setItem(SPEED_KEY, String(v));
  } catch {
    /* private window: the speed lasts until reload */
  }
  set({ speed: v });
}

export const lab: LabState = {
  versions: [MAIN],
  cur: clone(MAIN),
  dirty: false,
  sel: null,
  scn: "",
  view: "canvas",
  tool: "sel",
  cfocus: null,
  fArea: null,
  modFocus: null,
  caseEdits: {},
  logRows: null,
  toolStats: null,
  undoStack: [],
  addCtxOpen: false,
  tArea: "core",
  tQ: "",
  ownText: "",
  ownFrom: "text",
  sideHidden: false,
  navMin: false,
  sideOpen: false,
  viewer: null,
  toastText: null,
  myId: null,
  names: {},
  sync: "Shared with staff",
  tester: "bench",
  me: null,
  myChats: null,
  myChat: "me",
  myLines: [],
  mode: "lab",
  setChat: null,
  moment: null,
  myTexts: null,
  myOlder: null,
  myPicks: [],
  myReads: {},
  myNow: {},
  real: null,
  chg: "marks",
  chgVs: "main",
  revBase: null,
  speed: savedSpeed(),
  pin: false,
  card: null,
  runTab: "sum",
};

let version = 0;
const listeners = new Set<() => void>();
/** The artifact's `renderAll()`: every view reads the state again. */
export function emit() {
  version++;
  for (const l of listeners) l();
}
export const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const snapshot = () => version;

/** Fit the canvas to its steps on the next frame; the canvas registers how. */
let fitter: (() => void) | null = null;
export const setFitter = (f: (() => void) | null) => {
  fitter = f;
};
export const fit = () => fitter?.();

/** Saving, registered by the store once Convex is there (`../store.ts`). */
let saver: ((v: LabVersion) => Promise<void>) | null = null;
export const setSaver = (f: ((v: LabVersion) => Promise<void>) | null) => {
  saver = f;
};

export const G = (): LabGraph => lab.cur.graph;
/** The graph as the Lab shows it at this focus: every group folded, the focused group open (`groups.ts`). */
export const shownGraph = (g: LabGraph, focusId: string | null): LabGraph => foldAround(g, focusId, groupsOf(g));
export const node = (id: string, g: LabGraph = G()) => g.nodes.find((n) => n.id === id);
export const isMain = () => lab.cur.id === "main";

let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function toast(t: string) {
  lab.toastText = t;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    lab.toastText = null;
    emit();
  }, 2600);
  emit();
}

/** A version can add its own models; they live in its graph like modules do. */
function customModel(k: string): LabModel | undefined {
  for (const g of [lab.cur.graph, ...lab.versions.map((v) => v.graph)]) if (g?.models?.[k]) return g.models[k];
  return undefined;
}
export const MODELS: Record<string, LabModel> = new Proxy({} as Record<string, LabModel>, {
  get: (_, k) => (typeof k !== "string" ? undefined : BASE_MODELS[k] || customModel(k)),
  ownKeys: () => Reflect.ownKeys({ ...BASE_MODELS, ...(G().models || {}) }),
  getOwnPropertyDescriptor: (_, k) => ({ enumerable: true, configurable: true, value: typeof k === "string" ? BASE_MODELS[k] || customModel(k) : undefined }),
});

/** An edit to main makes your own copy first, the way a shared design file duplicates. */
export function edit(fn: () => void) {
  if (isMain()) forkFromMain();
  lab.undoStack.push(JSON.stringify(lab.cur.graph));
  if (lab.undoStack.length > 60) lab.undoStack.shift();
  fn();
  lab.dirty = true;
  emit();
}

export function forkFromMain() {
  const names = new Set(lab.versions.map((v) => v.name));
  let nm = "My version";
  let i = 1;
  while (names.has(nm)) nm = "My version " + ++i;
  const nv = clone(lab.cur);
  nv.id = "v" + Date.now().toString(36);
  nv.name = nm;
  nv.authorId = lab.myId;
  nv.results = [];
  nv.createdAt = Date.now();
  lab.cur = nv;
  lab.undoStack = [];
  lab.dirty = true;
  toast("Editing your own copy: “" + nm + "”. Save keeps it.");
}

export function undo() {
  const last = lab.undoStack.pop();
  if (!last) {
    toast("Nothing to undo");
    return;
  }
  lab.cur.graph = shownGraph(JSON.parse(last), lab.cfocus);
  lab.sel = null;
  lab.dirty = true;
  emit();
}

export function openVersion(id: string) {
  if (id === lab.cur.id) return;
  if (lab.dirty && !isMain()) toast("Unsaved changes to “" + lab.cur.name + "” were dropped");
  const v = lab.versions.find((x) => x.id === id);
  if (!v) return;
  lab.cur = clone(v);
  lab.cur.graph = shownGraph(lab.cur.graph, lab.cfocus);
  lab.dirty = false;
  lab.undoStack = [];
  lab.sel = null;
  emit();
  if (lab.view === "canvas") fit();
}

export function newVersion() {
  lab.cur = clone(MAIN);
  forkFromMain();
  lab.sel = null;
  go("canvas");
}

export function go(v: View) {
  // Conversations is Context modules' Chat history section now (mockup W21NekNf2vtnFLXXzAmp7N, 2026-11-16).
  if (v === "convo") {
    v = "modules";
    requestAnimationFrame(() => document.getElementById("chatHistory")?.scrollIntoView({ block: "start" }));
  }
  lab.view = v;
  if (v !== "canvas") {
    lab.cfocus = null;
    lab.cur.graph = shownGraph(G(), null);
  }
  emit();
  if (v === "canvas") requestAnimationFrame(() => fit());
}

/**
 * Focus on a step. On the folded "door" box this opens its eleven steps: the whole graph drawn with them in it (Dev2,
 * 2026-11-14: "Focus on it opens all eleven steps"). Any other focus folds the groups it is not inside.
 */
export function focusOn(id: string) {
  if (!node(id)) return;
  lab.cur.graph = shownGraph(G(), id);
  lab.cfocus = id;
  lab.sel = { t: "node", id };
  lab.fArea = null;
  if (lab.view !== "canvas") go("canvas");
  else {
    emit();
    requestAnimationFrame(() => fit());
  }
}

/** "Whole graph": the focus ends and every group folds again. */
export function unfocus() {
  lab.cfocus = null;
  lab.cur.graph = shownGraph(G(), null);
  emit();
  requestAnimationFrame(() => fit());
}

export async function saveVersion() {
  const cur = lab.cur;
  cur.updatedAt = Date.now();
  cur.authorId = cur.authorId || lab.myId;
  const i = lab.versions.findIndex((v) => v.id === cur.id);
  if (i >= 0) lab.versions[i] = clone(cur);
  else lab.versions.push(clone(cur));
  lab.dirty = false;
  emit();
  if (!saver) {
    toast("Couldn't reach the shared list");
    return;
  }
  try {
    await saver(clone(cur));
    toast("Saved “" + cur.name + "” for everyone");
  } catch {
    toast("Couldn't reach the shared list");
  }
}

/** A step dragged on the canvas: moved every frame without an undo step each (`pushUndo` once on release). */
export function moveNode(id: string, x: number, y: number) {
  const n = node(id);
  if (!n) return;
  n.x = x;
  n.y = y;
  emit();
}
export function pushUndo(before: string) {
  lab.undoStack.push(before);
  if (lab.undoStack.length > 60) lab.undoStack.shift();
}
export function markDirty() {
  lab.dirty = true;
  emit();
}
/** Change any piece of the state and draw again: `set({ tool: "con" })`. */
export function set(patch: Partial<LabState>) {
  Object.assign(lab, patch);
  emit();
}

/** Delete the selected step (with its wires and the reads of its output) or wire; the artifact's `delSel`. */
export function delSel() {
  const sel = lab.sel;
  if (!sel) return;
  if (sel.t === "node") {
    // The test chat's line is no step of the graph (`lineSteps.ts`): nothing to delete, and no draft to start.
    if (sel.id === "lineIn" || sel.id === "lineOut") return;
    if (["text", "send"].includes(sel.id)) {
      toast("Every version needs a start and a send");
      return;
    }
    const id = sel.id;
    edit(() => {
      const g = G();
      g.nodes = g.nodes.filter((n) => n.id !== id);
      g.edges = g.edges.filter((e) => e.from !== id && e.to !== id);
      g.nodes.forEach((n) => (n.ctx = n.ctx.filter((c) => c !== "out:" + id)));
      lab.sel = null;
    });
    toast("Deleted. Undo brings it back.");
  } else {
    const i = sel.i;
    edit(() => {
      G().edges.splice(i, 1);
      lab.sel = null;
    });
    toast("Wire deleted");
  }
}
