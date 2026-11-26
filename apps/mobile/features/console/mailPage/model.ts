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

/** A bot conversation's card, `bots/<bot>/about.md` beside its `mail/` folder, where its logo is named; else null. */
export function botCardOf(conversation: Pick<Conversation, "path" | "place">): string | null {
  if (conversation.place.kind !== "bot") return null;
  const folder = conversation.path.replace(/\/mail\/[^/]+$/, "");
  return folder === conversation.path ? null : `${folder}/about.md`;
}

/** The `avatar:` a card's front matter names (the logo's leaf beside the card), or "" when it names none. */
export function avatarOf(text: string): string {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  const line = /^avatar:[ \t]*(.*)$/m.exec(head)?.[1]?.trim() ?? "";
  return line.replace(/^["']|["']$/g, "").trim();
}

/** Whether a mail name is a person (`@seyi`) rather than an agent or bot (`grok-bot`, `claude`). */
export function isPersonName(name: string): boolean {
  return name.startsWith("@");
}

/** One message as the thread draws it: whether it opens a new run (a header with face and name) or a new day. */
export interface MessageLine<T> {
  readonly event: T;
  readonly header: boolean;
  readonly day: string | null;
}

/** Five minutes: a second message from the same person inside it sits under the first one's header, Slack style. */
const RUN_MS = 5 * 60 * 1000;

/**
 * The thread as runs (Dev2, 2026-11-26: "a more slack style of messages instead of a left right message bubble
 * style"): every message left-aligned, a header with face, name and time when the sender changes, a gap passes or the
 * day turns, and a day line between days.
 */
export function messageLines<T extends { readonly from: string; readonly at: string }>(events: readonly T[], now: number = Date.now()): MessageLine<T>[] {
  const out: MessageLine<T>[] = [];
  let lastDay = "";
  let last: T | null = null;
  for (const event of events) {
    const time = Date.parse(event.at);
    const day = Number.isNaN(time) ? "" : new Date(time).toDateString();
    const newDay = day !== "" && day !== lastDay;
    const gap = last === null || Number.isNaN(time) || time - Date.parse(last.at) > RUN_MS;
    const header = newDay || gap || last === null || cardSlug(last.from) !== cardSlug(event.from);
    out.push({ event, header, day: newDay ? dayLabel(time, now) : null });
    if (day !== "") lastDay = day;
    last = event;
  }
  return out;
}

/** "Today", "Yesterday", or "Mon, Nov 24". */
export function dayLabel(time: number, now: number = Date.now()): string {
  const day = new Date(time).toDateString();
  if (day === new Date(now).toDateString()) return "Today";
  if (day === new Date(now - 86_400_000).toDateString()) return "Yesterday";
  return new Date(time).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** A clock time alone, "6:10 PM", for a message header and the hover time of a message under it. */
export function clockLabel(at: string): string {
  const time = Date.parse(at);
  return Number.isNaN(time) ? "" : new Date(time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
