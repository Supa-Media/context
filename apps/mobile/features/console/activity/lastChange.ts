import { actorLabel, clientOf, type ActivityEntry } from "./activity";

/**
 * Who changed the open note last, when it was not the person reading it
 * (board 3, option A, picked by the owner 2026-10-17).
 *
 * Recent stopped listing what someone's agents did, so the agents' work needs
 * somewhere it can still be seen. It is on the note itself: one line under its
 * name, "Claude changed this at 9:31", and nothing new on Home. A note the
 * reader changed last by their own hand says nothing; their own AI, a
 * teammate, or a teammate's AI says who.
 *
 * Only lines that change what the note says count. A move, an archive or a
 * publish is about where it is, and the activity list already says those.
 */
const CHANGES: ReadonlySet<string> = new Set(["added", "revised", "meeting", "session", "remembered"]);

export interface LastChange {
  /** "Claude changed this at 9:31", "@sayo changed this Mon". */
  text: string;
}

/** `whenLabel`-style: the clock today, a weekday this week, else the date. */
function whenSaid(at: number, now: number): string {
  const then = new Date(at);
  const today = new Date(now);
  const startOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(then)) / 86_400_000);
  if (days <= 0) return `at ${then.getHours()}:${String(then.getMinutes()).padStart(2, "0")}`;
  if (days < 7) return `on ${then.toLocaleString("en-US", { weekday: "long" })}`;
  return `on ${then.toLocaleString("en-US", { month: "short" })} ${then.getDate()}`;
}

/** Who to name: the AI by its own name when it is the reader's, else whose it is. */
function whoSaid(entry: ActivityEntry, me: string | null): string {
  const via = clientOf(entry.via);
  if (via !== null && me !== null && entry.by === me) return via;
  return actorLabel(entry);
}

export function lastChangeOf(
  entries: readonly ActivityEntry[],
  path: string | null,
  me: string | null,
  now: number,
): LastChange | null {
  if (path === null) return null;
  let latest: { entry: ActivityEntry; at: number } | null = null;
  for (const entry of entries) {
    if (!CHANGES.has(entry.kind) || !entry.paths.includes(path)) continue;
    const at = Date.parse(entry.at);
    if (!Number.isFinite(at)) continue;
    if (latest === null || at > latest.at) latest = { entry, at };
  }
  if (latest === null) return null;
  const { entry, at } = latest;
  // Their own hand, in the app or anywhere else: nothing to say.
  if (me !== null && entry.by === me && clientOf(entry.via) === null) return null;
  // A person's hand the reader cannot tell from their own (no name to compare), or nobody: say nothing.
  if (clientOf(entry.via) === null && (me === null || entry.by === null)) return null;
  return { text: `${whoSaid(entry, me)} changed this ${whenSaid(at, now)}` };
}
