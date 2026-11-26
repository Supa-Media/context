/**
 * Areas as seats: what an area's `about.md` says about who holds it, and the
 * card that says how to reach whoever that is. Pure — no React, no storage.
 *
 * An area is a folder in the Areas folder (by job, `inAreasNow`). Its seat is
 * a few top-level lines in its `about.md`, each one a property a list could
 * read, so a person, Tex or any agent edits them as text:
 *
 *     owner: "@dev2"
 *     delegate: Claude Code
 *     modes: [Manager, Doer]
 *     metrics:
 *       - PR time to ship, target 2 days
 *     approvals:
 *       - Spending over $20 needs the owner's approval.
 *
 * Which folders are areas: every folder directly in the Areas folder (in PARA
 * each one is an area already), unless its `about.md` says `area: false`; and
 * any deeper folder whose `about.md` declares a seat (one of `SEAT_KEYS`, or
 * `area: true`). Anything else is a plain folder, listed under its area.
 *
 * How to reach a holder is kept once per workspace, not per seat (the owner,
 * 2026-11-23: "per workspace, and everyone with access to the workspace should
 * see details"): a note per holder in the Areas folder's `people/` folder,
 * whose own `about.md` says `area: false`. A login is never written there; an
 * agent's card names the vault item that holds it. See
 * `docs/decisions/app-and-console/areas-as-seats.md`.
 */

import { botKind, botLabel, reachKind, type ReachKind } from "@context/shared/src/areaBots.cjs";
import type { ListNote, PropertyValue } from "../../listBlock/model";
import { ABOUT_NOTE, baseName } from "../../paths";
import { entriesIn, type ItemEntry } from "../model";

/** The three mode labels, in the order they are drawn. Labels, never rules. */
export const MODES = ["Visionary", "Manager", "Doer"] as const;
export type Mode = (typeof MODES)[number];

/** What each mode means, for the hover that explains it. */
export const MODE_TIPS: Readonly<Record<Mode, string>> = {
  Visionary: "Sets direction and decides what good looks like here. Kept apart because deciding what to do pulls against getting it done.",
  Manager: "Checks the work on a loop: reviews it, follows up, keeps the metric on target. Can be a person or a routine.",
  Doer: "Does the hands-on work, often where an agent like Claude Code fits. Kept apart so doing the work doesn't crowd out checking it.",
};

/** The lines that make a deeper folder an area. */
/** `helper` is the old name of `delegate`, still read (the owner, 2026-11-25: one delegate per area, no helpers). */
export const SEAT_KEYS = ["owner", "delegate", "helper", "modes", "metrics", "metric", "approvals"] as const;
/** Says outright whether a folder is an area: `area: false` keeps a folder in the Areas folder plain. */
export const AREA_KEY = "area";
/** The folder in the Areas folder that held the how-to-reach cards; still read, and a person's card stays there. */
export const PEOPLE_FOLDER = "people";
/**
 * The folder beside the Areas folder that holds one folder per bot, `bots/<bot>/about.md` its card and `mail/` its
 * mail (the owner, 2026-11-25: "areas/bots should replace areas/people", then "top level bots yes"). A new bot's card
 * is written there; one still in the Areas folder's own `bots/` or in `people/` is read and changed where it is.
 */
export const BOTS_FOLDER = "bots";

export interface Metric {
  readonly name: string;
  /** What good looks like, as written: `2 days`, `under $600`. Null when none is set. */
  readonly target: string | null;
}

export interface Seat {
  /** The area's folder path. */
  readonly folder: string;
  /** The folder's name as drawn. */
  readonly name: string;
  /** The note the seat's lines are written to, and whether writing creates it. */
  readonly about: { readonly target: string; readonly creates: boolean };
  /** The owner this folder names itself; null when it names none. */
  readonly ownOwner: string | null;
  /** Who holds it: its own owner, else the nearest area above that names one. */
  readonly owner: string | null;
  /** The area the owner comes from when it is not this one; null when it is its own or nobody's. */
  readonly ownerFrom: string | null;
  /**
   * The one bot (or Tex) that acts for this area's person owner here, with the
   * area's modes and approval rules (the owner, 2026-11-25: "1 delegate per
   * area"). A person is never one, and an area a bot owns has none.
   */
  readonly delegate: string | null;
  readonly modes: readonly Mode[];
  readonly metrics: readonly Metric[];
  readonly approvals: readonly string[];
}

