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
  forTeam: (team: string) => `For ${team}`,
  newNote: "New note",
  inFolder: (card: RouteCard) => (card.folderTitle ? `In ${isolateForDisplay(card.folderTitle)}` : `In ${card.team}`),
  stays: "The original stays with you. The team gets a new note that says it came from you.",
  leftOut: (n: number) => (n === 1 ? "Left out: 1 thing" : `Left out: ${n} things`),
  keep: "Keep it here",
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
  kept: "Kept here. The team won’t see it.",
  failed: (team: string) => `That note couldn’t be added to ${team}. Have another look.`,
  settingsHeading: "Sending to your teams",
  settingsLede: "When something in your inbox is about a team you’re in, a note for that team waits here. Nothing goes to a team until you press Add.",
  teamSwitch: (team: string) => `Look for notes for ${team}`,
  keepLabel: "Anything else to keep to yourself?",
  keepHint: "In your own words. It’s read before any note is written.",
  keepPlaceholder: "For example: fundraising and anything about investors.",
  save: "Save",
  saved: "Saved",
};

const SOURCE_NOUNS: Record<string, string> = { meeting: "meetings", messages: "emails", chat: "AI chats", note: "notes" };

export const LEFT_OUT_WHY: Record<LeftOutReason, string> = {
  people: "People’s jobs and roles stay private",
  personal: "Personal life stays private",
  meeting: "Meetings and messages stay with you",
  owner: "You keep this to yourself",
};
