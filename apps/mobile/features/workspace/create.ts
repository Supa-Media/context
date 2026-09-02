/**
 * Creating a **workspace**, as a state machine.
 *
 * This is the first run for a shared context, and it is deliberately not the
 * same flow as `features/onboarding` even though four of its five screens
 * rhyme. Three differences make one flow serving both a worse flow for each:
 *
 *  1. **A workspace is not the thing you are only allowed one of.** Onboarding
 *     has no way back because step 1 claims the person's own name out of a
 *     namespace with no release path, and it is not re-runnable because
 *     `createWorkspace` writes exactly one personal context. Neither is true
 *     here: a person may own several workspaces, and creating one is a thing
 *     they will do again. The name claim is still permanent — so the *first*
 *     step is still one-way — but everything after it can be revisited, and the
 *     flow says so rather than borrowing onboarding's "there is no way back".
 *  2. **A workspace has no capture address.** Only a personal context gets an
 *     ingestion alias (`identity-and-access.md`), so the name step must not
 *     show `name@context.lc` as one of the things the name becomes. It is the
 *     single most consequential line in the onboarding name step and it is
 *     simply false here.
 *  3. **A workspace that nobody else is in is pointless.** Onboarding ends on
 *     "point your tools at it". This ends on "invite the people it is for",
 *     which is a step onboarding does not have and the only step here whose
 *     absence makes the whole thing a no-op.
 *
 * Everything genuinely shared is imported rather than copied: name validation
 * (`../onboarding/name`), the folder editor's rules (`../onboarding/structure`),
 * and the storage connect form (`../console/storage`).
 */

import { parseInvitee } from "@context/convex/functions/lib/invitees";
import type { AssignableRole } from "../console/members/members";

/** Where the flow lives. Beside the flow, so a caller imports one thing. */
export const NEW_WORKSPACE_ROUTE = "/workspace/new";

export type WorkspaceStepKey = "name" | "storage" | "layout" | "people" | "done";

/**
 * What happened on the storage step.
 *
 * The same three outcomes as onboarding's, and for the same reason —
 * `unverified` is "carry on anyway", which means a binding exists and nobody
 * has looked inside the bucket. Restated here rather than imported so that the
 * two flows can diverge without one silently changing the other; they are the
 * same three words today and that is a coincidence worth being able to break.
 */
export type WorkspaceStorageOutcome = "connected" | "skipped" | "unverified";

export interface WorkspaceFlowShape {
  storage: WorkspaceStorageOutcome;
}

/**
 * Which steps this run has.
 *
 * The layout step needs a **verified** bucket, for onboarding's reason:
 * `applyStructure` refuses a binding that is not `connected`
 * (`STORAGE_NOT_VERIFIED`), so offering the step would be offering a button
 * that cannot work.
 *
 * **The people step is offered either way, and that is the difference.**
 * Onboarding drops its remaining steps when storage fails because the one
 * remaining step instructs an AI client to go and write notes into a bucket we
 * could not reach. Inviting somebody writes nothing to any bucket — an
 * invitation is a control-plane row — and a workspace whose storage is not
 * sorted out yet is exactly the workspace whose members most need to know it
 * exists. So the invitation step survives a failed probe; what it must not do
 * is imply the context is ready, which is `peopleCaveat`'s job.
 */
export function workspaceStepsFor(shape: WorkspaceFlowShape): WorkspaceStepKey[] {
  if (shape.storage === "connected") {
    return ["name", "storage", "layout", "people", "done"];
  }
  return ["name", "storage", "people", "done"];
}

/** Where the storage step hands off to. */
export function afterWorkspaceStorage(
  outcome: WorkspaceStorageOutcome,
): WorkspaceStepKey {
  return outcome === "connected" ? "layout" : "people";
}

/** Where the layout step hands off to. Always the people step; see `workspaceStepsFor`. */
export function afterWorkspaceLayout(): WorkspaceStepKey {
  return "people";
}

/**
 * The line the people step adds when the bucket is not sorted out.
 *
 * An invitation sent from a workspace with no working storage is still a real
 * invitation — it just lands somebody in a context with nothing in it. Saying
 * so on the screen that sends it is the difference between a caveat and a
 * support ticket.
 */
