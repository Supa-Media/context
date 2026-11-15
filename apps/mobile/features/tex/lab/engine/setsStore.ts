/**
 * The Testing tab's state: the conversations it shows, what is selected in the grid, and the viewer's columns.
 * Every change is an op (`packages/shared/src/texSetOps.cjs`'s shapes), applied here at once and handed to the
 * sink the store registers (`setSetsSink`): Training and Dev drafts go to Convex, a Test chat to the eval service.
 * Views read it through `useSets()`.
 */
import { useSyncExternalStore } from "react";
import type { LabGraph } from "../types";
import { fitCols, type Cols } from "./sets";
import { applyOps, type SetOp } from "@context/shared/src/texSetOps.cjs";
import type { Conversation, SetId } from "./sets";

/** An edit, in the shapes `texSetOps.cjs` reads from the Lab and the MCP alike; a move to or from Test is the tab's own. */
export type Op = SetOp | { op: "set"; value: SetId };

/** A Test chat the viewer may not read: its counts only, from the eval service. */
export type HiddenChat = { kind: "one" | "group"; msgs: number; stars: number };

export type SetsState = {
  convs: Conversation[];
  hiddenTest: HiddenChat[];
  testStars: number;
  showTest: boolean;
  chat: string | null;
  msg: string | null;
  col: string | null;
  editing: boolean;
  colMenu: boolean;
  /** A row just added and still empty: it goes when you click away. */
  fresh: string | null;
  cols: Cols | null;
  loaded: boolean;
  /** The last thing the sink said went wrong, shown in the header. */
  problem: string | null;
};

export const sets: SetsState = {
  convs: [],
  hiddenTest: [],
  testStars: 0,
  showTest: false,
  chat: null,
  msg: null,
  col: null,
  editing: false,
  colMenu: false,
  fresh: null,
  cols: null,
  loaded: false,
  problem: null,
};

let version = 0;
const listeners = new Set<() => void>();
export function emitSets() {
  version++;
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
const snap = () => version;
export function useSets() {
  useSyncExternalStore(subscribe, snap, snap);
  return sets;
}
export function setUi(patch: Partial<SetsState>) {
  Object.assign(sets, patch);
  emitSets();
}

/**
 * Ops applied to a conversation, as the store applies them. Moving a chat into or out of the Test Set is the one
 * change the store never takes (the Test Set lives in the eval service), so it is applied here and the sink moves it.
 */
export function applyAll(c: Conversation, ops: Op[]): Conversation {
  const moves = ops.filter((o) => o.op === "set") as Array<{ op: "set"; value: SetId }>;
  const rest = ops.filter((o) => o.op !== "set") as SetOp[];
  const out = rest.length ? applyOps(c, rest).convo : c;
  return moves.length ? { ...out, set: moves[moves.length - 1].value } : out;
}

export type SetsSink = {
  /** Keep these ops on a conversation; `before` is how it read before them. */
  change: (before: Conversation, after: Conversation, ops: Op[]) => Promise<void>;
  create: (c: Conversation) => Promise<void>;
  /** Show the Test Set's words to this person (people only, with the warning). */
  readTest?: () => Promise<Conversation[]>;
};
let sink: SetsSink | null = null;
export const setSetsSink = (s: SetsSink | null) => {
  sink = s;
};

/** Apply ops to a conversation and keep them. */
export function change(chatId: string, ops: Op[]) {
  const i = sets.convs.findIndex((c) => c.id === chatId);
  if (i < 0 || !ops.length) return;
  const before = sets.convs[i];
  let after: Conversation;
  try {
    after = applyAll(before, ops);
  } catch (e) {
    return setUi({ problem: e instanceof Error ? e.message : "That edit can't be applied" });
  }
  sets.convs = sets.convs.slice();
  sets.convs[i] = after;
  emitSets();
  void sink?.change(before, after, ops).catch((e: unknown) => setUi({ problem: e instanceof Error ? e.message : "Couldn't save that change" }));
}

export function createChat(c: Conversation) {
  sets.convs = [...sets.convs, c];
  setUi({ chat: c.id, msg: null, col: null, editing: false });
  void sink?.create(c).catch((e: unknown) => setUi({ problem: e instanceof Error ? e.message : "Couldn't add the chat" }));
}

/** The store's latest copy of the conversations; selection survives when its chat and message still exist. */
export function loadConvs(convs: Conversation[], hidden: HiddenChat[], testStars: number) {
  const testOpen = sets.showTest ? sets.convs.filter((c) => c.set === "test") : [];
  const ids = new Set(convs.map((c) => c.id));
  sets.convs = [...convs, ...testOpen.filter((c) => !ids.has(c.id))];
  sets.hiddenTest = hidden;
  sets.testStars = testStars;
  sets.loaded = true;
  if (sets.chat && !sets.convs.some((c) => c.id === sets.chat)) sets.chat = null;
  emitSets();
}

export async function showTest(on: boolean) {
  if (!on) {
    sets.convs = sets.convs.filter((c) => c.set !== "test");
    if (sets.chat && !sets.convs.some((c) => c.id === sets.chat)) sets.chat = null;
    return setUi({ showTest: false });
  }
  if (!sink?.readTest) return setUi({ problem: "The Test Set can't be read here" });
  try {
    const test = await sink.readTest();
    const ids = new Set(test.map((c) => c.id));
    sets.convs = [...sets.convs.filter((c) => !ids.has(c.id)), ...test];
    setUi({ showTest: true, problem: null });
  } catch (e) {
    setUi({ problem: e instanceof Error ? e.message : "Couldn't read the Test Set" });
  }
}

const COLS_KEY = "texLab.testing.cols";
/** The viewer's columns, kept in this browser and laid over the graph as it is now. */
export function colsFor(g: LabGraph): Cols {
  if (!sets.cols) {
    let saved: Partial<Cols> | null = null;
    try {
      saved = JSON.parse(globalThis.localStorage?.getItem(COLS_KEY) || "null");
    } catch {
      saved = null;
    }
    sets.cols = fitCols(saved, g);
  }
  return sets.cols;
}
export function saveCols(cols: Cols, draw = true) {
  sets.cols = cols;
  try {
    globalThis.localStorage?.setItem(COLS_KEY, JSON.stringify(cols));
  } catch {
    /* the columns stay for this visit */
  }
  if (draw) emitSets();
}
