/**
 * What the app's access socket (`accessSockets.js`) reads and writes in a
 * workspace object: its members and invitations (thread F of access-in-objects,
 * decided by the owner, 2026-11-01; `docs/decisions/identity-and-access/access-in-objects.md`).
 *
 * The object is the authority for membership once its access home is `object`
 * (`members.home()`); before that nothing here is served and the app reads
 * Convex. Every read checks the reader is a member **here** (`admit`), so a
 * session the control plane still vouches for never sees a workspace this
 * object no longer counts them in.
 *
 * Rows keep the shapes the app's Convex queries answer
 * (`workspaces.listMembers`, `invitations.listInvitations`), so a screen swaps
 * only where it reads from. Names and emails stay with accounts in the control
 * plane and are asked for by id (`profilesFor`), after the member check.
 *
 * Writes: removing a member, changing a role and taking an invitation back,
 * owner only, checked against this object's own member row (never the role the
 * session carried). Creating and accepting an invitation stay Convex-born
 * actions that write here first (agreed with threads C and E). A write is
 * served only with a `mirror` (the control plane's copy, written behind the
 * object while the switch can still be rolled back); without one the app makes
 * the Convex call.
 */

import { ACCESS_HOMES, ACCESS_OPS } from "./access.js";
import { serveMembersCall } from "./serveMembers.js";

/** As `MAX_MEMBERS_RETURNED` and `MAX_INVITATIONS_RETURNED` in the control plane. */
const MAX_RETURNED = 200;
const EDIT_ROLES = new Set(["editor", "member"]);
const MIRROR_TRIES = 3;

const refused = (code) => Object.assign(new Error(code), { code });

/** Every live row of one table that `keep` keeps, at most `MAX_RETURNED`. */
function liveRows(members, name, keep = () => true) {
  const rows = [];
  let after = null;
  do {
    const page = members.list(name, { after, limit: MAX_RETURNED });
    rows.push(...page.rows.filter(keep));
    after = page.next;
  } while (after !== null && rows.length < MAX_RETURNED);
  return rows.slice(0, MAX_RETURNED);
}

/** As `formatInvitee` in the control plane: `@handle`, else the address. */
const inviteeOf = (invite) => (typeof invite.name === "string" ? `@${invite.name}` : invite.email ?? invite.phone);

/**
 * @param {{members: ReturnType<import("./members.js").workspaceMembers>, transact?: Function}} store
 * @param {{
 *   profilesFor?: (people: {userId: string, personalWorkspaceId: string}[]) => Promise<Map<string, {name?: string, email?: string, handle?: string}>>,
 *   mirror?: (workspaceId: string, change: object) => Promise<void>,
 *   now?: () => number,
 * }} deps
 */
export function workspaceAccessTopics(store, deps = {}) {
  const members = store.members;
  const now = deps.now ?? (() => Date.now());
  const decides = () => members.home() === ACCESS_HOMES.OBJECT;
  const owner = (reader) => {
    if (members.member(reader.userId)?.role !== "owner") throw refused("insufficient_role");
  };
  /** A membership call through the same code the control plane's door uses; its answer, or a refusal. */
  const call = async (op, fields) => {
    const response = await serveMembersCall(store, op, fields);
    // `copy_behind`: the object kept the write and still owes a person object; the write itself landed.
    if (response === null || (!response.ok && response.status !== 503)) throw refused("failed");
    return await response.json();
  };
  const mirrors = () => {
    if (typeof deps.mirror !== "function") throw refused("not_served");
  };
  /**
   * The control plane's copy, written behind the object (the authority wrote first), asked again with the same clock
   * on a failure; still failing, the write is not reported done (`copy_behind`), though the object kept it.
   */
  const mirrored = async (workspaceId, change) => {
    for (let attempt = 0; attempt < MIRROR_TRIES; attempt += 1) {
      try {
        return await deps.mirror(workspaceId, change);
      } catch {
        // Asked again below.
      }
    }
    throw refused("copy_behind");
  };

  const topics = {
    members: {
      served: () => decides() && typeof deps.profilesFor === "function",
      rows: async (reader) => {
        const rows = liveRows(members, "members");
        let profiles = new Map();
        try {
          profiles = await deps.profilesFor(rows.map((row) => ({ userId: row.userId, personalWorkspaceId: row.personalWorkspaceId })));
        } catch {
          // Names are display only: the list still shows, by role, and fills in on the next change.
        }
        return rows
          .map((row) => ({
            userId: row.userId,
            role: row.role,
            ...profiles.get(row.userId),
            isMe: row.userId === reader.userId,
            // The member row's clock: when it last changed, which is when they joined unless their role moved since.
            joinedAt: row.at,
          }))
          .sort((a, b) => a.joinedAt - b.joinedAt);
      },
    },
    invites: {
      served: decides,
      rows: () =>
        liveRows(members, "invites", (invite) => invite.expiresAt > now())
          .map((invite) => ({
            invitationId: invite.id,
            invitee: inviteeOf(invite),
            role: invite.role,
            invitedBy: invite.invitedBy,
            createdAt: invite.at,
            expiresAt: invite.expiresAt,
          }))
          .sort((a, b) => a.createdAt - b.createdAt),
    },
  };

  const ops = {
    async remove_member(reader, { userId }) {
      if (!decides()) throw refused("not_served");
      owner(reader);
      const target = members.member(userId);
      if (target === null) return { removed: false };
      if (target.role === "owner") throw refused("cannot_remove_owner");
      mirrors();
      const at = Math.max(now(), target.at + 1);
      const { removed } = await call(ACCESS_OPS.MEMBERS_REMOVE, { workspaceId: reader.workspaceId, userIds: [userId], at });
      await mirrored(reader.workspaceId, { op: "remove_member", userId, at, by: reader.userId });
      return { removed: removed > 0 };
    },
    async set_role(reader, { userId, role }) {
      if (!decides()) throw refused("not_served");
      if (!EDIT_ROLES.has(role)) throw refused("bad_role");
      owner(reader);
      const target = members.member(userId);
      if (target === null) throw refused("member_not_found");
      if (target.role === "owner") throw refused("cannot_change_owner_role");
      if (target.role === role) return { role };
      mirrors();
      const at = Math.max(now(), target.at + 1);
      await call(ACCESS_OPS.MEMBERS_PUT, { workspaceId: reader.workspaceId, rows: [{ ...target, role, at }] });
      await mirrored(reader.workspaceId, { op: "set_role", userId, role, at, by: reader.userId });
      return { role };
    },
    async revoke_invite(reader, { invitationId }) {
      if (!decides()) throw refused("not_served");
      owner(reader);
      if (typeof invitationId !== "string" || !liveRows(members, "invites").some((invite) => invite.id === invitationId)) return { revoked: false };
      mirrors();
      const at = now();
      const { removed } = await call(ACCESS_OPS.INVITES_REMOVE, { workspaceId: reader.workspaceId, ids: [invitationId], at });
      await mirrored(reader.workspaceId, { op: "revoke_invite", invitationId, at, by: reader.userId });
      return { revoked: removed > 0 };
    },
  };

  return {
    topics,
    ops,
    // The workspace side counts only its own members once it decides; the person side is the person's own object.
    admit: (reader) => reader.side !== "workspace" || !decides() || members.member(reader.userId) !== null,
  };
}
