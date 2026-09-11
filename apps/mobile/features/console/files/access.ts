/**
 * Who reaches this note, and why — the list the share dialog was missing.
 *
 * The dialog has said "PEOPLE WITH ACCESS" for as long as it has existed and
 * then offered a link, which is the one thing on that screen that is *not* a
 * person with access. An owner opening it could not answer the question it
 * asks: nothing anywhere in this console listed the people who can already
 * read the note in front of them.
 *
 * ## This is a view, not a second engine
 *
 * Nothing here evaluates `privacy.md`. The note's `visibility` arrived on a
 * `FolderListing` the server computed through `effectiveVisibility` at the
 * caller's own scope, and the membership arrived from `listMembers`. This
 * module joins two answers somebody else gave; it never derives a third.
 *
 * That distinction decides the one hard case. A rule naming a group
 * (`@supa-leads`) says who reaches the note, and **this console cannot resolve
 * it** — group membership is a control-plane object that does not exist yet,
 * so nothing here knows whether a given member is in it. The honest row is
 * therefore the rule itself rather than a guess at its members, and the
 * alternative — listing everybody and hoping — is the overstatement
 * `privacy/words.ts` opens by forbidding, pointed the other way.
 *
 * ## Why "and why" is half the value
 *
 * An owner deciding whether to share something needs to know that the four
 * people listed are there because the *folder* is team-readable, not because
 * anybody chose this note. That is the difference between "this is fine" and
 * "wait, that folder?", and it is invisible in a bare list of faces.
 */

import type { Visibility } from "./types";

/** One person, or one rule, that reaches this note. */
export interface AccessRow {
  /** Stable across renders: a user id, or the group's own name. */
  key: string;
  label: string;
  /** `owner` / `editor` / `member`, or `group` for a rule we cannot resolve. */
  role: string;
  /** Why they reach it, in the words the dialog prints. */
  reason: string;
  /** The signed-in person, so the row can say "(you)" rather than guess. */
  isMe: boolean;
}

export interface AccessMember {
  userId: string;
  role: string;
  email?: string;
  name?: string;
  isMe: boolean;
}

/** What the note's own rule is called, for the summary line. */
export function accessSummary(visibility: Visibility, exception: boolean): string {
  const source = exception ? "set on this note" : "inherited from its folder";
  if (visibility === "team") return `Everyone in this workspace can read it — ${source}.`;
  if (visibility === "private") return `Only owners can read it — ${source}.`;
  return `Only ${visibility} can read it — ${source}.`;
}

/**
 * The people and rules that reach this note.
 *
 * **A member who cannot read it is absent, not greyed out.** The console's rule
 * for a control somebody may not use is that it is absent; the same applies to
 * a person a note does not reach, and for a sharper reason — a list that shows
 * everybody with four of them dimmed reads, at a glance, as "shared with eight
 * people". The count on screen must be the count who can read it.
 */
export function accessRows(
  visibility: Visibility,
  exception: boolean,
  /**
   * `undefined` while the membership query is in flight, and that is NOT an
   * empty context — the rule `privacy/map.ts` states for its own folder rows,
   * for the same reason. An empty list rendered under "PEOPLE WITH ACCESS"
   * says "nobody can read this", which is a specific and wrong claim to make
   * about a team-readable note whose member list simply has not landed. The
   * caller draws no list at all for `undefined`; the summary line above it is
   * true either way.
   */
  members: readonly AccessMember[] | undefined,
): AccessRow[] {
  if (members === undefined) return [];
  const label = (member: AccessMember) =>
    `${member.name ?? member.email ?? member.userId}${member.isMe ? " (you)" : ""}`;

  // A group rule: one row for the rule, and the owners who reach everything.
  if (visibility !== "team" && visibility !== "private") {
    return [
      ...members
        .filter((member) => member.role === "owner")
        .map((member) => ({
          key: member.userId,
          label: label(member),
          role: member.role,
          reason: "Owns this context",
          isMe: member.isMe,
        })),
      {
        key: visibility,
        label: visibility,
        role: "group",
        reason: "Named on this note. Who is in it is set in this context's groups.",
        isMe: false,
      },
    ];
  }

  return members
    .filter((member) => visibility === "team" || member.role === "owner")
    .map((member) => ({
      key: member.userId,
      label: label(member),
      role: member.role,
      reason:
        member.role === "owner"
          ? "Owns this context"
          : exception
            ? "This note is shared with the workspace"
            : "The folder it is in is shared with the workspace",
      isMe: member.isMe,
    }));
}