export interface AreaNode {
  readonly seat: Seat;
  /** Its sub-areas, in name order. */
  readonly areas: readonly AreaNode[];
  /** Everything else directly in it: notes, pages, sheets and plain folders. `about.md` is the seat, never a row. */
  readonly files: readonly ItemEntry[];
}

/** How to reach one holder, person or agent: one note in `people/`. */
export interface Card {
  /** The owner word it is for, as an owner line writes it: `@dev2`, `Claude Code`. */
  readonly holder: string;
  readonly kind: "person" | "agent";
  readonly phone: string;
  readonly email: string;
  /** An agent's own access notes: where and how it is reached. */
  readonly access: string;
  /** The vault item holding an agent's login: a name only, never the login. */
  readonly vault: string;
  /**
   * The kind of bot an agent is (`grok`), or "" for a plain agent. A bot is
   * somebody's (`belongsTo`, a person's handle) and is given a prompt that
   * names the area it holds (`@context/shared/src/areaBots.cjs`, the owner,
   * 2026-11-25). How Context reaches it is `reach`; its webhook, if any, is
   * kept sealed on the server and never on the card.
   */
  readonly bot: string;
  readonly belongsTo: string;
  readonly reach: ReachKind;
  /**
   * A bot's logo: the name of a picture stored in the workspace, which the
   * bot puts there itself on its first session, or anyone who can edit the
   * card uploads (the owner, 2026-11-25). "" draws the robot.
   */
  readonly avatar: string;
  /**
   * The areas its person lets it work in, each with its cap on the bot's week, as the card writes them:
   * `areas/operations/Scorecard · 20%` (`@context/shared/src/areaRoutines.cjs`). Empty: wherever an area names it.
   */
  readonly worksIn?: readonly string[];
}

const inside = (folder: string) => (folder === "" ? "" : `${folder}/`);

function text(value: PropertyValue | undefined): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return (value[0] ?? "").trim();
  return "";
}

/** A list line. A plain string is one item: a metric or a rule is a sentence, and its commas are its own. */
function list(value: PropertyValue | undefined, commas = false): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" && value.trim() !== "" ? (commas ? value.split(",") : [value]) : [];
  return raw.map((item) => item.trim()).filter((item) => item !== "");
}

function aboutOf(folder: string, notes: readonly ListNote[]): ListNote | null {
  const path = `${inside(folder)}${ABOUT_NOTE}`;
  return notes.find((note) => note.path === path) ?? null;
}

/** Whether `folder` is an area of the Areas folder `root` (see the header). */
export function isArea(folder: string, root: string, notes: readonly ListNote[]): boolean {
  if (folder === root || !folder.startsWith(inside(root))) return false;
  // The cards' folders are never seats, whether or not their `about.md` has been written yet.
  if (folder === peopleFolder(root) || folder === legacyBotsFolder(root) || folder.startsWith(`${legacyBotsFolder(root)}/`)) return false;
  const about = aboutOf(folder, notes);
  const said = text(about?.properties[AREA_KEY]).toLowerCase();
  if (said === "false" || said === "no") return false;
  if (said === "true" || said === "yes") return true;
  if (about !== null && SEAT_KEYS.some((key) => about.properties[key] !== undefined)) return true;
  return !folder.slice(inside(root).length).includes("/");
}

/**
 * `Name · target 2 days` → name and target; a line with no target is all name.
 * Also reads `Name, target 2 days`, the form written by hand in a block list.
 */
export function parseMetric(line: string): Metric {
  const at = line.search(/\s*[,·]\s*target\s+/i);
  if (at === -1) return { name: line.trim(), target: null };
  const target = line.slice(at).replace(/^\s*[,·]\s*target\s+/i, "").trim();
  return { name: line.slice(0, at).trim(), target: target === "" ? null : target };
}

/**
 * The line a metric is written as, in the seat's `metrics: [...]`. An inline
 * list item cannot hold a comma (`setProperty.js` refuses it, and the save
 * failed with "cannot hold a comma"), so the target follows a middle dot and
 * a thousands comma is dropped: `under $1,000` is written `under $1000`.
 */
export function metricLine(metric: Metric): string {
  const name = metric.name.trim().replace(/,/g, "");
  const target = (metric.target?.trim() ?? "").replace(/(\d),(?=\d{3}\b)/g, "$1").replace(/,/g, "");
  return target === "" ? name : `${name} · target ${target}`;
}

