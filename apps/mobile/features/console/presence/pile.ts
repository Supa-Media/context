/**
 * What the face pile says, kept apart from how it is drawn so it can be tested
 * without a renderer.
 *
 * The pile replaced a row of avatars plus a pill that named the same people and
 * then counted them (Dev2, 2026-09-27: "we can do better"). Faces alone carry
 * who is here; the names, and where each person is in the note, are one press
 * away in the list `PresencePile` opens.
 */

import type { Presence } from "./presenceContract";
import type { PresenceMember } from "./protocol";
import { cursorOffset } from "./sync";
import { MARKER_RE } from "@context/shared/src/comments.cjs";

/**
 * Whether the pile draws anything: somebody else is here, or the room is
 * reconnecting. Nothing at all when presence is unavailable — a self-host
 * without the binding, a note opened offline — which is almost always.
 */
export function presenceShown(presence: Pick<Presence, "phase" | "summary">): boolean {
  if (presence.phase === "unavailable" || presence.phase === "idle") return false;
  return presence.summary !== "";
}

/**
 * The pile's accessible name: who is here, and that the count is about other
 * people, not the reader. A demonstration says so, so nobody takes the
 * homepage's cast for real people watching them.
 */
export function presenceLabel(presence: Pick<Presence, "phase" | "members" | "summary" | "demo">): string {
  if (presence.phase === "reconnecting") return "Reconnecting";
  if (presence.members.length === 0) return presence.summary;
  const names = presence.members.slice(0, 2).map((member) => member.name).join(", ");
  const extra = presence.members.length > 2 ? ` +${presence.members.length - 2}` : "";
  const count = presence.members.length === 1 ? "1 other here" : `${presence.members.length} others here`;
  return `${names}${extra} · ${count}${presence.demo === true ? " · demo" : ""}`;
}

/**
 * Which faces to draw, and how many are folded into a `+n`.
 *
 * `limit` faces at most — three on a phone, four on a pointer layout. Past it
 * the last slot becomes the count rather than a fifth face, so the pile never
 * grows wider than `limit` circles.
 */
export function pileFaces<T>(members: readonly T[], limit: number): { faces: readonly T[]; more: number } {
  if (members.length <= limit) return { faces: members, more: 0 };
  return { faces: members.slice(0, limit - 1), more: members.length - (limit - 1) };
}

/**
 * How big the pile's faces are, how far they overlap, and how many it shows.
 *
 * A phone's is smaller (owner, 2026-09-27, the phone artboards, screen 1): 18pt
 * faces overlapping by 6 rather than 24 overlapping by 3, so three people take
 * about 44pt of the breadcrumb row instead of about 66 — the row a phone's path
 * has to share with them. Still at most three slots there, the last becoming
 * `+n` past it (`pileFaces`).
 */
export function pileGeometry(compact: boolean): { face: number; overlap: number; limit: number } {
  return compact ? { face: 18, overlap: 6, limit: 3 } : { face: 24, overlap: 3, limit: 4 };
}

/** The heading over the list: how many, not who, since the rows say who. */
export function presenceListTitle(presence: Pick<Presence, "members">): string {
  const count = presence.members.length;
  return count === 1 ? "1 other here now" : `${count} others here now`;
}

/**
 * Where somebody is, for their row in the list: the words on their line.
 *
 * Line numbers were the obvious answer and a useless one — the editor draws
 * none, and a phone edits the body without its frontmatter, so "line 12"
 * would name a line nobody can count to. The start of the line they are on
 * is what the reader can actually find. A person with no caret is reading; an
 * agent with none is writing, since an agent is only announced when it writes.
 */
export function memberWhere(
  member: Pick<PresenceMember, "head" | "isAgent">,
  shared: { doc: Parameters<typeof cursorOffset>[1]; text: { toString(): string } } | null,
): string {
  const fallback = member.isAgent ? "Writing" : "Reading";
  if (member.head === null || shared === null) return fallback;
  const offset = cursorOffset(member.head, shared.doc);
  if (offset === null) return fallback;
  const quoted = lineWords(shared.text.toString(), offset);
  if (quoted === "") return fallback;
  return `At “${quoted}”`;
}

/** The words of the line holding `offset`, markup and comment anchors removed. */
export function lineWords(text: string, offset: number, max = 36): string {
  const at = Math.max(0, Math.min(offset, text.length));
  const start = text.lastIndexOf("\n", at - 1) + 1;
  const endAt = text.indexOf("\n", at);
  const line = text.slice(start, endAt === -1 ? text.length : endAt);
  const words = line
    .replace(MARKER_RE, "")
    // A heading, quote or list marker is the line's shape, not its words.
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return words.length > max ? `${words.slice(0, max - 1).trimEnd()}…` : words;
}
