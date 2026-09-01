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

import type { IconName } from "../../design/components/Icon";
import type { Visibility } from "./types";

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
  if (visibility !== "team") return "private";
  return hasOpenLink ? "anyone" : "team";
}

/**
 * The next position, cycling private → team → anyone → private.
 *
 * Widening one step at a time and closing all the way in one, which is the
 * right way round for a control somebody presses without reading: the
 * expensive mistake is publishing by accident, and every step towards that is
 * a single deliberate press from a state the icon has been showing. The step
 * back is the cheap one, so it is allowed to be big.
 *
 * `canOpenLink` is false for a **folder**, which keeps its two positions. Not
 * a policy decision made here: `createLinkShare` runs `checkSharePath`, which
 * is note-only, so a folder has no third position to offer and a control that
 * drew one would be a press that always fails. What a folder link means is a
 * separate question with a real answer to design (a folder share would have to
 * decide what it reaches), and `ShareDialog` already carries the note that
 * `createShare` has no folder form.
 */
export function nextScope(scope: NoteScope, canOpenLink = true): NoteScope {
  if (scope === "private") return "team";
  if (scope === "team") return canOpenLink ? "anyone" : "private";
  return "private";
}

/**
 * The icon for the state a note **is in** — never the state it moves to.
 *
 * `ICON_NAMES` states the rule and the reasoning: an unlabelled 20pt target can
 * only show what is true, while the label beside it is read aloud before the
 * press and is worth more as a verb. So a shut padlock is `private`, an open
 * one is `team`, and a globe is a link anybody can open. The two disagreeing is
 * the point rather than a slip.
 */
export const SCOPE_ICON: Record<NoteScope, IconName> = {
  private: "lock",
  team: "lockOpen",
  anyone: "globe",
};

/**
 * What a screen reader announces, naming the destination.
 *
 * Named in the language of who ends up able to read it, because that is the
 * decision — "make this public" describes a setting, and a person weighing
 * whether to press it is asking who will see it.
 */
export function scopeActionLabel(next: NoteScope): string {
  if (next === "private") return "Make this private";
  if (next === "team") return "Share this with your team";
  return "Make a link anyone can open";
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
  | { kind: "visibility"; to: Visibility }
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