export function peopleCaveat(shape: WorkspaceFlowShape): string | null {
  switch (shape.storage) {
    case "connected":
      return null;
    case "skipped":
      return "This workspace has no bucket yet, so anybody who accepts will find it empty until one is connected. The invitation itself is fine — it keeps until they answer it.";
    case "unverified":
      return "We could not confirm this workspace's bucket, so anybody who accepts may find it empty. The invitation itself is fine — it keeps until they answer it.";
  }
}

export const WORKSPACE_STEP_LABELS: Record<WorkspaceStepKey, string> = {
  name: "Its name",
  storage: "Its bucket",
  layout: "Its layout",
  people: "Its people",
  done: "Ready",
};

export function workspaceStepTitle(key: WorkspaceStepKey): string {
  switch (key) {
    case "name":
      return "Name the workspace";
    case "storage":
      return "Connect its bucket";
    case "layout":
      return "Pick a starting layout";
    case "people":
      return "Invite the people it is for";
    case "done":
      return "The workspace is live";
  }
}

/**
 * "Step 2 of 5", or `null` for a step this run does not contain. The total
 * moves when somebody skips storage — honest rather than sloppy, exactly as in
 * `../onboarding/flow`.
 */
export function workspaceStepProgress(
  key: WorkspaceStepKey,
  shape: WorkspaceFlowShape,
): { index: number; total: number } | null {
  const steps = workspaceStepsFor(shape);
  const index = steps.indexOf(key);
  if (index === -1) return null;
  return { index: index + 1, total: steps.length };
}

/* -------------------------------------------------------------------------- */
/*                                the name                                    */
/* -------------------------------------------------------------------------- */

/**
 * A display name suggests a slug; it never decides one.
 *
 * "Acme Engineering" should not make somebody type `acme-engineering` a second
 * time, and a slug field that fills itself in is the difference between two
 * fields and one. But the suggestion stops the moment the slug is touched:
 * silently rewriting a handle somebody has edited, because they went back and
 * fixed a typo in the display name, is how you claim a permanent name nobody
 * chose.
 *
 * Punctuation and runs of whitespace collapse to single hyphens, everything
 * outside `[a-z0-9-]` is dropped, and leading and trailing hyphens go — which
 * is `validateName`'s shape, so the suggestion is usually already valid. It is
 * never *assumed* valid: `nameStatus` runs on the result like any typed string,
 * and the server re-checks inside `createWorkspace`'s transaction.
 */
export function slugSuggestion(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
}

/**
 * The two things a workspace name becomes.
 *
 * **Two, not three.** `../onboarding/name`'s `nameConsequences` returns a
 * mailbox as well, because a personal context has an ingestion alias. A shared
 * context has no capture address at all — mail lands in a personal context and
 * nowhere else — so showing one here would promise an address that will never
 * receive anything.
 */
export function workspaceNameConsequences(name: string): {
  context: string;
  path: string;
} {
  const shown = name.length > 0 ? name : "workspace";
  return {
    context: `@${shown}`,
    path: `@${shown}/1-projects/kickoff.md`,
  };
}

export const WORKSPACE_DISPLAY_NAME_MAX = 80;

/** Enough to create: a display name, and a slug the server has not refused. */
export function canCreateWorkspace({
  displayName,
  nameReady,
  creating,
}: {
  displayName: string;
  /** `canClaim(nameStatus(...))` — the slug is well formed, free, and answered. */
  nameReady: boolean;
  creating: boolean;
}): boolean {
  if (creating) return false;
  if (!nameReady) return false;
  const trimmed = displayName.trim();
  return trimmed.length > 0 && trimmed.length <= WORKSPACE_DISPLAY_NAME_MAX;
}

/* -------------------------------------------------------------------------- */
/*                               the people                                   */
/* -------------------------------------------------------------------------- */

/**
 * One person the creator has lined up to invite, before anything is sent.
 *
 * The step batches rather than sending on each keystroke because `inviteMember`
 * is rate limited per account (`INVITE_LIMIT`), and because a list somebody can
 * edit before committing is the difference between inviting four colleagues and
 * inviting three colleagues and a typo.
 */
