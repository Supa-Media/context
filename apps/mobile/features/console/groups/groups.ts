/**
 * Groups, as the console needs them.
 *
 * A group is a name a folder rule can point at — `2-areas/feedback:
 * @supa-leads` — and the split it rests on is worth restating where the UI
 * reads it: **the manifest holds the reference, the control plane holds the
 * fact.** The name travels with the bucket and means nothing on its own; who
 * is in the group lives in Convex, so taking somebody out of the workspace
 * closes every folder at once without the bucket being touched.
 *
 * Pure and React-free, like `members.ts` and `shares.ts` beside it: the
 * awkward cases — a name left behind by somebody who left, a group nothing
 * points at, a list that has not loaded — are pinned by tests rather than
 * discovered in a screenshot.
 *
 * ## The one thing this module must not flatten
 *
 * A person named in a group who is **no longer a member of the workspace**
 * reaches nothing: `resolveGroupMembers` intersects the two, and the control
 * plane already told us so with `live: false`. That is not an error state and
 * not a hole — it is the intersection working — so the row says what it is,
 * plainly, rather than being hidden (which would leave the owner believing the
 * group is smaller than the file says) or alarming (which would send them
 * hunting for a breach that is not there).
 */

import type { ConsoleFailure } from "../failure";

/** One person named in a group, exactly as `listGroups` returns them. */
export interface ConsoleGroupMember {
  userId: string;
  email?: string;
  name?: string;
  /** False when they are no longer a member of the workspace. */
  live: boolean;
}

/** One group, exactly as `listGroups` returns it. */
export interface ConsoleGroup {
  groupId: string;
  /** The full, slug-prefixed name, as `privacy.md` carries it after the `@`. */
  name: string;
  /** The half a person typed. */
  label: string;
  createdAt: number;
  members: ConsoleGroupMember[];
}

export interface GroupActions {
  create: (label: string) => Promise<void>;
  /**
   * Make a group and put people in it in one step, answering with the full
   * name `privacy.md` will carry (no `@`).
   *
   * Its own action rather than the caller looping `create` then `addMember`,
   * because the caller that needs it — the share sheet — then has to find the
   * new group's id by re-reading a list that has not necessarily arrived. The
   * control plane already returns the id from `createGroup`; this is the one
   * place that stops throwing it away.
   *
   * Not atomic, and that is visible rather than hidden: a failure partway
   * leaves a real group with some of the people in it, which the Groups panel
   * shows and can finish. The alternative — rolling back a group somebody may
   * already have pointed a folder at — is worse.
   */
  createWith: (label: string, userIds: readonly string[]) => Promise<string>;
  addMember: (groupId: string, userId: string) => Promise<void>;
  removeMember: (groupId: string, userId: string) => Promise<void>;
  remove: (groupId: string) => Promise<void>;
}

export interface GroupsView {
  groups: ConsoleGroup[];
  /**
   * Absent for anybody who is not an owner of this context.
   *
   * The rule `StorageActions` and `MembersView` already follow: an owner-only
   * control is **absent**, not disabled. `listGroups` is owner-only on the
   * backend for the reason the note census is, so a member never gets here at
   * all — and a button that renders and refuses would be a promise the server
   * was always going to break.
   */
  actions?: GroupActions;
  loading: boolean;
  /**
   * Set when the query came back as an error rather than a list.
   *
   * A `ConsoleFailure`, not a string: a failed query is not an empty context
   * and not a permanent "Loading…", and it reaches the section as a *value*
   * rather than a throw that would unmount the console. Same shape as
   * `MembersView` and `SharesView`. See `../failure.ts`.
   */
  failure?: ConsoleFailure;
}

/** How a group's membership reads in one line. */
export function groupSummary(group: ConsoleGroup): string {
  const live = group.members.filter((member) => member.live).length;
  const people = live === 1 ? "1 person" : `${live} people`;
  const dangling = group.members.length - live;
  if (dangling === 0) return people;
  // Counted separately rather than folded into the total: the whole point is
  // that the file's list and the people it reaches are different lengths, and
  // a single number would hide exactly that.
  return `${people} · ${dangling} no longer ${dangling === 1 ? "a member" : "members"}`;
}

