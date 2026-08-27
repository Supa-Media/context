/**
 * Who is in a context, and what the section is allowed to offer them.
 *
 * Pure and React-free, like `format.ts` and `storage/errors.ts`, so the parts
 * that are easy to get quietly wrong — which controls exist for which role, what
 * a backend error code means, how somebody with no display name is labelled —
 * are pinned by tests rather than discovered in a screenshot.
 *
 * The rule the whole file is built around is the one `StorageActions` already
 * states: **an owner-only control is absent, not disabled.** Every mutation the
 * members section can fire is owner-only on the backend, so rendering it for an
 * editor would be offering a button whose only possible outcome is a permission
 * error. `MembersView.actions` is therefore the entire object, present or not.
 */

import type { ConsoleFailure } from "../failure";

/** A member's role, as the control plane spells it. */
export type MemberRole = "owner" | "editor" | "member";

/** The two roles anybody can be moved to. `owner` is deliberately not among them. */
export type AssignableRole = "editor" | "member";

export interface ConsoleMember {
  userId: string;
  role: string;
  email?: string;
  name?: string;
  joinedAt: number;
  /** True for the signed-in person, so the row can say so instead of guessing. */
  isMe: boolean;
}

export interface ConsoleInvitation {
  invitationId: string;
  /** Already decorated by the backend: `@lk`, or a bare address. */
  invitee: string;
  role: string;
  expiresAt: number;
}

/**
 * The owner-only controls.
 *
 * Absent — the whole object — for an `editor`, a `member`, and the read-only
 * demo. `inviteMember`, `removeMember`, `setMemberRole` and `revokeInvitation`
 * are all owner-only in `apps/convex`.
 */
export interface MemberActions {
  invite: (invitee: string, role: AssignableRole) => Promise<void>;
  remove: (userId: string) => Promise<void>;
  setRole: (userId: string, role: AssignableRole) => Promise<void>;
  withdraw: (invitationId: string) => Promise<void>;
}

/**
 * Everything the members section renders.
 *
 * The section knows nothing about Convex, routing, or where in the app it is
 * mounted, so it drops unchanged into a settings pane, a context view, or a
 * modal — which matters while the navigation around it is being reshaped.
 *
 * This was the *only* prop the section took, and is now one of two: `viewerRole`
 * sits beside it so the card can say what the people listed here can actually
 * see. That is a fact about the reader rather than about the membership, so
 * folding it into this view would have meant a `MembersView` that changes shape
 * depending on who is looking at it. The property that matters — no Convex, no
 * router, no knowledge of its own mounting — is unchanged.
 */
export interface MembersView {
  members: ConsoleMember[];
  invitations: ConsoleInvitation[];
  /** Absent for anyone who is not the owner of this context. */
  actions?: MemberActions;
  loading: boolean;
  /**
   * Set when `listMembers` came back as an error rather than a list.
   *
   * A failed query is not an empty context, and it is not a permanent
   * "Loading…" either. It reaches the section as a *value* — rather than as a
   * throw that would unmount the whole console — because `useMembers`
   * subscribes with `useQueries`. See `../failure.ts`.
   */
  failure: ConsoleFailure | null;
  /** Shown instead of the controls when they are absent for a real reason. */
  readOnlyReason?: string;
}

/** Whether a role may change who is in a context. Owner, and only owner. */
export function canManageMembers(role: string | undefined): boolean {
  return role === "owner";
}

/**
 * How a person is named in the list.
 *
 * Falls through name → address → a neutral placeholder. It never renders a raw
 * user id: an opaque identifier tells the reader nothing and looks like a bug,
 * and this list exists to answer "who am I sharing my notes with".
 */
export function memberLabel(member: ConsoleMember): string {
  const name = member.name?.trim();
  if (name !== undefined && name.length > 0) return name;
  const email = member.email?.trim();
  if (email !== undefined && email.length > 0) return email;
  return "Someone on this context";
}

/** The secondary line: the address when the name was used above it, else nothing. */
export function memberDetail(member: ConsoleMember): string | undefined {
  const name = member.name?.trim();
  if (name === undefined || name.length === 0) return undefined;
  const email = member.email?.trim();
  return email !== undefined && email.length > 0 ? email : undefined;
}

/** One line explaining what a role can actually do. */
export function describeRole(role: string): string {
  switch (role) {
    case "owner":
      return "Full control, including storage and access";
    case "editor":
      return "Can read and write notes";
    case "member":
      return "Can read notes";
    default:
      return role;
  }
}

/**
 * The choices offered when changing somebody's role.
 *
 * `owner` is absent rather than disabled, for the same reason the backend's
 * validator excludes it: handing over a context is a separate, deliberate act
 * and is not built. A disabled "owner" option would advertise a feature that
 * does not exist.
 */
export const ASSIGNABLE_ROLES: ReadonlyArray<{
  value: AssignableRole;
  label: string;
  detail: string;
}> = [
  { value: "member", label: "Member", detail: describeRole("member") },
  { value: "editor", label: "Editor", detail: describeRole("editor") },
];

/** The role a member can be switched to with one tap. */
export function oppositeRole(role: string): AssignableRole | null {
  if (role === "member") return "editor";
  if (role === "editor") return "member";
  return null;
}