export interface PendingInvite {
  /** As typed: a `@handle`, a bare name, or an email address. */
  invitee: string;
  role: AssignableRole;
}

export type InviteDraftRejection =
  | "empty"
  | "duplicate"
  /** `parseInvitee` refused the string itself. */
  | "malformed";

export type InviteDraftResult =
  | { ok: true; invite: PendingInvite }
  | { ok: false; reason: InviteDraftRejection };

/**
 * Turn what is in the box into a queued invitation, or say why not.
 *
 * **`parseInvitee` is imported from the control plane, not reimplemented.** It
 * is the function `inviteMember` itself runs, so a string this accepts is a
 * string the server accepts; a local copy would eventually put a green tick in
 * front of a refusal.
 *
 * The duplicate check is local because it is about this list, and it compares
 * `parseInvitee`'s **normalized** value rather than the raw text — `@LK` and
 * `lk` are one person, and queueing both would send one of them an invitation
 * that supersedes the other for no reason. Nothing here re-normalizes: the
 * parser already lowercases a name through `validateName` and an address
 * through `normalizeEmail`, and a second fold on top would be a guard nobody
 * could check, which this repository treats as no guard at all.
 *
 * What this deliberately does **not** do is tell the person whether the
 * invitee exists. Nothing here may, and nothing here can: the whole reason
 * `workspaceInvitations` addresses a string rather than a user id is that an
 * outcome differing between `@lk` and `@does-not-exist` turns any invite box
 * into a name-enumeration endpoint.
 */
export function draftInvite(
  raw: string,
  role: AssignableRole,
  queued: readonly PendingInvite[],
): InviteDraftResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };

  const parsed = parseInvitee(trimmed);
  if (!parsed.ok) return { ok: false, reason: "malformed" };

  const key = inviteKey(parsed.invitee.kind, parsed.invitee.value);
  const already = queued.some((invite) => {
    const other = parseInvitee(invite.invitee);
    return other.ok && inviteKey(other.invitee.kind, other.invitee.value) === key;
  });
  if (already) return { ok: false, reason: "duplicate" };

  return { ok: true, invite: { invitee: trimmed, role } };
}

/**
 * `name:lk` / `email:lk@example.invalid`.
 *
 * The kind is in the key so the two spaces never collide: `lk` the handle and
 * `lk@example.invalid` the mailbox are two different people, and a key built
 * from the value alone would eventually decide they were one.
 *
 * `value` arrives already normalized from `parseInvitee` — see `draftInvite`.
 */
function inviteKey(kind: string, value: string): string {
  return `${kind}:${value}`;
}

export function describeInviteDraftRejection(reason: InviteDraftRejection): string {
  switch (reason) {
    case "empty":
      return "Type a @name or an email address.";
    case "duplicate":
      return "That person is already on the list.";
    case "malformed":
      return "That is not a @name or an email address. A name is 2–32 characters of a–z, 0–9 and hyphens.";
  }
}

export function removeInvite(
  queued: readonly PendingInvite[],
  index: number,
): PendingInvite[] {
  return queued.filter((_, position) => position !== index);
}

export function setInviteRole(
  queued: readonly PendingInvite[],
  index: number,
  role: AssignableRole,
): PendingInvite[] {
  return queued.map((invite, position) =>
    position === index ? { ...invite, role } : invite,
  );
}

/**
 * What happened when the queue was sent.
 *
 * Per-invitation, because `inviteMember` is called once per person and one of
 * them failing must not discard the rest — the four that went out are already
 * real, and re-sending them would supersede live rows. The step shows what
 * landed and leaves the failures in the box.
 */
export interface InviteSendResult {
  sent: PendingInvite[];
  failed: { invite: PendingInvite; error: unknown }[];
}

/**
 * How the last screen summarises the sending.
 *
 * Never "invited" and never a count of people who now have access: an
 * invitation is an offer, and until it is answered the workspace has exactly
 * one member. Saying "4 people invited" on a screen somebody screenshots is how
 * a workspace gets treated as shared before anybody has accepted.
 */
