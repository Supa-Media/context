/**
 * The pinned context — one shared workspace every account reaches without
 * being invited to it.
 *
 * `docs/decisions/vocabulary-and-workspaces.md` has described `@context-lc` as
 * "the shared context every user is a member of" since the reserved-names work,
 * and until now that was a sentence rather than a mechanism: nothing outside
 * `createWorkspace` and `acceptInvitation` had ever written a membership row,
 * so the context every user was supposedly in had exactly the members who had
 * been invited to it one at a time.
 *
 * ## It is reach, and deliberately not membership
 *
 * **Nobody gets a `workspaceMembers` row for this.** That is the whole design,
 * and it is a privacy decision rather than a performance one: `listMembers`
 * returns every member's name and email to any member, so a row per account
 * would turn this one workspace into a directory of everybody on the platform,
 * readable by everybody on the platform. One tenant must not be able to
 * enumerate another (non-negotiable #4), and a member list is enumeration with
 * the contact details attached.
 *
 * So the pin is computed in the two places that answer "what can this person
 * reach" — `contextsForGrant` for an MCP session and `listMyWorkspaces` for the
 * console — and it grants exactly two things beyond that: reading notes, and
 * taking part in a form. Everything else a member has (the member list, the
 * audit trail, billing, the storage binding, grants, shares, groups,
 * invitations) stays behind `requireWorkspaceAccess`, which this never touches.
 *
 * ## Someone who really is a member keeps their real role
 *
 * The people who run this workspace are `owner` and `editor` in it through
 * ordinary invitations. A real `workspaceMembers` row always wins, so nothing
 * here can demote them to a viewer in their own context — see
 * `functions/lib/pinnedContext.ts`, where that precedence is the first thing
 * the resolver does.
 *
 * ## Why a constant rather than configuration
 *
 * Decided with the owner (2026-09-16): one hardcoded slug. The name is already
 * written into this repository in prose and in `functions/lib/names.ts`, so
 * naming it here discloses nothing new, and a deployment-time setting would be
 * a second source of truth for a value that has exactly one correct answer on
 * the deployment that matters.
 *
 * The cost is stated rather than discovered, because this repository is
 * self-hostable and MIT licensed: a self-hoster who clones this gets a pinned
 * context only if a workspace with this slug exists in *their* control plane,
 * and on a fresh deployment none does. `pinnedContextWorkspace` resolves
 * through the `by_slug` index and answers `null` when there is no such row, so
 * the feature is simply absent for them rather than broken — which is the
 * correct behaviour for somebody self-hosting, who has no reason to want our
 * bug tracker in their rail.
 */

/**
 * The slug of the pinned context.
 *
 * Addressed as `@context-lc` from a tool call, and resolved through the
 * `names`/`workspaces` `by_slug` index like any other name. It is deliberately
 * **not** in `RESERVED_NAMES`: reserving a name refuses it for everyone with no
 * bypass, including for us, which would mean never being able to recreate this
 * workspace after a delete or a migration. What protects a name we hold is
 * holding it.
 */
export const PINNED_CONTEXT_SLUG = "context-lc";

/**
 * The role a pinned reader holds — read-only, and the same `member` the
 * workspace model already has.
 *
 * "Viewer" is what this is called on screen; `member` is what it is in the
 * data, and there is no fourth role. `schema.ts` already documents `member` as
 * read-only, `effectiveScopes` already drops `context:write` for it, and
 * `participatesInForms` already carves out form answers as the one write it
 * permits — explicitly so that "a view-only workspace" is not "useless for
 * collecting a bug report". Adding a `viewer` literal beside `member` would
 * have meant teaching every one of those rules about a second name for the
 * thing they already handle.
 */
export const PINNED_CONTEXT_ROLE = "member" as const;

/** Is this the pinned context's name? Compared after `@` and case are stripped. */
export function isPinnedContextSlug(slug: string | null | undefined): boolean {
  if (typeof slug !== "string") return false;
  return slug.trim().replace(/^@/, "").toLowerCase() === PINNED_CONTEXT_SLUG;
}