/** "expires in 6 days" / "expires today" — coarse on purpose, like `relativeTime`. */
export function expiryLabel(expiresAt: number, now: number): string {
  const remaining = expiresAt - now;
  if (remaining <= 0) return "expired";
  const days = Math.floor(remaining / (24 * 60 * 60 * 1000));
  if (days === 0) return "expires today";
  if (days === 1) return "expires tomorrow";
  return `expires in ${days} days`;
}

export interface MembersFailure {
  headline: string;
  next?: string;
}

/** The `code` on a thrown `ConvexError`, when there is one. */
export function errorCodeOf(error: unknown): string | undefined {
  const data = (error as { data?: unknown } | null)?.data;
  if (typeof data === "object" && data !== null && "code" in data) {
    const code = (data as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** The `message` on a thrown `ConvexError`, when there is one. */
function errorMessageOf(error: unknown): string | undefined {
  const data = (error as { data?: unknown } | null)?.data;
  if (typeof data === "object" && data !== null && "message" in data) {
    const message = (data as { message: unknown }).message;
    return typeof message === "string" ? message : undefined;
  }
  return undefined;
}

/**
 * A backend refusal, turned into something a person can act on.
 *
 * Same rule `storage/errors.ts` states: **the code decides what to do next, the
 * message says what happened.** Never the raw thrown text for an unknown
 * failure — that is whatever the runtime produced, and it is how a stack trace
 * ends up in a screenshot.
 *
 * `INVITATION_NOT_FOUND` gets the same copy whatever actually happened, because
 * on the backend it is one error for four situations on purpose. Guessing which
 * one, in the interface, would re-open the oracle the single error closes.
 */
export function describeMembersFailure(error: unknown): MembersFailure {
  switch (errorCodeOf(error)) {
    case "INVALID_INVITEE":
      return {
        headline: errorMessageOf(error) ?? "That is not a @name or an email address.",
        next: "Invite somebody by their @name, or by the address they signed up with.",
      };
    case "INSUFFICIENT_ROLE":
      return {
        headline: "Only an owner can change who is in this context",
        next: "Ask an owner of this context to make the change.",
      };
    case "WORKSPACE_NOT_FOUND":
      return {
        headline: "This context is no longer available to you",
        next: "You may have been removed from it. Pick a different one.",
      };
    case "MEMBER_NOT_FOUND":
      return {
        headline: "That person is not in this context",
        next: "They may have been removed already. Reload and try again.",
      };
    case "CANNOT_REMOVE_OWNER":
    case "CANNOT_CHANGE_OWNER_ROLE":
      return {
        headline: "A context keeps its owner",
        next: "Transferring a context to somebody else is a separate step, and is not built yet.",
      };
    case "INVITATION_NOT_FOUND":
      return {
        headline: "That invitation is no longer open",
        next: "It may have been answered, withdrawn, or expired. Send a new one.",
      };
    case "INVITATION_LIMIT_REACHED":
      return {
        headline: "This context has too many invitations outstanding",
        next: "Withdraw some of the ones nobody has answered, then try again.",
      };
    case "RATE_LIMITED":
      return {
        headline: "Too many invitations just now",
        next: "Wait a few minutes and send the rest.",
      };
    case "NOT_AUTHENTICATED":
      return { headline: "You are signed out", next: "Sign in and try again." };
    default:
      return {
        headline: "That did not work",
        next: "Try again in a moment.",
      };
  }
}

/**
 * The people who have shared a context with you, as `@name` handles.
 *
 * This is the reciprocity list — the highest-converting invitation there is,
 * and the only one that needs no contact upload, no address book permission
 * and no directory. Somebody who was let into Seyi's context and then builds
 * their own has exactly one person they already know is here.
 *
 * Derived from the context list the console already holds, with no new query,
 * because a personal context's slug *is* its owner's handle. That is not a
 * convenience — `createWorkspace` writes exactly one `owner` and neither
 * `inviteMember` nor `setMemberRole` can mint another, which is what makes
 * `@name` address a person at all. If ownership ever became transferable this
 * derivation would stop being sound, and so would `@name`.
 *
 * A `shared` context is excluded for the same reason: it has no single
 * personal owner, so its slug names a place rather than somebody you could
 * share back with.
 */
export function sharedWithYou(
  contexts: readonly { slug: string; role: string; kind: string }[],
): string[] {
  return contexts
    .filter((context) => context.kind === "personal" && context.role !== "owner")
    .map((context) => context.slug);
}

/**
 * Which of those you have not already let into this context.
 *
 * Inviting somebody who is already a member is a no-op in the control plane
 * rather than an error, so suggesting them would not break anything — it would
 * just offer a button that does nothing visible, which is worse than not
 * offering it. Comparison is on the handle, lowercased, because that is what
 * `inviteMember` is addressed with.
 */
export function shareBackSuggestions(
  contexts: readonly { slug: string; role: string; kind: string }[],
  view: MembersView,
): string[] {
  const already = new Set<string>();
  for (const member of view.members) {
    // `name` is optional — a member who has not claimed a handle is identified
    // by email, which can never collide with a handle suggestion.
    if (member.name !== undefined) already.add(member.name.replace(/^@/, "").toLowerCase());
  }
  for (const invitation of view.invitations) already.add(invitation.invitee.replace(/^@/, "").toLowerCase());
  return sharedWithYou(contexts).filter(
    (slug) => !already.has(slug.replace(/^@/, "").toLowerCase()),
  );
}
