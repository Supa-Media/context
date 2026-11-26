/**
 * The Mail page's conversations, from the notes with mail the reader may see (`/files/mail`,
 * `apps/mcp/src/live/mailNotesRoute.js`). Pure: no React, no storage.
 *
 * Three kinds, as the boards drew them (the owner, 2026-11-25):
 * - **Bot**: a note in a bot's own mail, `bots/<bot>/mail/<sender>.md` (or where bots lived first, in the Areas
 *   folder's `bots/`). About the bot itself.
 * - **Area**: a note in an area's mail, `<area>/mail/<sender>.md` inside the Areas folder. Work talk; whoever holds
 *   the area is pinged.
 * - **Note**: a ```mail block anywhere else, agents working on that note together.
 *
 * The files stay where they are; this only gathers them.
 */

import { withoutTextExtension } from "@context/shared/src/fileKinds.cjs";
import { botsFolderOfBot, cardSlug } from "../files/folderPage/areas/seat";

export interface MailLast {
  readonly at: string;
  readonly from: string;
  readonly to: string | null;
  readonly used: number | null;
  readonly text: string;
}

/** One note with mail, as the gateway answers it. */
export interface MailNoteRow {
  readonly path: string;
  readonly count: number;
  readonly joined: readonly string[];
  readonly last: MailLast | null;
}

export type MailPlace =
  | { readonly kind: "bot"; readonly bot: string }
  | { readonly kind: "area"; readonly area: string }
  | { readonly kind: "note" };

export interface Conversation extends MailNoteRow {
  readonly place: MailPlace;
  /** "You ↔ Finance", "Grok Bot ↔ Finance", or the note's own name. */
  readonly title: string;
  /** Who the reader writes to here: the bot, the area, or everyone on the note. */
  readonly other: string;
  /** "Area · areas/finance/mail/seyi.md". */
  readonly where: string;
  /** Whether the newest message is from someone other than the reader, after they last read it. */
  readonly fresh: boolean;
}

export type MailView = "all" | "bots" | "areas" | "notes";

export const MAIL_VIEWS: readonly { readonly id: MailView; readonly label: string }[] = [
  { id: "all", label: "All" },
  { id: "bots", label: "Bots" },
  { id: "areas", label: "Areas" },
  { id: "notes", label: "Notes" },
];

/** `grok-bot` → `Grok Bot`; `@seyi` stays `@seyi`. */
export function nameOf(slug: string): string {
  if (slug.startsWith("@")) return slug;
  return slug
    .split(/[-_]+/)
    .filter((part) => part !== "")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

const leaf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Where a mail note is: a bot's own mail, an area's, or any other note. */
export function placeOf(path: string, areasRoot: string): MailPlace {
  const match = /^(.+)\/mail\/[^/]+$/.exec(path);
  if (match !== null) {
    const folder = match[1]!;
    if (areasRoot !== "" && botsFolderOfBot(areasRoot, folder) !== null) return { kind: "bot", bot: leaf(folder) };
    if (areasRoot === "" && /^bots\/[^/]+$/.test(folder)) return { kind: "bot", bot: leaf(folder) };
    if (areasRoot !== "" && folder.startsWith(`${areasRoot}/`)) return { kind: "area", area: folder };
  }
  return { kind: "note" };
}

/** Whether `name` (a mail name or `@handle`) is the reader `me` (`@seyi`). */
export function isMe(name: string, me: string | undefined): boolean {
  if (me === undefined || me === "") return false;
  return cardSlug(name) === cardSlug(me);
}

/** The words for one side: "You", "@seyi", "Grok Bot". */
export function sideName(name: string, me: string | undefined): string {
  if (isMe(name, me)) return "You";
  return nameOf(name);
}

/**
 * The reader's last look at each note, as `at` of the newest message they had seen, and under `SINCE` when they
 * first looked on this device: older mail is not news.
 */
export type Seen = ReadonlyMap<string, string>;
export const SINCE = "\u0000since";

export function conversationsOf(rows: readonly MailNoteRow[], areasRoot: string, me: string | undefined, seen: Seen = new Map()): Conversation[] {
  return rows.map((row) => {
    const place = placeOf(row.path, areasRoot);
    // A person's note is named without the @ (`mail/shyoh.md`); who joined says which it was.
    const slug = withoutTextExtension(leaf(row.path));
    const sender = row.joined.find((name) => cardSlug(name) === slug) ?? slug;
    const title =
      place.kind === "bot"
        ? `${sideName(sender, me)} ↔ ${nameOf(place.bot)}`
        : place.kind === "area"
          ? `${sideName(sender, me)} ↔ ${nameOf(leaf(place.area))}`
          : nameOf(withoutTextExtension(leaf(row.path)));
    const kind = place.kind === "bot" ? "Bot" : place.kind === "area" ? "Area" : "Note";
    const other = place.kind === "bot" ? nameOf(place.bot) : place.kind === "area" ? nameOf(leaf(place.area)) : "everyone on this note";
    const last = row.last;
    const fresh = last !== null && !isMe(last.from, me) && (seen.get(row.path) ?? seen.get(SINCE) ?? "") < last.at;
    return { ...row, place, title, other, where: `${kind} · ${row.path}`, fresh };
  });
}

export interface MailGroup {
  readonly key: string;
  readonly title: string;
  readonly conversations: readonly Conversation[];
}

/**
 * The list for one view, newest first. All is one group; Bots groups by bot, each bot's own mail first and then the
 * area mail it wrote in; Areas groups by area; Notes is every other note with mail.
 */
export function groupsFor(view: MailView, conversations: readonly Conversation[]): MailGroup[] {
  const newest = [...conversations].sort((a, b) => (b.last?.at ?? "").localeCompare(a.last?.at ?? "") || a.path.localeCompare(b.path));
  if (view === "all") return newest.length === 0 ? [] : [{ key: "all", title: "", conversations: newest }];
  if (view === "notes") {
    const notes = newest.filter((each) => each.place.kind === "note");
    return notes.length === 0 ? [] : [{ key: "notes", title: "", conversations: notes }];
  }
  if (view === "areas") {
    const byArea = new Map<string, Conversation[]>();
    for (const each of newest) if (each.place.kind === "area") byArea.set(each.place.area, [...(byArea.get(each.place.area) ?? []), each]);
    return [...byArea].map(([area, list]) => ({ key: area, title: area.split("/").slice(1).map(nameOf).join(" / ") || nameOf(area), conversations: list }));
  }
  const bots = new Set<string>();
  for (const each of newest) if (each.place.kind === "bot") bots.add(each.place.bot);
  const out: MailGroup[] = [];
  for (const bot of bots) {
    const own = newest.filter((each) => each.place.kind === "bot" && each.place.bot === bot);
    const inAreas = newest.filter((each) => each.place.kind === "area" && each.joined.some((name) => cardSlug(name) === bot));
    out.push({ key: bot, title: nameOf(bot), conversations: [...own, ...inAreas] });
  }
  return out;
}

/** How many conversations have something new for the reader: the rail's dot. */
export function freshCount(conversations: readonly Conversation[]): number {
  return conversations.filter((each) => each.fresh).length;
}
