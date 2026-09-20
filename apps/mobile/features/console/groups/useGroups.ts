import { useMemo } from "react";
import { useMutation, useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { describeQueryFailure } from "../failure";
import { EMPTY_QUERY_SPEC } from "../querySpec";
import type { ConsoleGroup, GroupActions, GroupsView } from "./groups";

/**
 * Groups, bound to the control plane.
 *
 * `listGroups` is owner-only on the backend for the reason the note census is:
 * a member who could enumerate the groups could derive the shape of what is
 * being kept from them. So this hook must not fire the query for anybody else
 * at all — the same shape `useShares` uses, and for the stronger of its two
 * reasons. Subscribing anyway would trade a plain "only an owner sees this"
 * for a card that failed with `INSUFFICIENT_ROLE`.
 *
 * Called from `useLiveConsoleData`, which owns every subscription the console
 * makes — do not call this from a pane.
 */

interface GroupSummary {
  groupId: Id<"workspaceGroups">;
  name: string;
  label: string;
  createdAt: number;
  members: Array<{ userId: Id<"users">; email?: string; name?: string; live: boolean }>;
}

/** Convex hands back `undefined` while loading and an `Error` when a query threw. */
function usable<T>(value: unknown): T | undefined {
  if (value === undefined || value instanceof Error) return undefined;
  return value as T;
}

/** Only an owner may see or change a context's groups. */
export function canManageGroups(role: string | undefined): boolean {
  return role === "owner";
}

export function useGroups(options: {
  workspaceId: Id<"workspaces"> | null;
  role: string | undefined;
}): GroupsView {
  const { workspaceId, role } = options;
  const isOwner = canManageGroups(role);

  // An empty spec rather than a conditional hook, and empty for a non-owner as
  // well as for no context at all. `api.…` is reached for inside the memo —
  // see `./querySpec.ts`.
  const spec = useMemo<RequestForQueries>(() => {
    if (workspaceId === null || !isOwner) return EMPTY_QUERY_SPEC;
    return { groups: { query: api.functions.groups.listGroups, args: { workspaceId } } };
  }, [workspaceId, isOwner]);

  const results = useQueries(spec);
  const raw = results.groups;

  const createGroup = useMutation(api.functions.groups.createGroup);
  const addGroupMember = useMutation(api.functions.groups.addGroupMember);
  const removeGroupMember = useMutation(api.functions.groups.removeGroupMember);
  const deleteGroup = useMutation(api.functions.groups.deleteGroup);

  const groups: ConsoleGroup[] = (usable<GroupSummary[]>(raw) ?? []).map((group) => ({
    groupId: group.groupId,
    name: group.name,
    label: group.label,
    createdAt: group.createdAt,
    members: group.members.map((member) => ({
      userId: member.userId,
      email: member.email,
      name: member.name,
      live: member.live,
    })),
  }));

  // Absent, not disabled, and absent as a whole object — every mutation here
  // is owner-only on the backend. See `groups.ts` and `types.ts#StorageActions`.
  const actions: GroupActions | undefined = useMemo(() => {
    if (workspaceId === null || !isOwner) return undefined;
    return {
      create: async (label: string) => {
        await createGroup({ workspaceId, label });
      },
      /*
        The id comes straight back from `createGroup`, so the members go on
        without re-reading `listGroups` — which, from the share sheet, would
        mean waiting for a subscription to deliver a group made a moment ago.

        Sequential rather than `Promise.all`: `addGroupMember` enforces
        `MAX_MEMBERS_PER_GROUP`, and a parallel burst against a near-full group
        would decide which of them failed by arrival order.
      */
      createWith: async (label: string, userIds: readonly string[]) => {
        const { groupId, name } = await createGroup({ workspaceId, label });
        for (const userId of userIds) {
          await addGroupMember({ workspaceId, groupId, userId: userId as Id<"users"> });
        }
        return name;
      },
      addMember: async (groupId: string, userId: string) => {
        await addGroupMember({
          workspaceId,
          groupId: groupId as Id<"workspaceGroups">,
          userId: userId as Id<"users">,
        });
      },
      removeMember: async (groupId: string, userId: string) => {
        await removeGroupMember({
          workspaceId,
          groupId: groupId as Id<"workspaceGroups">,
          userId: userId as Id<"users">,
        });
      },
      remove: async (groupId: string) => {
        await deleteGroup({ workspaceId, groupId: groupId as Id<"workspaceGroups"> });
      },
    };
  }, [workspaceId, isOwner, createGroup, addGroupMember, removeGroupMember, deleteGroup]);

  const failed = raw instanceof Error ? raw : null;

  return {
    groups,
    actions,
    // A query that threw is an answer, not a wait. And a non-owner is never
    // "loading": nothing is being asked for on their behalf.
    loading: workspaceId !== null && isOwner && raw === undefined,
    failure:
      failed === null ? undefined : describeQueryFailure(failed, "this context's groups"),
  };
}
