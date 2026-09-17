/**
 * Who can read this note, as one control with three positions.
 *
 * The lock beside Share used to have two: `private` and `team`, straight off
 * the privacy manifest. There is a third audience now — an unlisted link, which
 * whoever holds can open without signing in — and it is deliberately NOT a
 * third value in `privacy.md`. That file is the stable on-bucket format
 * (non-negotiable #3) and it is parsed by a gateway that fails *closed* on a
 * rule it does not understand, so a third word in it would make every note in
 * the bucket private for anybody on an older deployment. It is a share row
 * instead — `recipientKind: "anyone"` — which is why this module has to compose
 * two sources rather than read one field.
 *
 * Pure, and that is the rule rather than a preference: `shareViewer.test.ts`
 * records that across a sabotage sweep of this codebase every guard expressed
 * as a pure module was held and every guard expressed inside a component was
 * not. The console's copy of "what is this note's audience" is exactly the kind
 * of thing that rots inside a `useMemo`.
 */

import type { SettableVisibility, Visibility } from "./types";
import {
  audienceDetail,
  audienceName,
  type AudienceContext,
} from "../privacy/audience";

/** The three positions, widest last. */
export type NoteScope = "private" | "team" | "anyone";

/**
 * What the control shows, from the manifest's answer and whether a live
 * unlisted link exists.
 *
 * **A private note is `private` however many links point at it**, and that
 * asymmetry is the whole reason this is a function rather than a field. The
 * server re-derives visibility from the live `privacy.md` on every read, so a
 * link over a note that has since been made private grants nothing — and a
 * globe drawn over a note nobody can actually open would be the control lying
 * in the one direction that matters, telling somebody they have published
 * something they have not. The stale row is harmless and invisible; taking it
 * back is what pressing through to `private` already does.
 */
export function scopeOf(visibility: Visibility, hasOpenLink: boolean): NoteScope {
  // A group rule lands here as "private", which is the right POSITION for this
  // three-way control — it is not team, and the step out of it is a deliberate
  // widening the owner presses. It is not the right WORD, and this function
  // does not produce one: `visibilityWord` names the group, and the two must
  // not be confused. A control position is not a label.
  if (visibility !== "team") return "private";
  return hasOpenLink ? "anyone" : "team";
}

/**
 * One step of moving a note between positions.
 *
 * Data rather than a callback, so the *order* is testable without a server.
 * Two different subsystems are involved — the privacy manifest and a share row
 * — and which one moves first is a decision rather than an implementation
 * detail; see below.
 */
export type ScopeStep =
  | { kind: "visibility"; to: SettableVisibility }
  | { kind: "openLink"; on: boolean };

/**
 * How to get from here to there.
 *
 * **Closing takes the link back before it narrows the manifest**, and the order
 * is chosen for what a half-completed move leaves behind. Either order is safe
 * once both steps land, and either single failure is safe too — but a failed
 * revoke after a successful narrowing leaves an owner who pressed "make this
 * private" looking at a private note with a live link row beside it, which is
 * the state this control exists to never show. Revoking first fails the other
 * way: the link is gone, the note is still team-visible, and the icon says so.
 *
 * Widening never needs two steps, because `anyone` is only ever reached from
 * `team` — the cycle passes through it — so the note is already published to
 * the team when the link is minted. Reaching `anyone` from `private` would
 * need both, and is deliberately not a move this control offers: publishing
 * straight from private to the internet in one press is the accident worth
 * making impossible.
 */
export function stepsTo(from: NoteScope, to: NoteScope): ScopeStep[] {
  if (from === to) return [];
  if (to === "private") {
    return [
      ...(from === "anyone" ? ([{ kind: "openLink", on: false }] as ScopeStep[]) : []),
      { kind: "visibility", to: "private" },
    ];
  }
  if (to === "team") {
    return [
      ...(from === "anyone" ? ([{ kind: "openLink", on: false }] as ScopeStep[]) : []),
      ...(from === "private" ? ([{ kind: "visibility", to: "team" }] as ScopeStep[]) : []),
    ];
  }
  // `anyone`. Reached from `team` by the cycle; from `private` it also has to
  // publish, which the cycle never asks for but a caller could.
  return [
    ...(from === "private" ? ([{ kind: "visibility", to: "team" }] as ScopeStep[]) : []),
    { kind: "openLink", on: true },
  ];
}

/**
 * What each position is called, and what it costs, in the words the control
 * prints.
 *
 * **A function of the context rather than a constant, because the honest name
 * of the middle position is the workspace's own.** It said "Workspace" — a
 * word that names a set the reader cannot check — and now says "Everyone in
 * @supa", which they can check against the People list. That is the whole
 * change asked for by an owner who could not answer "what's team? what's
 * private?" from the screen in front of them.
 *
 * The sentences live in `privacy/audience.ts` so this module and the tree, the
 * breadcrumb and the privacy panel cannot drift into three vocabularies for one
 * question. `detail` is deliberately about who ends up able to read it, never
 * about the mechanism: "creates an unlisted share row" is true and answers a
 * question nobody asked.
 */
export function scopeLabels(
  context: AudienceContext,
): Record<NoteScope, { label: string; detail: string }> {
  return {
    private: {
      label: audienceName("private", context),
      detail: audienceDetail("private", context),
    },
    team: {
      label: audienceName("team", context),
      detail: audienceDetail("team", context),
    },
    anyone: {
      label: "Anyone with the link",
      detail: "No account needed. Anybody holding the link can read it.",
    },
  };
}

/**
 * The sentence somebody has to agree to before a note gets a public link.
 *
 * Its own export so the wording is testable and cannot drift from what
 * `createLinkShare` does — the same reason `describeOpenLink` lives in
 * `shares.ts`. This is the step the padlock used to take on one unlabelled tap.
 */
export function describeGoingPublic(name: string): string {
  return (
    `${name} will be readable by anybody who has the link, without signing in — ` +
    "and so will the notes it links to. You can take the link back at any time."
  );
}
