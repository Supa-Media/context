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
  options: { excludeUserIds?: ReadonlySet<string>; excludeGroups?: ReadonlySet<string> } = {},
): Recipient[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];

  const excludedUsers = options.excludeUserIds ?? new Set<string>();
  const excludedGroups = options.excludeGroups ?? new Set<string>();

  const rank = (value: string | undefined) => {
    if (value === undefined) return 2;
    const lowered = value.toLowerCase();
    if (lowered.startsWith(needle)) return 0;
    return lowered.includes(needle) ? 1 : 2;
  };

  const memberRows = members
    .filter(
      (member) =>
        !excludedUsers.has(member.userId) &&
        (matches(member.name, needle) || matches(member.email, needle)),
    )
    .map((member) => ({
      member,
      order: Math.min(rank(member.name), rank(member.email)),
    }))
    .sort((a, b) => a.order - b.order)
    .map(({ member }) => ({
      kind: "member" as const,
      key: member.userId,
      label: member.name ?? member.email ?? member.userId,
      detail: member.name !== undefined ? member.email : undefined,
      userId: member.userId,
    }));

  const groupRows = groups
    .filter((group) => !excludedGroups.has(group.name) && matches(group.name, needle))
    .map((group) => ({ group, order: rank(group.name) }))
    .sort((a, b) => a.order - b.order)
    .map(({ group }) => ({
      kind: "group" as const,
      key: group.name,
      label: `@${group.name}`,
      // The count is the people it REACHES, which is the number the Groups
      // section is careful about too: a group naming four and reaching two is
      // two here.
      detail: group.liveCount === 1 ? "group · 1 person" : `group · ${group.liveCount} people`,
      group: group.name,
    }));

  const rows: Recipient[] = [...memberRows, ...groupRows];

  // Only for something that is actually an address, and only when nobody here
  // already matches it — offering to invite an address that belongs to a
  // member is offering to do nothing.
  if (looksLikeAddress(needle) && !memberRows.some((row) => row.detail === needle || row.label === needle)) {
    rows.push({
      kind: "invite",
      key: needle,
      label: needle,
      detail: "Not a member yet — inviting them also gives them this note",
    });
  }

  return rows;
}
