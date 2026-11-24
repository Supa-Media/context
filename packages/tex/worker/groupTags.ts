/**
 * Tex's own native tags in a group (Dev, 2026-11-23: "native tags ... seem like features id like to use"; design
 * `@supa projects/tex-imessage-line/photon-sending-design.md`). A group turn knows each account here as "@handle"
 * (`gateway/agent/groupNames.js` `rosterLine`), so that is how Tex names someone. When it sends, each "@handle" of
 * someone in the chat is shown by their first name, and on Photon's line it goes as an iMessage tag of that person
 * (`MessagePart.mentionedAddress`), which notifies them even in a chat they muted. On another line the name goes as
 * plain words.
 *
 * Who is who is kept as the chat's names are (`groupTurn.ts` `keepNames`): by the hash of a phone, never a number. A
 * tag's number comes only from the chat's live member list at send time, matched to the hash: a handle nobody in the
 * chat has now, a guest's label, or one two people share is never tagged, and stays the words Tex wrote.
 *
 * Pure but for the storage read; `sha256Hex` is the one `groupChat.ts` hashes phones with.
 */

import type { InboxStorage } from "./inbox";
import { sha256Hex } from "./groupChat";

export const TAGS_KEY = "gtags";
const MAX_PEOPLE = 64;
const MAX_TAGS = 8;
/**
 * A handle as `functions/lib/names.ts` allows one, after its "@", not inside a word or an email address. Read in any
 * case: a handle is lowercase, but a turn that starts a sentence with "@Sam-5997" means the same person.
 */
const AT_HANDLE = /(?<![\w@.])@([a-z0-9][a-z0-9-]{0,63})(?![\w-])/gi;

export type TagPerson = { handle: string; name?: string };
/** A tag in the words as sent: its UTF-16 range and the number it tags. */
export type SendTag = { start: number; length: number; address: string };

/** Keep each account here by the hash of its phone: its handle and, when it has one, its name. */
export async function keepTagPeople(storage: InboxStorage, names: readonly { phone: string; handle: string; name?: string }[]): Promise<void> {
  const kept: Record<string, TagPerson> = {};
  for (const { phone, handle, name } of names.slice(0, MAX_PEOPLE)) {
    const first = typeof name === "string" ? (name.trim().split(/\s+/)[0] ?? "") : "";
    kept[await sha256Hex(phone)] = { handle, ...(first !== "" ? { name: first.slice(0, 40) } : {}) };
  }
  await storage.put(TAGS_KEY, kept);
}

/** A person's name as a tag shows it: their first name, else their handle. */
const shown = (person: TagPerson) => person.name ?? person.handle;

/**
 * The words with each "@handle" of an account here shown by name, and the tags to send with them: one per handle that
 * exactly one person among the chat's live numbers (`readMembers`, null when they could not be read) has. With no account
 * kept, the words as given.
 */
export async function tagWords(storage: InboxStorage, text: string, readMembers: () => Promise<readonly string[] | null>): Promise<{ text: string; tags: SendTag[] }> {
  if (!text.includes("@")) return { text, tags: [] };
  const kept = (await storage.get<Record<string, TagPerson>>(TAGS_KEY)) ?? {};
  const byHandle = new Map<string, TagPerson>();
  for (const person of Object.values(kept)) byHandle.set(person.handle, person);
  if (byHandle.size === 0 || ![...text.matchAll(AT_HANDLE)].some((match) => byHandle.has(match[1]!.toLowerCase()))) return { text, tags: [] };
  // The members are read only when the words name someone kept: a line's member list is a call of its own.
  const members = await readMembers();
  // The number of each handle among the chat's members now; a handle two numbers share is nobody's.
  const numbers = new Map<string, string | null>();
  for (const phone of (members ?? []).slice(0, MAX_PEOPLE)) {
    const person = kept[await sha256Hex(phone)];
    if (person === undefined) continue;
    numbers.set(person.handle, numbers.has(person.handle) ? null : phone);
  }
  let out = "";
  let last = 0;
  const tags: SendTag[] = [];
  for (const match of text.matchAll(AT_HANDLE)) {
    const person = byHandle.get(match[1]!.toLowerCase());
    if (person === undefined) continue;
    const name = shown(person);
    out += text.slice(last, match.index);
    const address = numbers.get(person.handle);
    if (typeof address === "string" && tags.length < MAX_TAGS) tags.push({ start: out.length, length: name.length, address });
    out += name;
    last = match.index! + match[0].length;
  }
  return { text: out + text.slice(last), tags };
}

/** The words cut into the parts a tagged send is: plain runs, and each tag its own part naming its number. */
export function tagParts(text: string, tags: readonly SendTag[]): Array<{ text: string; mention?: string }> {
  const parts: Array<{ text: string; mention?: string }> = [];
  let at = 0;
  for (const tag of [...tags].sort((a, b) => a.start - b.start)) {
    if (tag.start < at || tag.start + tag.length > text.length) continue;
    if (tag.start > at) parts.push({ text: text.slice(at, tag.start) });
    parts.push({ text: text.slice(tag.start, tag.start + tag.length), mention: tag.address });
    at = tag.start + tag.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}
