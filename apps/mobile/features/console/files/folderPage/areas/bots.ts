/**
 * The Areas folder's bots and the mail between them, as the Bots and Mail views draw them (the owner, 2026-11-25:
 * "how can I view all the bots we have, view the conversations happening across bots, and maybe even talk to a bot
 * directly inside of context"). Pure: no React, no storage.
 *
 * - **A bot** is a card: `bots/<bot>/about.md` in the Areas folder, or an older agent card in `people/` that says
 *   `bot:`. It is somebody's (`belongs_to:`), holds the areas that name it owner or delegate, and may list where its
 *   person lets it work, each with a cap on its week (`works_in:`, `@context/shared/src/areaRoutines.cjs`).
 * - **A conversation** is one mail note: `<area>/mail/<sender>.md` with whoever holds the area, or
 *   `bots/<bot>/mail/<sender>.md` with that bot. Mail, never a live chat: a bot answers when it answers, and what it
 *   thinks in between is in its own app, not here.
 */

import { areaRoutineOf, parseWorksIn } from "@context/shared/src/areaRoutines.cjs";
import { isNotePath } from "@context/shared/src/fileKinds.cjs";
import type { ListNote, PropertyValue } from "../../listBlock/model";
import { areaTitle, areaTree, botsFolder, cardOf, cardSlug, isBotCardPath, peopleFolder, type AreaNode, type Card } from "./seat";
import { senderOf } from "./areaMail";

export interface BotArea {
  readonly folder: string;
  readonly title: string;
  /** Owns it outright, or acts for its person owner. */
  readonly role: "owner" | "delegate";
  /** Its share of the bot's week here, or null for none. */
  readonly cap: number | null;
  /** False when its card lists where it works and this area is not on it: Context sends it nothing from here. */
  readonly listed: boolean;
}

export interface Bot {
  readonly name: string;
  readonly card: Card & { readonly path: string };
  /** Its person, `@seyi`; "" when the card names nobody. */
  readonly whose: string;
  /** Whether the reader is its person, who alone sets where it works and its caps. */
  readonly mine: boolean;
  readonly areas: readonly BotArea[];
  /** Its own mail folder: `bots/<bot>/mail`, for writing to it outside any area. */
  readonly mailFolder: string;
}

export interface Conversation {
  readonly path: string;
  /** Where it is kept: the area's folder, or the bot's. */
  readonly place: string;
  readonly placeTitle: string;
  /** Who wrote it, from the note's name (`seyi`, `grok-bot`). */
  readonly sender: string;
  /** Who it is with: the area's bot or owner, or the bot whose folder it is in; null when nobody holds the area. */
  readonly with: string | null;
  /** Whether both sides are bots. */
  readonly botToBot: boolean;
  /** Whether the reader wrote it. */
  readonly mine: boolean;
}

function word(value: PropertyValue | undefined): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return (value[0] ?? "").trim();
  return "";
}

const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase() && (a ?? "").trim() !== "";

/** Every bot card the reader can see, its own first. */
export function botsOf(root: string, notes: readonly ListNote[], me: string | undefined): Bot[] {
  const people = `${peopleFolder(root)}/`;
  const names = new Map<string, string>();
  for (const note of notes) {
    const inPeople = note.path.startsWith(people) && !note.path.slice(people.length).includes("/");
    if (!isBotCardPath(root, note.path) && !(inPeople && word(note.properties.bot) !== "")) continue;
    if (note.path.endsWith("/about.md") && !isBotCardPath(root, note.path)) continue;
    const name = word(note.properties.holder) || note.path.split("/").slice(-2)[0] || "";
    if (name === "" || names.has(cardSlug(name))) continue;
    names.set(cardSlug(name), name);
  }
  const tree = areaTree(root, root, notes);
  const out: Bot[] = [];
  for (const name of names.values()) {
    const card = cardOf(name, "agent", root, notes);
    const works = parseWorksIn(notes.find((note) => note.path === card.path)?.properties.works_in);
    const areas: BotArea[] = [];
    const walk = (node: AreaNode) => {
      const { seat } = node;
      const role = same(seat.ownOwner, name) ? "owner" : same(seat.delegate, name) && seat.owner !== null && seat.owner.startsWith("@") ? "delegate" : null;
      if (role !== null) {
        const entry = works?.find((item) => item.area.toLowerCase() === seat.folder.toLowerCase());
        areas.push({ folder: seat.folder, title: seat.folder === root ? "The whole workspace" : areaTitle(seat.name), role, cap: entry?.cap ?? null, listed: works === null || entry !== undefined });
      }
      for (const child of node.areas) walk(child);
    };
    walk(tree);
    out.push({ name, card, whose: card.belongsTo, mine: me !== undefined && same(card.belongsTo, me), areas, mailFolder: `${botsFolder(root)}/${cardSlug(name)}/mail` });
  }
  return out.sort((a, b) => Number(b.mine) - Number(a.mine) || a.whose.localeCompare(b.whose) || a.name.localeCompare(b.name));
}

