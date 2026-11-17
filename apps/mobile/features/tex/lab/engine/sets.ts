/**
 * The Testing tab's reading of a conversation (Dev2, 2026-11-15: "make sure to build this EXACTLY how it is here",
 * the prototype https://claude.ai/artifact/GAScQuRxZyASpH8xes4n9K). Pure: what a grid cell shows, what a special
 * message reads as, what a node is given at a message (its config context modules in order and its wires in), and
 * the ratio. The format and its rules are `packages/shared/src/texSets.cjs`, the one contract every reader shares.
 */
import { unfoldGroups } from "./groups";
import { labelFields as fieldsOf, missingTest, ratio as ratioOf, unitTests, KINDS, SETS, TARGET } from "@context/shared/src/texSets.cjs";
import type { Conversation, Fields, Label, Message, Ratio, SetId } from "@context/shared/src/texSets.d.cts";
import { JUDGE_EXAMPLES, WHY } from "@context/shared/src/textDecide.cjs";
import { MOD_SRC } from "../data/modules";
import type { LabGraph, LabNode } from "../types";
import { mods } from "./modules";

export type { Conversation, Label, Message, Ratio, SetId };
export { missingTest };
export { KINDS, SETS, TARGET };

const why = Object.keys(WHY);
export const labelFields = (n: LabNode | undefined): Fields => fieldsOf(n as never, { why });

/** The sets' names and notes, as the prototype's left column shows them. */
export const SET_INFO: Record<SetId, { name: string; note: string; color: string }> = {
  training: { name: "Training", note: "shown to steps as examples", color: "var(--accent)" },
  dev: { name: "Dev", note: "replay runs it; agents tune here", color: "var(--ok)" },
  test: { name: "Test", note: "people only", color: "var(--team)" },
};

/** Special messages: a reaction, a reply, an edit or a delete points at an earlier message (`to`). */
export const KIND_NAMES: Array<[string, string]> = [["text", "Message"], ["react", "Reaction to…"], ["reply", "Reply to…"], ["edit", "Edit of…"], ["delete", "Delete of…"]];
export const EMOJI = ["👍", "❤️", "😂", "‼️", "❓", "👎"];

export const starsIn = (c: Conversation) => unitTests(c).length;
export const nodeStars = (m: Message) => Object.values(m.labels || {}).filter((l) => l?.star).length;
export const labelCount = (m: Message) => Object.keys(m.labels || {}).length;
export const numOf = (c: Conversation, id: string | undefined) => c.msgs.findIndex((x) => x.id === id) + 1;
export const snip = (c: Conversation, id: string | undefined, n = 40) => (c.msgs.find((x) => x.id === id)?.text || "").slice(0, n);

/** The ratio over unit tests: Training and Dev counted from their conversations, Test from the eval service's count. */
export function setsRatio(convs: Conversation[], testStars: number): Ratio {
  const counts = { training: 0, dev: 0, test: testStars };
  for (const c of convs) if (c.set === "training" || c.set === "dev") counts[c.set] += starsIn(c);
  return ratioOf(counts);
}

/** Whether main ran a node on a message: its recorded run (`rec`) holds that node. */
export const ranOn = (m: Message, nodeId: string) => !!m.rec && Object.prototype.hasOwnProperty.call(m.rec, nodeId);

/** The first field a node's cell shows: its first pick, else its first text, else its first must line. */
export function cellValue(n: LabNode, l: Label | undefined): string | null {
  if (!l) return null;
  const f = labelFields(n);
  const k = Object.keys(f.picks)[0] ?? f.texts[0];
  if (k) return (l[k] as string) ?? null;
  return (l.must || [])[0] ?? null;
}

export type Cell = { sym: string; cls: string; star: boolean; value: string | null; title: string };
/** What a grid cell shows for one message × one node (the prototype's legend). */
export function cellOf(m: Message, n: LabNode): Cell {
  const l = m.labels?.[n.id];
  const ran = ranOn(m, n.id);
  const star = !!l?.star;
  const value = cellValue(n, l);
  if (l?.run === "must not") return ran ? { sym: "⊘", cls: "c-bad", star, value: null, title: "labelled must not run, but ran" } : { sym: "⊘", cls: "c-ok", star, value: null, title: "must not run, didn't" };
  if (l?.run === "must" && !ran) return { sym: "!", cls: "c-must", star, value, title: "must run, but didn't" };
  if (l) return { sym: star ? "★" : "✓", cls: star ? "c-star" : "c-ok", star, value, title: star ? "unit test" : "labelled" };
  return ran ? { sym: "○", cls: "c-open", star: false, value: null, title: "ran, no label" } : { sym: "–", cls: "c-no", star: false, value: null, title: "didn't run" };
}

