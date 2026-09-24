/**
 * A LINK FOR EVERYONE WHO ALREADY HAS ACCESS.
 *
 * The second kind of share, and its authorization runs the other way round from
 * the first:
 *
 *  - A **personal** share is addressed to one named person. Holding the token
 *    is not enough; you must be who it was sent to.
 *  - A **team** share is addressed to nobody. Holding the token is not enough
 *    either — you must be a **member of the context**, checked live on every
 *    read, so removing somebody takes the link with them.
 *
 * In both cases the token is what makes the URL unguessable and *not* what
 * grants access. That distinction is what makes the link's card safe to carry
 * the note's title, where `/console/@slug?note=…` addresses the same note and
 * must not: anyone who knows the handle can type that one, so a titled card
 * there would answer "does this note exist?" to whoever asked.
 *
 * The property with teeth is the last one below: **a team share is not a way
 * around visibility.** It reaches only what the reader's membership already
 * reaches, so it can never hand somebody a note their role could not open.
 */

import { api } from "../../_generated/api";
import {
  GENERIC_ROOT_KEYS,
  INDEX_KEY,
  PRIVACY_KEY,
} from "../../functions/lib/scaffold";
import type { Id } from "../../_generated/dataModel";
import {
  addMember,
  asUser,
  createUser,
  createWorkspace,
  type TestConvex,
} from "../fixtures.helpers";

export const NOTE = "1-projects/transition/overview.md";

export async function scenario(t: TestConvex) {
  const ownerId = await createUser(t, "owner@example.invalid");
  const memberId = await createUser(t, "member@example.invalid");
  const editorId = await createUser(t, "editor@example.invalid");
  const strangerId = await createUser(t, "stranger@example.invalid");

  const workspaceId = await createWorkspace(t, ownerId, "owner-workspace");
  await addMember(t, workspaceId, memberId, "member");
  await addMember(t, workspaceId, editorId, "editor");
  await createWorkspace(t, strangerId, "elsewhere");

  return { ownerId, memberId, editorId, strangerId, workspaceId };
}

export function teamLink(
  t: TestConvex,
  actorId: Id<"users">,
  workspaceId: Id<"workspaces">,
  path: string = NOTE,
) {
  return asUser(t, actorId).mutation(api.functions.shares.createTeamShare, {
    workspaceId,
    path,
  });
}