/**
 * What to call somebody in a chip.
 *
 * Structural rather than `ConsoleGroupMember`, because the share sheet labels
 * people from `AccessMember` and there should be exactly one rule for how a
 * person with no display name is written down. `live` is irrelevant to it.
 */
export function memberLabel<T extends { userId: string; name?: string; email?: string }>(
  member: T,
): string {
  return member.name ?? member.email ?? member.userId;
}

/**
 * The sentence under a group that has names reaching nobody.
 *
 * Says what it means, not that something is wrong. A dangling name grants
 * nothing — that is the intersection doing its job — so this explains and
 * offers the tidy-up rather than raising an alarm.
 */
export function danglingNote(group: ConsoleGroup): string | null {
  const dangling = group.members.filter((member) => !member.live);
  if (dangling.length === 0) return null;
  const names = dangling.map(memberLabel).join(", ");
  return `${names} ${dangling.length === 1 ? "is" : "are"} no longer in this workspace, so this group does not reach ${dangling.length === 1 ? "them" : "them"}. Remove the name when you want it tidy — it grants nothing meanwhile.`;
}

/**
 * Whether a label can be submitted at all.
 *
 * Deliberately thin: this stops a request that is certain to fail, and it is
 * never the authority. `buildGroupName` in the control plane decides what a
 * name may be — charset, reserved words, the IDNA label form, the assembled
 * length — and the server refuses anybody who is not an owner. Duplicating
 * those rules here would be a second place for them to drift.
 */
export function canSubmitLabel(label: string): boolean {
  return label.trim().length >= 2;
}

/** The name as `privacy.md` carries it, for showing beside a folder rule. */
export function groupRuleToken(group: ConsoleGroup): string {
  return `@${group.name}`;
}

/**
 * Which members of this workspace are not yet in this group.
 *
 * The add list, and it excludes anybody already named — including a name that
 * is currently dangling, because adding them again would not make them live.
 * Only re-joining the workspace does.
 */
export function addableMembers<T extends { userId: string }>(
  group: ConsoleGroup,
  members: readonly T[],
): T[] {
  const named = new Set(group.members.map((member) => member.userId));
  return members.filter((member) => !named.has(member.userId));
}

/**
 * Whether the share sheet may offer to make a group out of what is picked.
 *
 * `GroupsPanel` used to be the only place a group could be born, and its own
 * header calls that out: "Nobody should have to come here first." The moment a
 * group should exist is the moment somebody is looking at a note and picking
 * the same two people again — so the sheet offers it there, and this is the
 * check that stops it offering a request certain to fail.
 *
 * As thin as `canSubmitLabel`, and for the same reason: `buildGroupName` in the
 * control plane decides what a name may be and the server refuses anybody who
 * is not an owner. This adds exactly one rule of its own — a group of nobody is
 * not a group — because that one is about the *selection*, which the control
 * plane never sees.
 */
export function canMakeGroup(label: string, userIds: readonly string[]): boolean {
  return canSubmitLabel(label) && userIds.length > 0;
}

/**
 * The name that will exist, shown while the label is being typed.
 *
 * **The prefix is not the typist's to enter.** `buildGroupName` derives it from
 * the workspace slug, so a field that silently prepends it while accepting
 * `supa-leads` produces `@supa-supa-leads`. Showing the assembled name is the
 * interface telling the truth about where the name comes from — the same thing
 * `GroupsPanel` does with its greyed prefix.
 *
 * Not a validator and never the authority: the server may still refuse this
 * name, and it says so in its own words.
 */
export function previewGroupName(slug: string, label: string): string {
  const trimmed = label.trim();
  return `@${slug}-${trimmed.length === 0 ? "…" : trimmed}`;
}