export function describeInvitesSent(count: number): string | null {
  if (count === 0) return null;
  if (count === 1) {
    return "One invitation is outstanding. It appears in the workspace's members list until it is answered, and expires in a week.";
  }
  return `${count} invitations are outstanding. They appear in the workspace's members list until they are answered, and expire in a week.`;
}

/* -------------------------------------------------------------------------- */
/*                            what the layout does                            */
/* -------------------------------------------------------------------------- */

/**
 * The privacy default, stated rather than offered — the workspace's version of
 * `../onboarding/structure`'s `PRIVACY_DEFAULT_NOTE`.
 *
 * The two say opposite things and both are right. A personal brain starts
 * all-private because a `team` default would grant nothing today and then
 * quietly open a folder the first time somebody was invited. A workspace starts
 * team-visible because it is *made* to be read by the people in it, and a
 * workspace whose folders are all private is one its editors and members
 * cannot read at all — only an `owner` may hand a client the `context:private`
 * scope.
 *
 * The second sentence is the part people do not expect and the part they need:
 * `private` inside a workspace does not mean "mine", it means "owners". It is
 * the honest half-answer to restricting a folder to some of the team, and
 * saying it here is better than letting somebody discover it by marking a
 * folder private and finding their co-lead locked out.
 */
export const WORKSPACE_PRIVACY_NOTE =
  "These folders start visible to everyone in the workspace, which is what a workspace is for. Marking one private in privacy.md holds it back to the workspace's owners — there is no way yet to restrict a folder to some other subset of the team.";

/** What a workspace's layout is worth, said once. Reversible, like everything else. */
export const WORKSPACE_LAYOUT_NOTE =
  "A layout is a leg-up on an empty bucket, not a schema. Rename these, nest inside them, add more, or delete them — in the console, in Obsidian, or by asking a connected AI client. Nothing below the tools cares what they are called.";

/* -------------------------------------------------------------------------- */
/*                          the copy that names a slug                        */
/* -------------------------------------------------------------------------- */

/**
 * The sentences that have to interpolate the workspace's handle.
 *
 * They live here rather than inline in the step components for a reason that
 * looks like housekeeping and is not. JSX collapses whitespace across the lines
 * of a **text child**; it does not touch the contents of a template literal in
 * an expression container, and any sentence carrying `${slug}` has to be one.
 * React Native does not collapse whitespace either, so a wrapped template
 * literal renders as a hard newline followed by the source file's own
 * indentation, mid-sentence, on screen. Every one of these shipped that way in
 * the first draft: invisible in a diff, in a typecheck, and in a lint run.
 *
 * Written as single-line concatenations here, where `SLUG_COPY` lets one test
 * assert it over all of them at once, rather than as five long lines in three
 * components where the next person to reformat reintroduces it.
 */
export function storageLede(slug: string): string {
  return (
    `@${slug} is claimed. It needs a bucket of its own — not the one behind your brain. ` +
    "A workspace's storage binding, credential and audit trail are its own, so revoking " +
    "one never touches the other, and handing the workspace over does not hand over " +
    "anything personal."
  );
}

export function peopleLede(slug: string): string {
  return (
    `Invite the people @${slug} is for. An invitation is an offer addressed to a @name ` +
    "or an email address — it is not access until they accept it, and it expires in a week."
  );
}

export function doneLede(slug: string): string {
  return (
    `@${slug} exists, with you as its owner. Here is what is true right now, and what ` +
    "each person still has to do."
  );
}

export function doneAddressedCheck(slug: string): string {
  return (
    `The workspace is addressed @${slug}. A note in it is ` +
    `@${slug}/1-projects/kickoff.md, from any context you can reach.`
  );
}

export function doneEndpointNote(slug: string): string {
  return (
    "Every member pastes this into their own AI client and signs in; the grant they get " +
    `covers @${slug} and nothing else, and either of you can revoke it. Pasting it into ` +
    "a channel connects nobody — a grant is one person's tooling."
  );
}

/** Every sentence above, so the test that pins them cannot miss one. */
export const SLUG_COPY = [
  storageLede,
  peopleLede,
  doneLede,
  doneAddressedCheck,
  doneEndpointNote,
] as const;
