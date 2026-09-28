/**
 * Who an owner picker offers, in what order — pure, so the ranking is tested
 * without a database.
 *
 * An owner is a person in the workspace, an agent connected to it, or "any
 * agent", and never a word somebody typed. The picker asks the server rather
 * than filtering a roster it was handed, because a workspace of a hundred
 * people is not a list anybody scrolls and a roster sent to every open folder
 * page is a read whose size is set by the membership. So this runs where the
 * members are, and only the few best matches leave.
 *
 * ## The order, with nothing typed
 *
 * The people the caller's folder already names come first, in the order the
 * caller says it uses them (`prefer`), then the caller themselves, then
 * everybody else a to z. A folder where Sayo owns six projects offers Sayo
 * first. A `prefer` word that is not anybody's full name still counts when it
 * is their first name: a folder written by hand says `Seyi` for the member
 * whose name is `Seyi Olujide`, and offering that member first is how the old
 * word gets replaced by a real one.
 *
 * ## The order, with something typed
 *
 * Only matches, best match first: the whole name or handle, then the start of
 * either, then the start of any word in the name, then the start of the
 * address, then anywhere in the name, handle or address. Ties break the same
 * way as above. Case and accents are ignored, so `sayo` finds `Sàyọ̀`, and a
 * leading `@` is, so `@sa` finds `@sayo`.
 *
 * ## Handles, never addresses
 *
 * A person with a handle is offered, and written, as `@handle` — the name
 * people are addressed by everywhere else here — and their address never
 * leaves the server: it still matches what is typed, but is not shown. An
 * owner line written before handles (`owner: seyi@example.com`, or a full
 * name) still means that member: `resolveOwnerWords` says so, and the page
 * shows `@seyi` without rewriting the note.
 */

export interface OwnerMember {
  /** What an owner line would say: `@handle`, else the name, else the address. */
  value: string;
  name?: string;
  email?: string;
  /** Without the `@`. */
  handle?: string;
  isMe: boolean;
}

/** `member.value` from what is known about them. */
export function ownerValue(member: { handle?: string; name?: string; email?: string }): string | undefined {
  return member.handle !== undefined ? `@${member.handle}` : (member.name ?? member.email);
}

/** `fold`, with a leading `@` dropped: `@Seyi` and `seyi` are one handle. */
function foldHandle(text: string): string {
  return fold(text).replace(/^@/, "");
}

/** Lower case, accents off, spaces collapsed. */
export function fold(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** How well `query` matches `member`: 0 is no match, higher is better. */
export function matchTier(member: OwnerMember, query: string): number {
  const q = fold(query);
  if (q === "") return 1;
  const h = foldHandle(query);
  const name = fold(member.name ?? "");
  const email = fold(member.email ?? "");
  const handle = fold(member.handle ?? "");
  if ((name !== "" && name === q) || (handle !== "" && handle === h)) return 6;
  if (name.startsWith(q) || (h !== "" && handle.startsWith(h))) return 5;
  if (name.split(" ").some((word) => word.startsWith(q))) return 4;
  if (email.startsWith(q)) return 3;
  if (name.includes(q) || email.includes(q) || (h !== "" && handle.includes(h))) return 2;
  return 0;
}

/**
 * How strongly the caller's folder already points at `member`: the position
 * of the first `prefer` word naming them, counted from the end, or 0.
 */
export function preferWeight(member: OwnerMember, prefer: readonly string[]): number {
  const value = fold(member.value);
  const first = fold(member.name ?? "").split(" ")[0] ?? "";
  for (let at = 0; at < prefer.length; at += 1) {
    const word = fold(prefer[at]);
    if (word === "") continue;
    if (word === value || (first !== "" && word === first) || names(member, prefer[at])) return prefer.length - at;
  }
  return 0;
}

/**
 * Whether an owner word means `member` exactly: their `@handle` or handle,
 * their address, or their whole name. First names are `preferWeight`'s
 * business, a ranking hint; this is the stricter question of who a line names.
 */
function names(member: OwnerMember, word: string): boolean {
  const folded = fold(word);
  if (folded === "") return false;
  return (
    (member.handle !== undefined && fold(member.handle) === foldHandle(word)) ||
    (member.email !== undefined && fold(member.email) === folded) ||
    (member.name !== undefined && fold(member.name) === folded)
  );
}

/**
 * The members that owner words written before handles mean, as the value the
 * picker would write today — for each word that names exactly one member and
 * does not already say it that way. A name two members share names nobody.
 */
export function resolveOwnerWords(
  members: readonly OwnerMember[],
  words: readonly string[],
): { word: string; value: string }[] {
  const out: { word: string; value: string }[] = [];
  const seen = new Set<string>();
  for (const word of words) {
    const key = fold(word);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    const matched = members.filter((member) => names(member, word));
    if (matched.length !== 1) continue;
    const value = matched[0].value;
    if (value !== word.trim()) out.push({ word, value });
  }
  return out;
}

export function rankMembers(
  members: readonly OwnerMember[],
  query: string,
  prefer: readonly string[],
  limit: number,
): OwnerMember[] {
  return members
    .map((member) => ({ member, tier: matchTier(member, query), weight: preferWeight(member, prefer) }))
    .filter((row) => row.tier > 0)
    .sort(
      (a, b) =>
        b.tier - a.tier ||
        b.weight - a.weight ||
        Number(b.member.isMe) - Number(a.member.isMe) ||
        a.member.value.localeCompare(b.member.value),
    )
    .slice(0, limit)
    .map((row) => row.member);
}

/** Agent names that match `query`, keeping the order they came in. */
export function matchAgents(names: readonly string[], query: string, limit: number): string[] {
  const q = fold(query);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const folded = fold(name);
    if (folded === "" || seen.has(folded)) continue;
    seen.add(folded);
    if (q !== "" && !folded.includes(q)) continue;
    out.push(name);
    if (out.length >= limit) break;
  }
  return out;
}
