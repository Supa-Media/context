import { useEffect, useRef, useState } from "react";
import { castStepLine, splitWebsiteCast, type CastStep } from "@context/shared";
import type { PresenceMember } from "../console/presence/protocol";
import { stripFrontmatter } from "../share/markdown";

/** How long a change somebody else made stays marked on the rail. */
export const CHANGE_MARK_MS = 8_000;

/** What changed in a script between two versions of its note. */
export interface ScriptChange {
  /** Rows (step indices in the new script) that are new or rewritten. */
  changed: number[];
  /** How many more steps went than came: the ones taken out, not rewritten. */
  removed: number;
}

/** Each step of a note's script, as the grammar writes it: what two versions are compared by. */
export function scriptLines(source: string): string[] {
  return splitWebsiteCast(stripFrontmatter(source)).steps.map(castStepLine);
}

/**
 * The rows of `after` that `before` did not have, and how many of `before`'s
 * are gone. Steps are matched by what they say, as many times as they appear,
 * so a step that only moved, or that the same words already said, is not a
 * change.
 */
export function scriptChange(before: readonly string[], after: readonly string[]): ScriptChange {
  const left = new Map<string, number>();
  for (const line of before) left.set(line, (left.get(line) ?? 0) + 1);
  const changed: number[] = [];
  after.forEach((line, index) => {
    const count = left.get(line) ?? 0;
    if (count > 0) left.set(line, count - 1);
    else changed.push(index);
  });
  // A step rewritten is one gone and one new: it is counted as changed, not as both.
  let gone = 0;
  for (const count of left.values()) gone += count;
  return { changed, removed: Math.max(0, gone - changed.length) };
}

/**
 * Who a change nobody in the studio made came from: the agents in the note
 * right now, since a tool is only in the room while it writes; failing that,
 * the other people in it; `null` when the room shows nobody.
 */
export function changedBy(members: readonly PresenceMember[]): string | null {
  const agents = members.filter((member) => member.isAgent).map((member) => member.name);
  const names = agents.length > 0 ? agents : members.map((member) => member.name);
  const unique = [...new Set(names)];
  if (unique.length === 0) return null;
  if (unique.length <= 2) return unique.join(" and ");
  return `${unique[0]} and ${unique.length - 1} others`;
}

export interface OutsideChange extends ScriptChange {
  by: string | null;
  /** Changes with every new change, so the rail can mark it again. */
  key: number;
}

/**
 * The script's latest change that did not come from this studio, marked for
 * `CHANGE_MARK_MS`: an agent writing the note through its tools, or anyone
 * else in the room. `ours` is the text this studio last wrote; a draft equal
 * to it is our own edit, and is not marked.
 */
export function useOutsideChanges(
  draft: string,
  ours: { current: string | null },
  members: readonly PresenceMember[],
): OutsideChange | null {
  const previous = useRef(scriptLines(draft));
  const [change, setChange] = useState<OutsideChange | null>(null);
  const membersRef = useRef(members);
  membersRef.current = members;
  useEffect(() => {
    const lines = scriptLines(draft);
    const found = scriptChange(previous.current, lines);
    previous.current = lines;
    if (draft === ours.current) return;
    if (found.changed.length === 0 && found.removed === 0) return;
    setChange((last) => ({ ...found, by: changedBy(membersRef.current), key: (last?.key ?? 0) + 1 }));
  }, [draft, ours]);
  useEffect(() => {
    if (change === null) return;
    const timer = setTimeout(() => setChange(null), CHANGE_MARK_MS);
    return () => clearTimeout(timer);
  }, [change]);
  return change;
}

/** How long a start that moved because of an edit here stays marked. */
export const MOVED_MARK_MS = 2_500;

/**
 * The rows whose start moved, matched by what they say: after an edit here,
 * the steps a longer line or a new pause pushed later light up for a moment.
 */
export function movedStarts(
  before: readonly { line: string; at: number | null }[],
  after: readonly { line: string; at: number | null }[],
): number[] {
  const was = new Map<string, (number | null)[]>();
  for (const row of before) was.set(row.line, [...(was.get(row.line) ?? []), row.at]);
  const moved: number[] = [];
  after.forEach((row, index) => {
    const starts = was.get(row.line);
    if (starts === undefined || starts.length === 0) return;
    const at = starts.shift()!;
    if (at !== null && row.at !== null && at !== row.at) moved.push(index);
  });
  return moved;
}

/** `movedStarts` for the studio's rows, after each edit made here; empty otherwise. */
export function useMovedStarts(
  draft: string,
  ours: { current: string | null },
  rows: readonly { step: CastStep; at: number | null }[],
): ReadonlySet<number> {
  const timed = rows.map((row) => ({ line: castStepLine(row.step), at: row.at }));
  const previous = useRef(timed);
  const [moved, setMoved] = useState<ReadonlySet<number>>(new Set());
  useEffect(() => {
    const before = previous.current;
    previous.current = timed;
    if (draft !== ours.current) return;
    const found = movedStarts(before, timed);
    if (found.length === 0) return;
    setMoved(new Set(found));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per version of the note
  }, [draft]);
  useEffect(() => {
    if (moved.size === 0) return;
    const timer = setTimeout(() => setMoved(new Set()), MOVED_MARK_MS);
    return () => clearTimeout(timer);
  }, [moved]);
  return moved;
}
