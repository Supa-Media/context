/**
 * What the share field offers as you type.
 *
 * One field, one list. A person and a group are the same kind of answer here
 * because they are the same kind of token in `privacy.md` — `@kola` and
 * `@supa-leads` are indistinguishable to the parser, which is the whole reason
 * sharing with one person needed no second mechanism — so the dialog does not
 * ask you to pick a *kind* first. You type; it offers.
 *
 * Pure and React-free, so the ranking and the awkward cases are pinned by
 * tests rather than discovered while typing.
 *
 * ## The three kinds, and why the third is separate
 *
 * A **member** and a **group** both resolve to a rule this context can write.
 * An **invite** does not: it is somebody who is not here yet, and choosing it
 * is two things — an invitation, then the rule — which the dialog states
 * before it happens rather than after. Keeping it a distinct kind is what lets
 * the UI say so; folding it in would make "share with Kolade" quietly also
 * mean "add Kolade to this workspace".
 *
 * ## Offers and answers, which is the distinction this module got wrong
 *
 * Every row here used to be an offer, and anybody who already had the note was
 * dropped on the floor — the dialog passed **every member of the workspace**
 * as an exclusion set, so on a team-visible note (which is most of them, by
 * folder inheritance) there was nothing left to suggest and the field looked
 * broken. See `shareRecipients.test.ts` for the full argument.
 *
 * A row is now one of two things. An **offer** is somebody the note does not
 * reach, and choosing it changes something. An **answer** — `reaches: true` —
 * is somebody it already does, shown because "no rows" cannot distinguish
 * "they already have it" from "no such person", and those need different next
 * moves from whoever is typing. Answers sort below offers and the dialog draws
 * them as statements, not buttons.
 */

export type RecipientKind = "member" | "group" | "invite";

export interface Recipient {
  kind: RecipientKind;
  /** Stable across renders: a user id, a group name, or the typed address. */
  key: string;
  /** What the row shows first. */
  label: string;
  /** The quieter second line: an address, a membership, a warning. */
  detail?: string;
  /** Set for `member`. */
  userId?: string;
  /** Set for `group` — the full name, without its `@`. */
  group?: string;
  /**
   * This person or group **already reaches the note**, so the row is an answer
   * to the query rather than something to press. Absent on every offer, so a
   * caller that only wants offers filters on `reaches !== true` and a caller
   * that forgets shows one extra honest row rather than granting anything.
   */
  reaches?: boolean;
}

export interface RecipientMember {
  userId: string;
  name?: string;
  email?: string;
}

export interface RecipientGroup {
  /** The full, slug-prefixed name, without the `@`. */
  name: string;
  label: string;
  /** How many people it actually reaches. */
  liveCount: number;
}

/** Whether a typed string could be an email address at all. */
function looksLikeAddress(query: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(query);
}

function matches(haystack: string | undefined, needle: string): boolean {
  return haystack !== undefined && haystack.toLowerCase().includes(needle);
}

/**
 * The suggestions for a query, ranked.
 *
 * Members before groups, because the common case is one person; and within
 * each, a prefix match before a substring one, because somebody typing `ko`
 * means `kola` far more often than they mean `nikko`. The invite row is always
 * last and only for something that is actually an address — offering "invite
 * `ko`" would be offering to email a string.
 *
 * An empty query returns nothing rather than everything: a list that appears
 * before you type is a list you have to dismiss, and this field sits above the
 * people who already have access, which is the answer to "who is here".
 */
export function recipientsFor(
  query: string,
  members: readonly RecipientMember[],
  groups: readonly RecipientGroup[],
  options: {
    /**
     * Who the note **already reaches**. Not "who is in the workspace" — the
     * two are opposites on a private note, and confusing them is what emptied
     * this list. The dialog derives it from `accessRows`, so exactly one
     * function decides who reaches a note and both the list and the
     * suggestions read the same answer.
     */
    reachingUserIds?: ReadonlySet<string>;
    /** The group named on the note, if its rule names one. */
    reachingGroups?: ReadonlySet<string>;
  } = {},
): Recipient[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];

  const reachingUsers = options.reachingUserIds ?? new Set<string>();
  const reachingGroups = options.reachingGroups ?? new Set<string>();

  const rank = (value: string | undefined) => {
    if (value === undefined) return 2;
    const lowered = value.toLowerCase();
    if (lowered.startsWith(needle)) return 0;
    return lowered.includes(needle) ? 1 : 2;
  };

  const memberRows: Recipient[] = members
    .filter((member) => matches(member.name, needle) || matches(member.email, needle))
    .map((member) => ({
      member,
      order: Math.min(rank(member.name), rank(member.email)),
    }))
    .sort((a, b) => a.order - b.order)
    .map(({ member }) => {
      const reaches = reachingUsers.has(member.userId);
      return {
        kind: "member" as const,
        key: member.userId,
        label: member.name ?? member.email ?? member.userId,
        detail: reaches
          ? "Already has access — listed below"
          : member.name !== undefined
            ? member.email
            : undefined,
        userId: member.userId,
        ...(reaches ? { reaches: true } : {}),
      };
    });

  const groupRows: Recipient[] = groups
    .filter((group) => matches(group.name, needle))
    .map((group) => ({ group, order: rank(group.name) }))
    .sort((a, b) => a.order - b.order)
    .map(({ group }) => {
      const reaches = reachingGroups.has(group.name);
      return {
        kind: "group" as const,
        key: group.name,
        label: `@${group.name}`,
        // The count is the people it REACHES, which is the number the Groups
        // section is careful about too: a group naming four and reaching two is
        // two here.
        detail: reaches
          ? "Already this note's rule"
          : group.liveCount === 1
            ? "group · 1 person"
            : `group · ${group.liveCount} people`,
        group: group.name,
        ...(reaches ? { reaches: true } : {}),
      };
    });

  const offers = [...memberRows, ...groupRows].filter((row) => row.reaches !== true);

  /*
    Only for something that is actually an address, and only when nobody here
    already matches it — offering to invite an address that belongs to a member
    is offering to do nothing, whether or not they reach this note.

    Read off `members`, never off the rendered rows. It used to compare against
    a row's `label` and `detail`, which worked only while `detail` happened to
    be the address: the moment a row carried any other second line — "Already
    has access", here — the check stopped finding the member and the dialog
    offered to invite somebody sitting in the list above it.
  */
  const addressIsOurs = members.some(
    (member) =>
      member.email?.toLowerCase() === needle || member.name?.toLowerCase() === needle,
  );
  if (looksLikeAddress(needle) && !addressIsOurs) {
    offers.push({
      kind: "invite",
      key: needle,
      label: needle,
      detail: "Not a member yet — inviting them also gives them this note",
    });
  }

  // Offers first and the invite last among them; answers below, because they
  // are not things to press. See the header.
  return [...offers, ...[...memberRows, ...groupRows].filter((row) => row.reaches === true)];
}

/**
 * What to say when the list is empty and somebody is mid-word.
 *
 * A blank box under a field you are typing into is indistinguishable from a
 * broken one, which is the whole defect this module was changed for — so "no
 * rows" is never the last word. `undefined` before anything is typed: a hint
 * that appears over an untouched field is noise, and the people who already
 * have the note are listed right below it anyway.
 */
export function noMatchHint(query: string): string | undefined {
  if (query.trim().length === 0) return undefined;
  return "Nobody here by that name. Type a full email address to invite somebody new.";
}
