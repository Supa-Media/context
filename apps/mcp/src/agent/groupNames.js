/**
 * WHO IS WHO IN A GROUP CHAT (a customer's group chat, 2026-11-04).
 *
 * A customer asked Tex in a group chat where a logo was. Tex searched the
 * workspace's notes, found nothing, and answered that the customer "or Sayo
 * would know", to the customer himself. The turn knew the tagger only by his
 * handle (`@jo` here), while the notes named him by his full name, so nothing
 * tied the two together.
 *
 * The control plane now sends each account's name beside its handle
 * (`apps/convex/functions/lib/textGroupAccounts.ts` `chatPerson`), the Worker
 * passes it on (`apps/agent/src/groupModelTurn.ts`), and the turn is told who
 * is who here. A name is a person's own text: it is kept to letters, spaces and
 * the marks names use, on one short line, so it can't carry an instruction.
 */

const MAX_NAMES = 32;
const MAX_NAME = 80;
/** A handle as `functions/lib/names.ts` allows one. */
const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,63})$/;

/** A name as told to the turn: letters, marks, spaces, apostrophes, hyphens and periods, one line. */
export function cleanName(name) {
  if (typeof name !== "string") return "";
  return name
    .replace(/[^\p{L}\p{M}\s'’.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME)
    .trim();
}

/** The chat's people by handle and name, from the Worker's body: only handles of people in this chat, each once. */
export function namesOf(raw, handles) {
  if (!Array.isArray(raw)) return [];
  const here = new Set(handles);
  const seen = new Set();
  const names = [];
  for (const entry of raw.slice(0, MAX_NAMES)) {
    const handle = typeof entry?.handle === "string" ? entry.handle : "";
    const name = cleanName(entry?.name);
    if (!HANDLE.test(handle) || !here.has(handle) || seen.has(handle) || name === "") continue;
    seen.add(handle);
    names.push({ handle, name });
  }
  return names;
}

/** "@jo (Jo Rivers)", or "@jo" when the account has no name. */
export function taggerLabel(group) {
  const name = (group?.names ?? []).find((entry) => entry.handle === group?.from)?.name;
  return name ? `@${group.from} (${name})` : `@${group.from}`;
}

/** Who is who here, for the group words: each handle's name, and that the asker is never sent to themselves. */
export function whoIsWhoLine(group) {
  const names = Array.isArray(group?.names) ? group.names : [];
  const known = names.length > 0 ? `People here by name: ${names.map(({ handle, name }) => `@${handle} is ${name}`).join("; ")}. ` : "";
  return (
    known +
    "Notes may name people by full name, first name or nickname: the person who tagged you is the one asking, so never tell them they would know, or to ask themselves. "
  );
}
