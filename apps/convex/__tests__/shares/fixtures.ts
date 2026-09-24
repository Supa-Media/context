/**
 * NOTE SHARES — the control-plane half.
 *
 * A share is a standing, revocable grant to read one team-visible note,
 * addressed to one person who is **not** a member of the context. Three
 * properties are being proved here, and they fail in different directions:
 *
 *  1. **A share narrows, never widens.** It hands over one note. It is not a
 *     membership, so it must not appear anywhere membership does, and it must
 *     not be creatable over `privacy.md` or anything under `.history/`.
 *  2. **A share is bound to the person it was addressed to.** Holding the token
 *     is not enough. Presenting one you were not sent must fail exactly like
 *     presenting one that never existed — and so must presenting a revoked one,
 *     because otherwise revocation would be observable to whoever kept the link.
 *  3. **A share box is not an existence oracle.** The attacker is the *sharer*:
 *     anybody with an account has one. Sharing with `@nobody` must be
 *     indistinguishable from sharing with a real person, which is why several
 *     tests below compare whole responses rather than "both succeeded".
 *
 * The one deliberate asymmetry with `invitations.test.ts` is that `createShare`
 * returns its token, where `inviteMember` returns `null`. That is safe because
 * the token is minted from `crypto.getRandomValues` before anything is looked
 * up, so it carries no information about the recipient — and it is *necessary*,
 * because the product is a link somebody pastes into a chat. The test named
 * "a share with a stranger is byte-identical to a share with a real person"
 * is what keeps that distinction honest: it compares the responses with the
 * tokens removed, and would fail the moment any other field started varying.
 */

import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  addMember,
  asUser,
  createUser,
  createWorkspace,
  type TestConvex,
} from "../fixtures.helpers";

export const NOTE = "1-projects/transition/overview.md";
export const OTHER_NOTE = "1-projects/transition/proposal.md";

/** Serialize a thrown error's payload so two failures can be compared exactly. */
export function errorShape(error: unknown): string {
  return JSON.stringify((error as { data?: unknown }).data ?? null);
}

/**
 * An owner with a context, a member of it, and two outsiders — one of whom has
 * claimed a `@handle` and one of whom exists only as an address.
 */
export async function scenario(t: TestConvex): Promise<{
  ownerId: Id<"users">;
  memberId: Id<"users">;
  lkId: Id<"users">;
  mailOnlyId: Id<"users">;
  workspaceId: Id<"workspaces">;
}> {
  const ownerId = await createUser(t, "owner@example.invalid");
  const memberId = await createUser(t, "member@example.invalid");
  const lkId = await createUser(t, "lk@example.invalid");
  const mailOnlyId = await createUser(t, "mail-only@example.invalid");

  const workspaceId = await createWorkspace(t, ownerId, "owner-workspace");
  await addMember(t, workspaceId, memberId, "member");

  // `@lk` resolves through the personal context that owns the slug.
  await createWorkspace(t, lkId, "lk");

  return { ownerId, memberId, lkId, mailOnlyId, workspaceId };
}

export async function share(
  t: TestConvex,
  actorId: Id<"users">,
  workspaceId: Id<"workspaces">,
  recipient: string,
  path: string = NOTE,
): Promise<{ token: string }> {
  return await asUser(t, actorId).mutation(api.functions.shares.createShare, {
    workspaceId,
    path,
    recipient,
  });
}

