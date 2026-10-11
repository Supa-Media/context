import type { MapActor } from "../engine/timeline";
import type { MapEvent } from "../types";
import { folderLabel } from "../engine/paths";

/**
 * The card a tapped dot opens, as data: the note cut into blocks a small card
 * can draw, which of them changed since the last read (what is being typed),
 * who is writing or reading it, and where the card sits beside the dot.
 *
 * Pure, so the live view's rules are tested without a renderer. The card and
 * the read loop are `ui/NotePeek.tsx` and `hooks/useNotePeek.ts`.
 */

/** How often the open note is read again while somebody is writing it. */
export const PEEK_WRITING_READ_MS = 2_500;
/** And while nobody is: often enough that a card left open is not stale. */
export const PEEK_READ_MS = 15_000;

export type PeekNote = { workspaceId: string; path: string };

export type PeekBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "item"; text: string }
  | { kind: "code"; text: string };

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/;

/**
 * The note's body as blocks: front matter dropped, headings, paragraphs (a
 * run of lines up to a blank one), list items and code kept apart. An
 * unclosed fence keeps what was typed, because a note being written often
 * has one for a moment.
 */
export function peekBlocks(text: string): PeekBlock[] {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
  const lines = body.split(/\r?\n/);
  const out: PeekBlock[] = [];
  let para: string[] = [];
  const endPara = () => {
    if (para.length > 0) out.push({ kind: "paragraph", text: para.join(" ") });
    para = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (FENCE.test(line)) {
      endPara();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i]!)) code.push(lines[i++]!);
      out.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === "") {
      endPara();
      continue;
    }
    const heading = HEADING.exec(trimmed);
    if (heading) {
      endPara();
      out.push({ kind: "heading", level: heading[1]!.length, text: heading[2]!.trim() });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      endPara();
      out.push({ kind: "item", text: item[1]!.trim() });
      continue;
    }
    para.push(trimmed);
  }
  endPara();
  return out;
}

const blockKey = (b: PeekBlock): string => `${b.kind}|${b.kind === "heading" ? b.level : ""}|${b.text}`;

/**
 * Which blocks of `next` are new since `prev`: what was typed while the card
 * was open. Matched as a multiset rather than by position, so a paragraph
 * inserted in the middle marks itself and not everything below it. The first
 * read (`prev` null) marks nothing: nothing was typed while anybody watched.
 */
export function changedBlocks(prev: readonly PeekBlock[] | null, next: readonly PeekBlock[]): number[] {
  if (prev === null) return [];
  const left = new Map<string, number>();
  for (const b of prev) left.set(blockKey(b), (left.get(blockKey(b)) ?? 0) + 1);
  const changed: number[] = [];
  next.forEach((b, i) => {
    const k = blockKey(b);
    const n = left.get(k) ?? 0;
    if (n > 0) left.set(k, n - 1);
    else changed.push(i);
  });
  return changed;
}

export type PeekPresence = { writers: string[]; readers: string[] };

/**
 * Who is on this note now: writing it (an edit or a new note) or reading it
 * (on it, or among the notes a search just read). You are not listed on your
 * own card, and somebody writing is not also listed as reading.
 */
export function peekPresence(actors: readonly MapActor[], note: PeekNote): PeekPresence {
  const writers: string[] = [];
  const readers: string[] = [];
  for (const a of actors) {
    if (a.self || (a.workspaceId !== undefined && a.workspaceId !== note.workspaceId)) continue;
    const on = a.path === note.path;
    if (on && (a.doing === "edit" || a.doing === "create")) writers.push(a.name);
    else if ((on && a.doing === "read") || (a.reads ?? []).includes(note.path)) readers.push(a.name);
  }
  return { writers, readers };
}

export type PresenceChip = { kind: "writing" | "reading"; text: string };

/** Most named on one card, per kind; the rest are a count. */
const NAMED = 2;

export function presenceChips({ writers, readers }: PeekPresence): PresenceChip[] {
  const chips = (names: string[], kind: PresenceChip["kind"], verb: string): PresenceChip[] => {
    const shown = names.length > NAMED + 1 ? names.slice(0, NAMED) : names;
    const out = shown.map((name) => ({ kind, text: `${name} is ${verb}` }));
    const more = names.length - shown.length;
    if (more > 0) out.push({ kind, text: `${more} more are ${verb}` });
    return out;
  };
  return [...chips(writers, "writing", "writing"), ...chips(readers, "reading", "reading")];
}

/** Space kept between the card and the canvas's edges, and the dot. */
const EDGE = 12;
const GAP = 24;

/**
 * Where the card sits: to the right of the dot, or its left when the right
 * has no room, its top a little above the dot, and always inside the canvas.
 * With no tap point (the map coming back with a card open) it sits at the
 * top right.
 */
export function peekPlacement(
  at: { x: number; y: number } | null,
  box: { width: number; height: number },
  card: { width: number; height: number },
): { left: number; top: number } {
  const maxLeft = box.width - EDGE - card.width;
  const maxTop = box.height - EDGE - card.height;
  const clamp = (v: number, max: number) => (max < EDGE ? EDGE : Math.min(Math.max(v, EDGE), max));
  if (at === null) return { left: clamp(maxLeft, maxLeft), top: EDGE };
  const right = at.x + GAP;
  const left = right + card.width <= box.width - EDGE ? right : at.x - GAP - card.width;
  return { left: clamp(left, maxLeft), top: clamp(at.y - 40, maxTop) };
}

/** The folders a note is in, in words: "Projects › launch". Empty at the top level. */
export function peekCrumbs(path: string): string {
  const segments = path.split("/").filter((s) => s.length > 0);
  return segments.slice(0, -1).map(folderLabel).join(" › ");
}

/** When the note was last written, from what the map has seen happen to it; `null` when it has seen nothing. */
export function lastWritten(events: readonly MapEvent[], note: PeekNote): number | null {
  let at: number | null = null;
  for (const e of events) {
    if (e.kind === "move" || e.kind === "read") continue;
    if (e.workspaceId === note.workspaceId && e.path === note.path && (at === null || e.at > at)) at = e.at;
  }
  return at;
}
