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

/** A guest's label as the control plane makes one (`apps/convex/functions/lib/textGroupGuests.ts` `guestLabel`). */
const GUEST = /^guest-[0-9a-f]{4}$/;
/** Most people in a chat Tex answers in (`apps/agent/src/sendblueGroups.ts` `MAX_GROUP_LIST`). */
const MAX_SIZE = 64;

/** The labels of the people here with no linked account, from the Worker's body: labels only, each once. */
export function guestsOf(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.slice(0, MAX_NAMES).filter((label) => typeof label === "string" && GUEST.test(label)))];
}

/** How many people the chat holds besides Tex, never fewer than are named; null when the Worker didn't say. */
export function sizeOf(raw, named) {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > MAX_SIZE) return null;
  return Math.max(raw, named);
}

/** A phone number as Sendblue sends one (`apps/agent/src/sendblue.ts` `E164`). */
const PHONE = /^\+[1-9]\d{6,14}$/;

/**
 * Each person's number, by the handle or guest label the turn knows them by, from the Worker's body: only people named
 * in this chat, each once, each a real number (Dev2, 2026-11-12: everyone in an iMessage group already sees every
 * number in it, so Tex seeing them there shows nobody anything new, and a guest label means nothing to a person).
 */
export function numbersOf(raw, whos) {
  if (!Array.isArray(raw)) return [];
  const here = new Set(whos);
  const seen = new Set();
  const numbers = [];
  for (const entry of raw.slice(0, MAX_SIZE)) {
    const who = typeof entry?.who === "string" ? entry.who : "";
    const phone = typeof entry?.phone === "string" ? entry.phone : "";
    if (!here.has(who) || seen.has(who) || !PHONE.test(phone)) continue;
    seen.add(who);
    numbers.push({ who, phone });
  }
  return numbers;
}

/** A number as a person writes it: "+1 (555) 123-4567" in the US and Canada, as sent anywhere else. */
export function shownNumber(phone) {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone);
  return us ? `+1 (${us[1]}) ${us[2]}-${us[3]}` : phone;
}

/** One person's number in this chat, shown, or "" when the turn wasn't given one. */
export function numberOf(group, who) {
  const phone = (Array.isArray(group?.numbers) ? group.numbers : []).find((entry) => entry.who === who)?.phone;
  return phone ? shownNumber(phone) : "";
}

/**
 * Everyone in the chat, for "who is in this chat" (Dev2, 2026-11-12: Tex said it couldn't see the member list):
 * each account by handle, name and number, each other person by label and number, and how many people that is.
 */
export function rosterLine(group) {
  const size = typeof group?.size === "number" ? group.size : null;
  if (size === null) return "";
  const names = new Map((Array.isArray(group?.names) ? group.names : []).map(({ handle, name }) => [handle, name]));
  const people = Array.isArray(group?.people) ? group.people : [];
  const guests = Array.isArray(group?.guests) ? group.guests : [];
  const numbered = (Array.isArray(group?.numbers) ? group.numbers : []).length > 0;
  const accounts = people.map((handle) => {
    const said = [names.get(handle), numberOf(group, handle)].filter(Boolean).join(", ");
    return said ? `@${handle} (${said})` : `@${handle}`;
  });
  const unlisted = Math.max(0, size - people.length - guests.length);
  const parts = [
    ...accounts,
    ...guests.map((label) => {
      const number = numberOf(group, label);
      return `${label}${number ? ` (${number})` : ""}, on no Context account linked to the number they text from`;
    }),
    ...(unlisted > 0 ? [`${unlisted} more ${unlisted === 1 ? "person" : "people"} you have no name for`] : []),
  ];
  return (
    `Everyone in this chat besides you, ${size} ${size === 1 ? "person" : "people"}, the whole list, read from the chat itself this turn: ${parts.join("; ")}. ` +
    "When asked who is here, answer from this list; you can see it. " +
    (numbered
      ? "Everyone here already sees each other's numbers in the chat, so say a number here whenever a person here would, as in \"the +1 (555) 123-4567 number\". "
      : "") +
    (guests.length > 0
      ? `A guest label is how you know someone with no linked account, never words to say: call them by the name the chat's about note gives them, ${numbered ? "or by their number, " : ""}or ask who they are. ` +
        "When someone here says who a guest is, add it to the chat's about note, label and name, like \"guest-1a2b is Sam, Jo's brother (Jo said so)\". " +
        "Someone with a Context account who shows here as a guest has not linked this number to it: they can text you once from it, on their own, to link it. "
      : "")
  );
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
    rosterLine(group) +
    known +
    "Notes may name people by full name, first name or nickname: the person who tagged you is the one asking, so never tell them they would know, or to ask themselves. "
  );
}