/**
 * An area's metrics as its `about.md` says them. The seat's own line is
 * `metrics: [Name · target over $5]`, its first item the area's one metric.
 * A `metric:` line (and a `target:` beside it) is read too, as the data
 * sources design review sketches it, and wins over `metrics:`: it is the
 * area's one metric, and any `metrics:` item of another name follows it.
 * Saving the seat writes the `metrics:` line and removes those two
 * (`seatChanges`), so the area says its metric once.
 */
export function metricsOf(props: Readonly<Record<string, PropertyValue>>): Metric[] {
  const listed = list(props.metrics).map(parseMetric);
  const single = text(props.metric);
  if (single === "") return listed;
  const said = parseMetric(single);
  const target = text(props.target);
  const first: Metric = { name: said.name, target: target === "" ? said.target : target };
  const key = first.name.toLowerCase();
  return [first, ...listed.filter((metric) => metric.name.trim().toLowerCase() !== key)];
}

/**
 * A metric's name as it is matched, between an area's line and a metric
 * note's `metric:`: any case, runs of spaces as one, and without commas,
 * which a seat line cannot hold (`metricLine` drops them), so "Revenue, net"
 * picked is still found as "Revenue net".
 */
export function metricKey(name: string): string {
  return name.replace(/,/g, "").trim().replace(/\s+/g, " ").toLowerCase();
}

function modesOf(value: PropertyValue | undefined): Mode[] {
  const said = new Set(list(value, true).map((word) => word.toLowerCase()));
  return MODES.filter((mode) => said.has(mode.toLowerCase()));
}

/** The seat `folder` holds, its owner inherited from the nearest area above that names one, below `root`. */
export function seatOf(folder: string, root: string, notes: readonly ListNote[]): Seat {
  const about = aboutOf(folder, notes);
  const props = about?.properties ?? {};
  const ownOwner = text(props.owner) || null;
  let owner = ownOwner;
  let ownerFrom: string | null = null;
  if (owner === null) {
    for (let at = parentOf(folder); at !== null && at.startsWith(inside(root)) && at !== root; at = parentOf(at)) {
      const found = text(aboutOf(at, notes)?.properties.owner);
      if (found !== "") {
        owner = found;
        ownerFrom = at;
        break;
      }
    }
  }
  return {
    folder,
    name: baseName(folder),
    about: { target: `${inside(folder)}${ABOUT_NOTE}`, creates: about === null },
    ownOwner,
    owner,
    ownerFrom,
    delegate: text(props.delegate) || text(props.helper) || null,
    modes: modesOf(props.modes),
    metrics: metricsOf(props),
    approvals: list(props.approvals),
  };
}

function parentOf(path: string): string | null {
  const at = path.lastIndexOf("/");
  return at === -1 ? null : path.slice(0, at);
}

/**
 * `folder` and everything under it that the notes reach, as the List and the
 * Chart draw it. `root` is the Areas folder. The `people/` cards and each
 * `about.md` are not rows.
 */
export function areaTree(folder: string, root: string, notes: readonly ListNote[]): AreaNode {
  const areas: AreaNode[] = [];
  const files: ItemEntry[] = [];
  for (const entry of entriesIn(folder, notes)) {
    if (entry.kind === "folder" && isArea(entry.path, root, notes)) areas.push(areaTree(entry.path, root, notes));
    else if (entry.kind === "file" && entry.name === ABOUT_NOTE) continue;
    else if (entry.kind === "folder" && (entry.path === peopleFolder(root) || entry.path === legacyBotsFolder(root))) continue;
    // An area's mail folder is its Mail, shown on its own (`areaMail.ts`), never a plain folder or a sub-area.
    else if (entry.kind === "folder" && entry.path === `${inside(folder)}mail` && folder !== root) continue;
    else files.push(entry);
  }
  areas.sort((a, b) => a.seat.name.localeCompare(b.seat.name));
  return { seat: seatOf(folder, root, notes), areas, files };
}

/**
 * A seat's dot: an empty ring with no owner, amber when its first metric
 * misses its target, else quiet. ("No manager loop", amber for modes without
 * Manager, was removed by the owner on 2026-11-24: modes are labels, never rules.)
 */
export type Health = "ring" | "warn" | "neutral";
export function healthOf(seat: Seat, missed = false): Health {
  if (seat.owner === null) return "ring";
  return missed ? "warn" : "neutral";
}

/** How many of an area's direct sub-areas need a look: no owner, or a metric off its target. */
export function needLook(node: AreaNode, missed: (seat: Seat) => boolean = () => false): number {
  return node.areas.filter((child) => healthOf(child.seat, missed(child.seat)) !== "neutral").length;
}

