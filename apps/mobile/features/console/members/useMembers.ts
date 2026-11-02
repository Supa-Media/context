import { useMemo } from "react";
import { useMutation, useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { objectFirst, useObjectAccess } from "../../access/useObjectAccess";
import { describeQueryFailure } from "../failure";
import { EMPTY_QUERY_SPEC } from "../querySpec";
import {
  canManageMembers,
  type AssignableRole,
  type ConsoleInvitation,
  type ConsoleMember,
  type MemberActions,
  type MembersView,
} from "./members";

/**
 * The members section, bound to the control plane.
 *
 * The only place in the members feature that knows Convex exists —
 * `MembersSection` takes a plain `MembersView` — so the section survives being
 * moved somewhere else in the app, and so the display logic can be tested
 * without a renderer.
 *
 * Called from `useLiveConsoleData`, which owns every subscription the console
 * makes. Do not call it from a pane: the four panes are separate URLs over one
 * set of subscriptions, and a second caller would open a second one.
 */

interface MemberSummary {
  userId: Id<"users">;
  role: string;
  email?: string;
  name?: string;
  handle?: string;
  isMe: boolean;
  joinedAt: number;
}

interface InvitationSummary {
  invitationId: Id<"workspaceInvitations">;
  invitee: string;
  role: string;
  invitedBy: Id<"users">;
  createdAt: number;
  expiresAt: number;
}

/**
 * Convex hands back `undefined` while loading and an `Error` when a query threw.
 *
 * **Only true of `useQueries`.** `useQuery` re-throws a failed query during
 * render, before any caller gets to look at the value, so this guard sitting
 * beside a `useQuery` was dead code claiming a protection it did not have — one
 * failed `listMembers` took the whole console down with it. The subscriptions
 * below are `useQueries` precisely so this is real. See `../failure.ts`.
 */
function usable<T>(value: unknown): T | undefined {
  if (value === undefined || value instanceof Error) return undefined;
  return value as T;
}

export function useMembers(options: {
  workspaceId: Id<"workspaces"> | null;
  /** The caller's role in that context, or `undefined` while it is unknown. */
  role: string | undefined;
}): MembersView {
  const { workspaceId, role } = options;

  // The workspace object answers members and invitations when it serves them
  // (`useObjectAccess`); Convex is asked only for the topics it does not.
  const objectMembers = useObjectAccess<MemberSummary[]>("workspace", workspaceId, "members");
  const objectInvites = useObjectAccess<InvitationSummary[]>("workspace", workspaceId, "invites");
  const membersServed = objectMembers.served;
  const invitesServed = objectInvites.served;

  // An empty spec rather than a conditional hook: the selected context changes
  // as somebody clicks around the rail, and a hook that appears and disappears
  // would break the rules of hooks the first time they do.
  //
  // `useQueries` rather than two `useQuery`s, and that is not a tidy-up.
  // `useQuery` re-throws a failed query *during render*, so a `listMembers`
  // that threw — a context somebody was just removed from, a session that
  // lapsed mid-session — unmounted the entire console rather than this card.
  // Here the error is a value, and `failure` below draws it.
  //
  // `workspaceId` and the two served flags are the only dependencies (all
  // primitives), and the `api` references are reached for *inside* the memo:
  // `api` is a proxy that mints a new object on every property access, and one
  // in a dependency array makes the spec unstable, which makes `useSubscription`
  // set state during render forever. See `../querySpec.ts`. A topic the object
  // serves is left out of the spec entirely, so Convex is not asked for it.
  const spec = useMemo<RequestForQueries>(() => {
    if (workspaceId === null) return EMPTY_QUERY_SPEC;
    const out: RequestForQueries = {};
    if (!membersServed) {
      out.members = { query: api.functions.workspaces.listMembers, args: { workspaceId } };
    }
    if (!invitesServed) {
      out.invitations = {
        query: api.functions.invitations.listInvitations,
        args: { workspaceId },
      };
    }
    return Object.keys(out).length === 0 ? EMPTY_QUERY_SPEC : out;
  }, [workspaceId, membersServed, invitesServed]);

  const results = useQueries(spec);
  const rawMembers = objectMembers.served ? objectMembers.rows : results.members;
  const rawInvitations = objectInvites.served ? objectInvites.rows : results.invitations;

  const inviteMember = useMutation(api.functions.invitations.inviteMember);
  const revokeInvitation = useMutation(api.functions.invitations.revokeInvitation);
  const removeMember = useMutation(api.functions.workspaces.removeMember);
  const setMemberRole = useMutation(api.functions.workspaces.setMemberRole);

  const members: ConsoleMember[] = (usable<MemberSummary[]>(rawMembers) ?? []).map(
    (member) => ({
      userId: member.userId,
      role: member.role,
      email: member.email,
      name: member.name,
      ...(member.handle === undefined ? {} : { handle: member.handle }),
      joinedAt: member.joinedAt,
      // Decided by the control plane, which is the only party that knows who is
      // calling — see `listMembers`.
      isMe: member.isMe,
    }),
  );

  const invitations: ConsoleInvitation[] = (
    usable<InvitationSummary[]>(rawInvitations) ?? []
  ).map((invitation) => ({
    invitationId: invitation.invitationId,
    invitee: invitation.invitee,
    role: invitation.role,
    expiresAt: invitation.expiresAt,
  }));

  // Absent, not disabled, and absent as a whole object — every one of these is
  // owner-only on the backend. See `members.ts` and `types.ts#StorageActions`.
  // Writes go through the object when it serves the topic (`objectFirst`), else
  // Convex. The object is passed as its served flag and `run` (both stable), not
  // as the hook's return value, which is a new object every render and would
  // make this memo churn. Invitation creation stays in Convex by design.
  const { served: membersObjectServed, run: runMembers } = objectMembers;
  const { served: invitesObjectServed, run: runInvites } = objectInvites;
  const actions: MemberActions | undefined = useMemo(() => {
    if (workspaceId === null || !canManageMembers(role)) return undefined;
    const membersTopic = { served: membersObjectServed, rows: undefined, run: runMembers };
    const invitesTopic = { served: invitesObjectServed, rows: undefined, run: runInvites };
    return {
      invite: async (invitee: string, assigned: AssignableRole) => {
        await inviteMember({ workspaceId, invitee, role: assigned });
      },
      remove: async (userId: string) => {
        await objectFirst(membersTopic, "remove_member", { userId }, () =>
          removeMember({ workspaceId, userId: userId as Id<"users"> }),
        );
      },
      setRole: async (userId: string, assigned: AssignableRole) => {
        await objectFirst(membersTopic, "set_role", { userId, role: assigned }, () =>
          setMemberRole({
            workspaceId,
            userId: userId as Id<"users">,
            role: assigned,
          }),
        );
      },
      withdraw: async (invitationId: string) => {
        await objectFirst(invitesTopic, "revoke_invite", { invitationId }, () =>
          revokeInvitation({
            invitationId: invitationId as Id<"workspaceInvitations">,
          }),
        );
      },
    };
  }, [
    workspaceId,
    role,
    membersObjectServed,
    runMembers,
    invitesObjectServed,
    runInvites,
    inviteMember,
    removeMember,
    setMemberRole,
    revokeInvitation,
  ]);

  // The members list is the one this card is about; a failed invitations query
  // on its own leaves the people list standing, which is the more useful half.
  // An object-served list is never an Error, so this only ever comes from Convex.
  const failed = rawMembers instanceof Error ? rawMembers : null;

  return {
    members,
    invitations,
    actions,
    // A query that threw is an answer, not a wait. "Loading…" forever is the
    // quiet version of the same bug.
    loading: workspaceId !== null && rawMembers === undefined,
    failure:
      failed === null
        ? null
        : describeQueryFailure(failed, "who can reach this context"),
    readOnlyReason:
      workspaceId === null || actions !== undefined
        ? undefined
        : "Only an owner of this context can invite people, change what they can do, or remove them.",
  };
}
