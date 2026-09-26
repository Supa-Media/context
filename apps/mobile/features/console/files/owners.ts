/**
 * Who may own a project, as data: what an owner picker offers and in what
 * order, with no React in it.
 *
 * An owner (`owner:` in a note's frontmatter) is somebody in the workspace, an
 * agent connected to it, or "any agent" — never a word typed into a field. A
 * typed owner is how one folder came to say `Seyi`, `Seyi Olujide` and
 * `seyi` for one person, and a filter on any of them misses the other two.
 *
 * The people come from the server as the picker is typed into
 * (`owners.searchOwners` in the control plane), because a workspace of a
 * hundred people is not a roster to send every folder page. What is written is
 * the plain name, so the Markdown still reads `owner: Sayo` in any editor.
 *
 * ## An owner already written by hand
 *
 * Nothing is rewritten behind anybody's back. A value that is not a member or
 * an agent is still that note's owner and is shown as it is, and its picker
 * leads with it, checked and marked as not a member, so it can be kept or
 * replaced. It is passed to the search as a preferred word, so a hand-typed
 * `Seyi` puts the member called `Seyi Olujide` at the top of the list — the
 * replacement is one press.
 */

/** What an owner line says when any connected agent may pick the work up. */
export const ANY_AGENT = "any agent";

export interface OwnerPerson {
  /** What the owner line will say: the member's name, or their address. */
  readonly value: string;
  readonly email?: string;
  readonly isMe: boolean;
}

export interface OwnerResults {
  readonly people: readonly OwnerPerson[];
  readonly agents: readonly string[];
  /** The workspace is larger than one search reads; a narrower query finds the rest. */
  readonly truncated: boolean;
}

/** Ask for the owners matching `query`, with the folder's own owners as `prefer`. */
export type OwnerSearch = (query: string, prefer: readonly string[]) => Promise<OwnerResults>;

export type OwnerRow =
  | { readonly kind: "heading"; readonly label: string }
  | {
      readonly kind: "choice";
      /** Written to the note; `null` clears it. */
      readonly value: string | null;
      readonly label: string;
      readonly detail?: string;
      readonly checked: boolean;
    };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The owner words a set of notes uses, most used first, then most recently
 * saved — what the picker offers before anything is typed.
 */
export function ownersInUse(notes: readonly { properties: Record<string, unknown>; updatedAt?: number | null }[]): string[] {
  const tally = new Map<string, { word: string; count: number; last: number }>();
  for (const note of notes) {
    const raw = note.properties.owner;
    if (typeof raw !== "string" || raw.trim() === "") continue;
    const key = raw.trim().toLowerCase();
    const row = tally.get(key) ?? { word: raw.trim(), count: 0, last: 0 };
    row.count += 1;
    row.last = Math.max(row.last, note.updatedAt ?? 0);
    tally.set(key, row);
  }
  return [...tally.values()].sort((a, b) => b.count - a.count || b.last - a.last).map((row) => row.word);
}

/** Whether `value` names somebody the results know, or any agent. */
export function isKnownOwner(value: string, results: OwnerResults): boolean {
  return (
    same(value, ANY_AGENT) ||
    results.people.some((person) => same(person.value, value)) ||
    results.agents.some((agent) => same(agent, value))
  );
}

/**
 * The picker's rows: the current owner if nobody below is them, then People,
 * then Agents (with "Any agent" last among them), then "No owner" when there
 * is one to clear. "Any agent" and the agents are filtered by the same query.
 */
export function ownerRows(query: string, current: string, results: OwnerResults | null): OwnerRow[] {
  const rows: OwnerRow[] = [];
  const q = query.trim().toLowerCase();
  const people = results?.people ?? [];
  const agents = results?.agents ?? [];
  const anyAgent = ANY_AGENT.includes(q);
  if (current !== "" && results !== null && !isKnownOwner(current, results) && (q === "" || current.toLowerCase().includes(q))) {
    rows.push({ kind: "choice", value: current, label: current, detail: "Not a member", checked: true });
  }
  if (people.length > 0) {
    rows.push({ kind: "heading", label: "People" });
    for (const person of people) {
      rows.push({
        kind: "choice",
        value: person.value,
        label: person.isMe ? `${person.value} (you)` : person.value,
        ...(person.email === undefined ? {} : { detail: person.email }),
        checked: same(person.value, current),
      });
    }
  }
  if (agents.length > 0 || anyAgent) {
    rows.push({ kind: "heading", label: "Agents" });
    for (const agent of agents) rows.push({ kind: "choice", value: agent, label: agent, checked: same(agent, current) });
    if (anyAgent) rows.push({ kind: "choice", value: ANY_AGENT, label: "Any agent", detail: "Whichever picks it up", checked: same(ANY_AGENT, current) });
  }
  if (current !== "" && q === "") rows.push({ kind: "choice", value: null, label: "No owner", checked: false });
  return rows;
}

/**
 * A search over a list the device already has, for where there is no server
 * to ask (the landing page's picture of the console). Same shape and the same
 * rules — members only, no typing a new one — just filtered here.
 */
export function localOwnerSearch(people: readonly string[], limit = 8): OwnerSearch {
  return async (query, prefer) => {
    const q = query.trim().toLowerCase();
    const rank = (name: string) => {
      const at = prefer.findIndex((word) => same(word, name) || same(word, name.split(" ")[0] ?? ""));
      return at === -1 ? prefer.length : at;
    };
    const matched = [...new Set(people.map((name) => name.trim()).filter((name) => name !== ""))]
      .filter((name) => q === "" || name.toLowerCase().includes(q))
      .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    return { people: matched.slice(0, limit).map((value) => ({ value, isMe: false })), agents: [], truncated: false };
  };
}