/** An area's folder name as a title: `pipeline-watch` is drawn "Pipeline watch". */
export function areaTitle(name: string): string {
  const words = name.replace(/^\d+[-_ ]+/, "").replace(/[-_]+/g, " ").trim();
  return words === "" ? name : words.charAt(0).toUpperCase() + words.slice(1);
}

export type FileKind = "note" | "page" | "sheet" | "folder" | "file";

/** What a row in an area is: a plain folder, a page, a CSV sheet, a note, or another file. */
export function fileKind(entry: ItemEntry): FileKind {
  if (entry.kind === "folder") return "folder";
  const name = entry.name.toLowerCase();
  if (name.endsWith(".page.md")) return "page";
  if (name.endsWith(".csv")) return "sheet";
  if (name.endsWith(".md")) return "note";
  return "file";
}

const KIND_WORDS: Readonly<Record<FileKind, readonly [string, string]>> = {
  sheet: ["sheet", "sheets"],
  note: ["note", "notes"],
  folder: ["folder", "folders"],
  page: ["page", "pages"],
  file: ["file", "files"],
};

/** "2 sheets · 1 note · 1 folder": an area's files counted by kind, in the order they first appear. */
export function kindCounts(files: readonly ItemEntry[]): string {
  const counts = new Map<FileKind, number>();
  for (const entry of files) counts.set(fileKind(entry), (counts.get(fileKind(entry)) ?? 0) + 1);
  return [...counts].map(([kind, n]) => `${n} ${KIND_WORDS[kind][n === 1 ? 0 : 1]}`).join(" · ");
}

/** "38 notes": how many notes a plain folder holds, at any depth. */
export function notesUnder(folder: string, notes: readonly ListNote[]): number {
  const prefix = `${folder}/`;
  return notes.filter((note) => note.path.startsWith(prefix)).length;
}

/** The edits a seat pop-up saves. */
export interface SeatEdit {
  readonly owner: string | null;
  readonly delegate: string | null;
  readonly modes: readonly Mode[];
  readonly metrics: readonly Metric[];
  readonly approvals: readonly string[];
}

type Change = readonly [string, string | readonly string[] | null];

/** The lines of `about.md` a seat edit writes; an empty one is removed rather than left blank. */
export function seatChanges(edit: SeatEdit): Change[] {
  const lines = (values: readonly string[]) => {
    const kept = values.map((value) => value.trim()).filter((value) => value !== "");
    return kept.length === 0 ? null : kept;
  };
  return [
    ["owner", edit.owner?.trim() || null],
    ["delegate", edit.delegate?.trim() || null],
    // The old name of the line, cleared so it never says something else.
    ["helper", null],
    ["modes", edit.modes.length === 0 ? null : MODES.filter((mode) => edit.modes.includes(mode))],
    ["metrics", lines(edit.metrics.filter((metric) => metric.name.trim() !== "").map(metricLine))],
    // The `metrics:` line now says the metric; a hand-written `metric:` and `target:` would win over it (`metricsOf`).
    ["metric", null],
    ["target", null],
    ["approvals", lines(edit.approvals)],
  ];
}

/* ------------------------------ cards ------------------------------ */