/** Every mail note under the Areas folder the reader can see, each with who is on either side. */
export function conversationsOf(root: string, notes: readonly ListNote[], bots: readonly Bot[], me: string | undefined): Conversation[] {
  const prefix = root === "" ? "" : `${root}/`;
  const tree = areaTree(root, root, notes);
  const holderOf = new Map<string, string | null>();
  const walk = (node: AreaNode) => {
    const { seat } = node;
    const owner = seat.ownOwner ?? seat.owner;
    holderOf.set(seat.folder, owner !== null && owner.startsWith("@") ? (seat.delegate ?? owner) : owner);
    for (const child of node.areas) walk(child);
  };
  walk(tree);
  const isBot = (who: string | null) => who !== null && bots.some((bot) => cardSlug(bot.name) === cardSlug(who));
  const out: Conversation[] = [];
  for (const note of notes) {
    if (!note.path.startsWith(prefix) || !isNotePath(note.path)) continue;
    const match = /^(.+)\/mail\/([^/]+)$/.exec(note.path);
    if (match === null) continue;
    const place = match[1]!;
    const botFolder = place.startsWith(`${botsFolder(root)}/`) && !place.slice(botsFolder(root).length + 1).includes("/");
    const bot = botFolder ? bots.find((each) => `${botsFolder(root)}/${cardSlug(each.name)}` === place) : undefined;
    if (botFolder && bot === undefined) continue;
    if (!botFolder && !holderOf.has(place)) continue;
    const sender = senderOf(note.path);
    const other = bot !== undefined ? bot.name : (holderOf.get(place) ?? null);
    out.push({
      path: note.path,
      place,
      placeTitle: bot !== undefined ? `${bot.name}'s mail` : `${place === root ? "Workspace" : areaTitle(place.slice(place.lastIndexOf("/") + 1))} mail`,
      sender,
      with: other,
      botToBot: isBot(sender) && isBot(other),
      mine: me !== undefined && cardSlug(me) === sender,
    });
  }
  return out;
}

/** The conversations a bot is in: written by it, or with it. */
export function mailOfBot(bot: Bot, conversations: readonly Conversation[]): Conversation[] {
  const slug = cardSlug(bot.name);
  return conversations.filter((each) => each.sender === slug || (each.with !== null && cardSlug(each.with) === slug));
}

/** The routine notes of the areas a bot holds: `<area>/routines/<how often>/<name>.md`. */
export function routinesOfBot(bot: Bot, root: string, notes: readonly ListNote[]): { path: string; name: string; how: string; area: string }[] {
  const areas = new Map(bot.areas.map((area) => [area.folder, area.title]));
  const out: { path: string; name: string; how: string; area: string }[] = [];
  for (const note of notes) {
    const routine = areaRoutineOf(note.path, root);
    if (routine === null || !areas.has(routine.area)) continue;
    const name = routine.name.replace(/[-_]+/g, " ");
    out.push({ path: note.path, name: name.charAt(0).toUpperCase() + name.slice(1), how: routine.cadence === null ? `"${routine.folder}" isn't a schedule` : routine.folder.replace(/-/g, " "), area: areas.get(routine.area) ?? routine.area });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** The note a reader writes to a bot in, outside any area: `bots/<bot>/mail/<me>.md`. */
export function botMailNote(bot: Bot, me: string): string {
  return `${bot.mailFolder}/${cardSlug(me)}.md`;
}

/** What Refresh asks: the bot sends its name and logo again, and its card changes where they differ. */
export const REFRESH_ASK =
  "Please check your card here: if your name or your logo has changed in your own app, send the new ones to your card now, the same way you put your logo there the first time.";