export type Body = { kind: string | null; to: number; late: boolean; text: string; quoted: string | null; struck: boolean };
/** How a message reads in the grid: a special message names the earlier one it points at, and is flagged when moved above it. */
export function bodyOf(c: Conversation, m: Message): Body {
  const to = numOf(c, m.to);
  const late = !!m.to && to > numOf(c, m.id);
  const k = m.kind;
  if (k === "react") return { kind: `${m.text || "👍"} reacted to #${to || "?"}`, to, late, text: "", quoted: snip(c, m.to), struck: false };
  if (k === "reply") return { kind: `↩ reply to #${to || "?"}`, to, late, text: m.text, quoted: null, struck: false };
  if (k === "edit") return { kind: `✎ edits #${to || "?"} to`, to, late, text: m.text, quoted: null, struck: false };
  if (k === "delete") return { kind: `🗑 deletes #${to || "?"}`, to, late, text: snip(c, m.to), quoted: null, struck: true };
  return { kind: null, to: 0, late: false, text: m.text, quoted: null, struck: false };
}

/** The steps a column can show: every node in the graph that runs on a turn, the prototype's nine first. */
export const FIRST_COLUMNS = ["triage", "decide", "router", "fd", "card", "reviewer", "nudge", "picture", "egress"];
export const HIDDEN_AT_FIRST = ["router", "card", "reviewer", "nudge", "picture", "egress"];
export function stepNodes(shown: LabGraph): LabNode[] {
  // A column per step, never per folded group box: the canvas folds groups, a chat's cells are each step's.
  const g = shown.folded ? unfoldGroups(shown) : shown;
  const steps = g.nodes.filter((n) => n.kind !== "input" && n.kind !== "tool");
  const first = FIRST_COLUMNS.map((id) => steps.find((n) => n.id === id)).filter((n): n is LabNode => !!n);
  return [...first, ...steps.filter((n) => !FIRST_COLUMNS.includes(n.id))];
}

/** The columns: speaker, message, then nodes. Order, hidden ones and widths are the viewer's own. */
export type Cols = { order: string[]; hidden: string[]; w: Record<string, number> };
export function defaultCols(g: LabGraph): Cols {
  const nodes = stepNodes(g).map((n) => n.id);
  return { order: ["who", "text", ...nodes], hidden: [...HIDDEN_AT_FIRST, ...nodes.filter((id) => !FIRST_COLUMNS.includes(id))], w: {} };
}
/** A saved column choice laid over the graph as it is now: new nodes join hidden, gone ones drop. */
export function fitCols(saved: Partial<Cols> | null, g: LabGraph): Cols {
  const base = defaultCols(g);
  if (!saved?.order) return base;
  const known = new Set(base.order);
  const order = saved.order.filter((id) => known.has(id));
  const hidden = (saved.hidden || []).filter((id) => known.has(id));
  for (const id of base.order)
    if (!order.includes(id)) {
      order.push(id);
      hidden.push(id);
    }
  return { order, hidden: hidden.filter((id) => id !== "text"), w: saved.w || {} };
}
export const COL_W = { who: 80, text: 250, node: 96 };
export const colWidth = (cols: Cols, id: string) => cols.w[id] || (id === "who" ? COL_W.who : id === "text" ? COL_W.text : COL_W.node);

