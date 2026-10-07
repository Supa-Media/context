/**
 * Every word "For your teams" puts on screen: the cards on a personal
 * workspace's What changed page, the note's preview, and its settings.
 *
 * Same rules as `./copy.ts`. The privacy promise is said the same way
 * everywhere: the meeting or email stays with you, and the team gets a new
 * note. Words from a bucket (a team's name, a folder, a note) are contained.
 */

import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import type { LeftOutReason, RouteCard } from "./types";

export const teamsCopy = {
  section: (n: number) => `For your teams (${n})`,
  add: (team: string) => `Add to ${team}`,
  preview: (team: string) => `Before it goes to ${team}`,
  previewLede: "This is exactly what the team will read. Edit it, or take anything out.",
  back: "‹ What changed",
  cancel: "Cancel",
  titleLabel: "Headline",
  bodyLabel: "Note",
  goesIn: (card: RouteCard) =>
    card.folderTitle ? `Goes in ${card.team} › ${isolateForDisplay(card.folderTitle)}` : `Goes in ${card.team}`,
  footer: (kind: string) => `Ends with: “From one of your ${SOURCE_NOUNS[kind] ?? "notes"}. Only you can open it.”`,
  leftOutHeading: "Left out, and why",
  nothingLeftOut: "Nothing was held back.",
  canGoHeading: "What can go to a team",
  canGo: "Product decisions, priorities, dates and project updates. Nothing about a person’s job, pay, health or life outside work.",
  sending: "Adding…",
  sent: (team: string) => `Added to ${team}.`,
  kept: "Not added. The team won’t see it.",
  failed: (team: string) => `That note couldn’t be added to ${team}. Have another look.`,
  settingsHeading: "Sending to your teams",
  settingsLede: "When something in your inbox is about a team you’re in, a note for that team waits here. Nothing goes to a team until you press Add.",
  teamSwitch: (team: string) => `Look for notes for ${team}`,
  keepLabel: "Anything else to keep to yourself?",
  keepHint: "In your own words. It’s read before any note is written.",
  keepPlaceholder: "For example: fundraising and anything about investors.",
  save: "Save",
  saved: "Saved",
  // The checklist (board 9): every note at once, each one's original a tap away.
  tickedOf: (ticked: number, all: number) => `${ticked} of ${all} ticked`,
  all: (n: number) => `All ${n}`,
  addTicked: (cards: readonly RouteCard[]) => {
    if (cards.length === 0) return "Add";
    const split = byTeam(cards);
    if (split.length === 1) return cards.length === 1 ? `Add 1 to ${split[0][0]}` : `Add ${cards.length} ticked to ${split[0][0]}`;
    return `Add ${cards.length} ticked: ${split.map(([team, n]) => `${n} to ${team}`).join(", ")}`;
  },
  addTickedShort: (n: number) => (n === 1 ? "Add 1 note" : `Add ${n} ticked`),
  adding: (n: number) => (n === 1 ? "Adding 1 note…" : `Adding ${n} notes…`),
  skipRest: "Skip the rest",
  sentMany: (sent: readonly RouteCard[], missed: number) => {
    const split = byTeam(sent).map(([team, n]) => `${n} to ${team}`).join(", ");
    const added = sent.length === 1 ? `Added 1 note to ${sent[0].team}.` : `Added ${sent.length} notes: ${split}.`;
    if (missed === 0) return added;
    return `${added} ${missed === 1 ? "1 couldn’t be added and is" : `${missed} couldn’t be added and are`} still here.`;
  },
  failedMany: (missed: number) =>
    missed === 1 ? "That note couldn’t be added. It’s still here." : `None of the ${missed} notes could be added. They’re still here.`,
  skipped: (n: number) => (n === 1 ? "Skipped 1 note. The team won’t see it." : `Skipped ${n} notes. The teams won’t see them.`),
  where: (card: RouteCard) => (card.folderTitle ? `${card.team} › ${isolateForDisplay(card.folderTitle)}` : card.team),
  keptBack: (leftOut: RouteCard["leftOut"]) => {
    if (leftOut.length === 0) return "Nothing kept back";
    const named = leftOut.slice(0, 2).map((held) => isolateForDisplay(held.what));
    const more = leftOut.length - named.length;
    return `Kept back: ${named.join(", ")}${more > 0 ? `, ${more} more` : ""}`;
  },
  showOriginal: "Show original",
  hideOriginal: "Hide original",
  originalHeading: "The original · only you can see it",
  openSource: (kind: string) => `Open ${SOURCE_NOUN[kind] ?? "it"} ↗`,
  noLines: "Open the original to read it. This note was written before Context kept the lines it used.",
  teamGets: (team: string) => `What ${team} gets`,
  teamGetsLede: "The highlighted lines, reworded into one new note. The struck lines stay with you.",
  teamGetsLedeNoLines: "One new note, in Context’s own words. Anything kept back stays with you.",
  editNote: "Edit the note",
  dontAdd: "Don’t add",
};

/** Teams by how many notes each gets, most first; ties keep the list's order. */
function byTeam(cards: readonly RouteCard[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const card of cards) counts.set(card.team, (counts.get(card.team) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * The note in one line, for its row: its Markdown read as plain words, cut at
 * a word near `max`. The note itself is the team's to read; this is the gist.
 */
export function gist(body: string, max = 150): string {
  const plain = body
    .split("\n")
    .map((line) => line.replace(/^\s*(#{1,6}\s+|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+|>\s?)/, "").trim())
    .filter(Boolean)
    .map((line) => (/[.!?:;…]$/.test(line) ? line : `${line}.`))
    .join(" ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|`|==)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= max) return isolateForDisplay(plain);
  const cut = plain.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return isolateForDisplay(`${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`);
}

const SOURCE_NOUNS: Record<string, string> = { meeting: "meetings", messages: "emails", chat: "AI chats", note: "notes" };
const SOURCE_NOUN: Record<string, string> = { meeting: "meeting", messages: "email", chat: "chat", note: "note" };

export const LEFT_OUT_WHY: Record<LeftOutReason, string> = {
  people: "People’s jobs and roles stay private",
  personal: "Personal life stays private",
  meeting: "Meetings and messages stay with you",
  owner: "You keep this to yourself",
};
