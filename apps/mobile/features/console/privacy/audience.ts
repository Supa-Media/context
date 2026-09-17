/**
 * What this context calls its audiences, in one place.
 *
 * ## The question this module exists to answer
 *
 * An owner, looking at the share sheet: *"what's team? what's private? can I
 * share a private note with a group?"* Every one of those is a fair question
 * about words this product chose, and none of them is answerable from the
 * words themselves:
 *
 *  - **"Private"** is the manifest's word for *owners only*. In a shared
 *    context that is not "mine" — it is "not the members, not the editors" —
 *    and somebody learns that by marking a folder private and locking out their
 *    co-lead.
 *  - **"Team"** names a set that does not exist as an object anywhere. There is
 *    no team; there is *this workspace's members*, whom the owner invited by
 *    name. The word invites exactly the reading non-negotiable #5 forbids, that
 *    it might mean something broader.
 *  - And "can I share a private note with a group" has the answer **yes** — a
 *    note override may name one — which no word on the screen suggested.
 *
 * So the words move to the ones people already hold from Google Drive and
 * Dropbox, which is where this audience's intuitions come from:
 *
 *  - `private` → **Restricted**, and then the sentence says *who*: only you, or
 *    only this context's owners. "Restricted" carries no claim about who,
 *    which is what stops it lying in either kind of context.
 *  - `team` → **Everyone in @supa**. The workspace's own name, rendered. This
 *    is the single biggest change: a name is checkable and "team" is not, and
 *    somebody reading "Everyone in @supa" cannot conclude it might mean the
 *    internet.
 *  - a `@name` rule → **the name itself**, with how many live people are in it
 *    when that is known. Never "Private", which is the overstatement
 *    `words.ts` opens by forbidding.
 *  - a link → **Anyone with the link**, unchanged, because it was already the
 *    Drive words and already honest.
 *
 * ## What did NOT change, and must not
 *
 * **`privacy.md` still says `private` and `team`.** It is the stable on-bucket
 * format (non-negotiable #3), parsed by a gateway that fails *closed* on a rule
 * it cannot read, so renaming a word in the file would make every note in every
 * bucket private for anybody on an older deployment. This module is the console
 * speaking; the file is untouched, and so is `Scope`, which stays two-valued.
 *
 * **Nothing here widens anything.** `team` still means the named people in this
 * workspace and nothing else. Saying so in words that can be checked against
 * the People list is the entire change.
 *
 * Pure, and that is the rule rather than a preference: `words.ts` records that
 * a sabotage sweep of this console held every guard expressed as a pure module
 * and none expressed inside a component, and that **copy is a guard here** —
 * this is the surface whose whole job is telling somebody who can read their
 * notes, and a sentence that overstates is the same defect as a control that
 * publishes something, only quieter.
 */

import { isGroupVisibility, type Visibility } from "../files/types";
import type { ContextKind } from "./words";

/**
 * How a context is addressed, for the sentences below.
 *
 * `slug` is the workspace's own name without the `@` — `supa`. `null` is "not
 * loaded yet", and every sentence below has a form that is true without it,
 * because a label that says "Everyone in @undefined" while a query is in flight
 * is worse than one that is merely vague.
 */
export interface AudienceContext {
  slug: string | null;
  kind: ContextKind | null;
  /** Whether the person reading this owns the context. */
  viewerIsOwner: boolean;
}

/** `@supa`, or a form that is true when the name has not arrived. */
export function contextHandle(slug: string | null): string {
  return slug === null || slug.trim() === "" ? "this context" : `@${slug}`;
}

/**
 * The name of an audience, short enough for a control.
 *
 * A group's live member count rides along when the caller knows it, because
 * "@supa-leads" alone does not say whether that is four people or nobody —
 * and a group everybody left is exactly the case an owner needs to see. It is
 * omitted rather than guessed at when unknown: `undefined` is not zero, which
 * is the rule `accessRows` follows for a member list still in flight.
 */
export function audienceName(
  visibility: Visibility,
  context: AudienceContext,
  liveCount?: number,
): string {
  if (visibility === "team") return `Everyone in ${contextHandle(context.slug)}`;
  if (visibility === "private") return "Restricted";
  return liveCount === undefined
    ? visibility
    : `${visibility} (${liveCount} ${liveCount === 1 ? "person" : "people"})`;
}

/**
 * Who that audience actually is, in a sentence.
 *
 * The half "Restricted" deliberately does not carry: the word is honest in both
 * kinds of context precisely because it claims nothing about who, so the claim
 * is made here where the kind is known.
 *
 * **A workspace has one owner and the reader is not always them.** Rendered on
 * somebody else's context at `member`, "Only you" would be a sentence about
 * notes that are not the reader's at all — the defect `privateMeans` already
 * carries `viewerIsOwner` to avoid.
 */
export function audienceDetail(
  visibility: Visibility,
  context: AudienceContext,
): string {
  if (visibility === "team") {
    return `Every member of ${contextHandle(context.slug)}, and nobody outside it. Not public, and not indexed.`;
  }
  if (visibility === "private") {
    if (context.kind === "shared") {
      return "Owners of this context only — not its editors, and not its members.";
    }
    if (context.kind === "personal") {
      return context.viewerIsOwner
        ? "Yours alone. No invitation and no AI client of anybody else's reaches it."
        : "This context's owner only.";
    }
    return "Owners of this context only.";
  }
  return `Only ${visibility}, and this context's owners. Nobody else in ${contextHandle(context.slug)}.`;
}

/**
 * Where the rule came from, which is the half a list of faces cannot show.
 *
 * "These four people are here because the *folder* is shared, not because
 * anybody chose this note" is the difference between "this is fine" and "wait,
 * that folder?" — the reasoning `access.ts` opens with, kept in the words.
 */
export function audienceSource(exception: boolean, kind: "file" | "folder"): string {
  if (kind === "folder") {
    return exception ? "Set on this folder" : "Inherited from the folder above";
  }
  return exception ? "Set on this note" : "Inherited from its folder";
}

/**
 * One line for a chip: the audience, and where it came from.
 *
 * The shape the breadcrumb and the tree row want, where there is room for a
 * name and a clause and not for a sentence.
 */
export function audienceChip(
  visibility: Visibility,
  exception: boolean,
  kind: "file" | "folder",
  context: AudienceContext,
): string {
  return `${audienceName(visibility, context)} — ${audienceSource(exception, kind).toLowerCase()}`;
}

/**
 * Whether this audience is a named set rather than one of the two tiers.
 *
 * Re-exported from `types` rather than re-implemented, so there is one answer
 * to "is this a name" in the console.
 */
export { isGroupVisibility };

/**
 * The context, from the console's own selected-context row.
 *
 * One derivation for every surface that renders an audience, so the share
 * sheet, the privacy panel and the tree cannot end up describing the same
 * workspace three ways. It takes the fields rather than the row so the landing
 * page's demo — which has no `ConsoleContext` at all — can build one.
 *
 * **`viewerIsOwner` defaults to `false` when the role has not loaded**, which
 * is the same direction `PrivacyPanel` already chose and for the same reason:
 * the wrong way for a copy default to be wrong is telling somebody notes are
 * theirs before we know whose they are.
 */
export function audienceContextOf(
  slug: string | null | undefined,
  kind: string | null | undefined,
  viewerIsOwner: boolean,
): AudienceContext {
  return {
    slug: slug ?? null,
    kind: kind === "personal" || kind === "shared" ? kind : null,
    viewerIsOwner,
  };
}