/** The note name a holder's card is kept under: `@dev2` → `dev2`, `Claude Code` → `claude-code`. */
export function cardSlug(holder: string): string {
  const slug = holder
    .trim()
    .replace(/^@+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "someone" : slug;
}

export function peopleFolder(root: string): string {
  return `${inside(root)}${PEOPLE_FOLDER}`;
}

/** Where bots live: `bots/` beside the Areas folder (`bots` itself when the Areas folder is at the top). */
export function botsFolder(root: string): string {
  const cut = root.lastIndexOf("/");
  return cut < 0 ? BOTS_FOLDER : `${root.slice(0, cut)}/${BOTS_FOLDER}`;
}

/** Where bots lived first, inside the Areas folder: `<areas>/bots`. Still read, and a card there is changed there. */
export function legacyBotsFolder(root: string): string {
  return `${inside(root)}${BOTS_FOLDER}`;
}

/** The bots folder `path` is a bot's folder of, `bots/<bot>` (either one), or null. */
export function botsFolderOfBot(root: string, path: string): string | null {
  for (const folder of [botsFolder(root), legacyBotsFolder(root)]) {
    const prefix = `${folder}/`;
    if (path.startsWith(prefix) && /^[^/]+$/.test(path.slice(prefix.length))) return folder;
  }
  return null;
}

/** Whether `path` is a bot's card: `bots/<bot>/about.md`, beside the Areas folder or, as before, in it. */
export function isBotCardPath(root: string, path: string): boolean {
  return /\/about\.md$/i.test(path) && botsFolderOfBot(root, path.slice(0, -"/about.md".length)) !== null;
}

/**
 * Where `holder`'s card is: the one already written, in `bots/<holder>/about.md` (beside the Areas folder, else in
 * it) or, as before, `people/<holder>.md`. A card nobody has written yet goes in `bots/` for an agent and `people/`
 * for a person.
 */
export function cardPath(root: string, holder: string, notes: readonly ListNote[] = [], kind: Card["kind"] = "agent"): string {
  const home = `${botsFolder(root)}/${cardSlug(holder)}/${ABOUT_NOTE}`;
  const written = [home, `${legacyBotsFolder(root)}/${cardSlug(holder)}/${ABOUT_NOTE}`, `${peopleFolder(root)}/${cardSlug(holder)}.md`];
  const found = written.find((path) => notes.some((note) => note.path === path));
  if (found !== undefined) return found;
  return kind === "agent" ? home : written[2]!;
}

/**
 * The folder in the Areas folder a card at `path` sits in, whose `about.md` must say `area: false` so it is never
 * drawn as an area; null for a card beside the Areas folder, which no area can be mistaken for.
 */
export function cardsFolderOf(root: string, path: string): string | null {
  if (path.startsWith(`${legacyBotsFolder(root)}/`)) return legacyBotsFolder(root);
  if (path.startsWith(`${peopleFolder(root)}/`)) return peopleFolder(root);
  return null;
}

/**
 * `holder`'s card, or an empty one of `kind` when nobody has written it yet. `at` is the card's own path where the
 * caller already found it: a card whose `holder:` words are longer than its folder's name is still that card.
 */
export function cardOf(holder: string, kind: Card["kind"], root: string, notes: readonly ListNote[], at?: string): Card & { readonly creates: boolean; readonly path: string } {
  const path = at ?? cardPath(root, holder, notes, kind);
  const note = notes.find((each) => each.path === path) ?? null;
  const props = note?.properties ?? {};
  const said = text(props.kind);
  return {
    holder,
    kind: said === "person" || said === "agent" ? said : kind,
    phone: text(props.phone),
    email: text(props.email),
    access: text(props.access),
    vault: text(props.vault),
    bot: botKind(text(props.bot)),
    belongsTo: text(props.belongs_to),
    reach: reachKind(text(props.reach)),
    avatar: text(props.avatar),
    worksIn: list(props.works_in),
    creates: note === null,
    path,
  };
}

/** The lines a card writes. A person's card has no access lines and an agent's no phone; empty lines are removed. */
export function cardChanges(card: Card): Change[] {
  const v = (value: string) => (value.trim() === "" ? null : value.trim());
  const person = card.kind === "person";
  return [
    ["holder", card.holder.trim()],
    ["kind", card.kind],
    ["phone", person ? v(card.phone) : null],
    ["email", person ? v(card.email) : null],
    // Who acts for a person is each area's delegate now (the owner, 2026-11-25); the card's old lines go.
    ["delegation", null],
    ["delegation_how", null],
    ["access", person ? null : v(card.access)],
    ["vault", person ? null : v(card.vault)],
    // A bot's own lines; a plain agent and a person have none.
    ["bot", person ? null : v(card.bot)],
    ["belongs_to", person || card.bot.trim() === "" ? null : v(card.belongsTo)],
    ["reach", person || card.bot.trim() === "" ? null : card.reach],
    ["avatar", person ? null : v(card.avatar)],
  ];
}

/** The `people/about.md` and `bots/about.md` lines that keep the cards' folders out of the areas. */
export const PEOPLE_ABOUT: readonly Change[] = [[AREA_KEY, "false"]];

/** One line saying how to reach a holder, for a hover or a menu; "" when the card is empty. */
export function reachLine(card: Card): string {
  const out: string[] = [];
  if (card.kind === "person") {
    if (card.phone !== "") out.push(card.phone);
    if (card.email !== "") out.push(card.email);
  } else {
    if (card.bot !== "") out.push(card.belongsTo === "" ? botLabel(card.bot) : `${card.belongsTo}'s ${botLabel(card.bot)}`);
    if (card.access !== "") out.push(card.access);
    if (card.vault !== "") out.push(`login in the vault: ${card.vault}`);
  }
  return out.join(" · ");
}