export type ModRow = { id: string; name: string; value: string; plan?: string };
/** What one of a node's context modules holds at message `i` of this conversation. */
export function modValue(c: Conversation, i: number, id: string, n: LabNode, all: Conversation[], g: LabGraph): ModRow {
  const m = c.msgs[i];
  const next = c.msgs[i + 1];
  const mod = mods(g)[id];
  const name = mod?.name || id;
  const src = MOD_SRC[id]?.[1] ?? mod?.path ?? "";
  const row = (value: string, plan?: string): ModRow => ({ id, name, value, plan });
  const trained = (of: string) => all.filter((x) => x.set === "training").reduce((a, x) => a + x.msgs.filter((y) => y.labels?.[of]).length, 0);
  if (id.startsWith("train:")) {
    // `train:<nodeId>` or its whole conversations, `train:<nodeId>:all:<chars>`.
    const of = id.slice("train:".length).split(":")[0];
    const k = trained(of);
    const label = g.nodes.find((x) => x.id === of)?.label || of;
    return { id, name: mod?.name || `Training · ${label}`, value: `${k} Training Set label${k === 1 ? "" : "s"} for ${of === n.id ? "this node" : label}` };
  }
  if (id === "examples") {
    const k = trained(n.id);
    return row(`${JUDGE_EXAMPLES.length} judge examples today`, `planned: + ${k} Training Set label${k === 1 ? "" : "s"} for ${n.label}`);
  }
  switch (id) {
    case "recent": return row(`last few texts, up to #${i + 1}`);
    case "hist": return row(`#1–#${i + 1} (all of this chat fits in 24 h)`);
    case "histAll": return row(`#1–#${i + 1}, the whole chat`);
    case "groupBrief": return row(c.kind === "group" ? "Tex's open work, chat rules, guest names at this point" : "empty: this is a 1:1 chat");
    case "date": return row(`the chat's date and time at #${i + 1}`);
    case "ask": return row(`#${i + 1}: “${m?.text ?? ""}”`);
    case "draft": return row(next?.tex ? `#${i + 2}: “${next.text}”` : "none: no Tex reply after this message");
    case "about": return row(c.kind === "group" ? "the group's About note (test copy)" : "the person's About me (test copy)");
    case "threads": return row(`open threads at #${i + 1}`);
    case "ledger": return row("this turn so far (the wires below)");
    default: return row(`fixed · ${src || name}`);
  }
}

export type WireRow = { from: string; label: string; mode: string; when: string; src: string; cls: string };
/** The triggers that start a turn other than a text; their wires don't apply to a person's message. */
const TRIGGERS = new Set(["checkin", "routine", "notify"]);
/** A node's wires in, and where each one's input comes from on this message: your label, else main's recorded run. */
export function wiresIn(n: LabNode, m: Message, g: LabGraph): WireRow[] {
  return g.edges.filter((e) => e.to === n.id).map((e) => {
    const up = g.nodes.find((x) => x.id === e.from);
    const label = up?.label || e.from;
    const when = (e.when || []).join(", ");
    if (TRIGGERS.has(e.from)) return { from: e.from, label, mode: e.mode, when, src: `not here: only when a ${label.toLowerCase()} starts the turn`, cls: "muted" };
    if (up && up.on === false) return { from: e.from, label, mode: e.mode, when, src: "off in config: hands nothing", cls: "c-bad" };
    if (m.labels?.[e.from]) return { from: e.from, label, mode: e.mode, when, src: "your label for it on this message", cls: "c-ok" };
    return { from: e.from, label, mode: e.mode, when, src: "recorded run on main" + (up?.model === "code" ? " (code step)" : ""), cls: "" };
  });
}

/** Where a new row goes and who says it: after `after` (or at the end), as the last person who spoke before it. */
export function newRowAt(c: Conversation, after: string | null): { at: number; who: string } {
  const at = after ? c.msgs.findIndex((x) => x.id === after) + 1 : c.msgs.length;
  const prev = c.msgs.slice(0, at).reverse().find((x) => !x.tex);
  return { at, who: prev ? prev.who : c.members[0] || "Someone" };
}

/** A fresh message id no other message in the chat has. */
export function freshId(c: Conversation): string {
  const used = new Set(c.msgs.map((m) => m.id));
  let i = c.msgs.length + 1;
  while (used.has("m" + i)) i++;
  return "m" + i;
}

/** The message ids a node's cell may move to with the arrow keys: every visible column of every row. */
export function step(ids: string[], cur: string, d: number): string {
  const i = ids.indexOf(cur);
  return ids[Math.max(0, Math.min(ids.length - 1, (i < 0 ? 0 : i) + d))];
}
