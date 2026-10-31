/**
 * What a presented token's hash resolves to: the live grant behind it, and
 * the set of contexts that grant reaches.
 *
 * Split out of `functions/controlPlane.ts`, which keeps every registered
 * function; this module registers none. It is on the gateway's path,
 * so `scripts/check-exit-is-ungated.mjs` scans it exactly as it scans that
 * file.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { TOKEN_HASH_PATTERN } from "../crypto";
import { grantedNamesFor } from "../grantedNames";
import { getMembership } from "../workspaceAuth";
import { pinnedContextRow, pinnedContextWorkspace } from "../pinnedContext";
import { PINNED_CONTEXT_ROLE } from "@context/shared";
import { homeOnlyRows, homeOnlyStillShares } from "../textGroupHomeOnly";
import { guestNamesIn, pinReaderNames } from "../pinnedReaders";
import { CONSOLE_CLIENT_ID } from "../../agentGrant";
import { TEXTS_GROUP_CLIENT_ID } from "../../textGroups";
import { TEXTS_CLIENT_ID } from "../../textLinks";
import { phoneSignInPaused } from "../emailProof";
import { mayOpenToGuests } from "../textGroupGuests";
import { invitationsStillCount } from "../textGroupInvited";
import { READS_AS_CHAT_NAME } from "../nodes/chatFolders";
import { chatHomeOf } from "../textGroupHome";

/** What a live grant resolves to. Shared by the session and binding routes. */
export interface LiveGrant {
  grant: Doc<"oauthGrants">;
  workspace: Doc<"workspaces">;
  role: string;
}

/**
 * Resolve a presented access token's hash to a grant that is live *right now*.
 *
 * "Live" is checked, not assumed, and every check is a reason to return
 * nothing:
 *
 *  1. a grant carries that access-token hash,
 *  2. the grant is not revoked,
 *  3. the access token has not expired,
 *  4. the workspace still exists,
 *  5. **the user is still a member of it** — so removing someone from a shared
 *     context cuts off their already-issued clients immediately rather than
 *     whenever their token happens to expire,
 *  6. the OAuth client is still registered.
 *
 * A grant with no `accessTokenExpiresAt` is treated as expired rather than as
 * eternal. Failing closed on a missing field is the difference between a
 * legacy row that stops working and a legacy row that never stops working.
 */
export async function resolveLiveGrant(
  ctx: QueryCtx,
  hashedAccessToken: string,
): Promise<LiveGrant | null> {
  if (!TOKEN_HASH_PATTERN.test(hashedAccessToken)) return null;

  const grant = await ctx.db
    .query("oauthGrants")
    .withIndex("by_access_token", (q) =>
      q.eq("hashedAccessToken", hashedAccessToken),
    )
    .unique();
  if (grant !== null) return await validateLiveGrantRecord(ctx, grant);
  return await earlierTextsToken(ctx, hashedAccessToken);
}

/**
 * A texting token a newer mint replaced (`textsEarlierTokens`), still inside
 * its own lifetime: the turn that holds it finishes instead of being told
 * there is no model. Only the texting client's, only while that grant is live
 * by every check below, and never once the person paused sign-ins by phone.
 */
async function earlierTextsToken(ctx: QueryCtx, hashedAccessToken: string): Promise<LiveGrant | null> {
  const earlier = await ctx.db
    .query("textsEarlierTokens")
    .withIndex("by_access_token", (q) => q.eq("hashedAccessToken", hashedAccessToken))
    .first();
  if (earlier === null || earlier.expiresAt <= Date.now()) return null;
  const grant = await ctx.db.get(earlier.grantId);
  if (grant === null || grant.clientId !== TEXTS_CLIENT_ID) return null;
  if (await phoneSignInPaused(ctx, grant.userId)) return null;
  return await validateLiveGrantRecord(ctx, grant);
}

/**
 * Re-check a grant row that was selected by some other credential.  The
 * batch presence route receives grant ids from the already-authorized gateway,
 * so it cannot use the access-token lookup above; it must still apply exactly
 * the same live checks before exposing any context metadata.
 */
export async function validateLiveGrantRecord(
  ctx: QueryCtx,
  grant: Doc<"oauthGrants">,
): Promise<LiveGrant | null> {
  if (grant.status !== "active") return null;

  if (
    typeof grant.accessTokenExpiresAt !== "number" ||
    grant.accessTokenExpiresAt <= Date.now()
  ) {
    return null;
  }

  // A home-only group grant (`lib/textGroupHomeOnly.ts`) is the pin's, and its sponsor is not a member of it: its reach
  // is the chat's home alone, judged below. Any other grant, even one carrying the field under another client, needs
  // the membership it always did.
  const homeOnly = grant.clientId === TEXTS_GROUP_CLIENT_ID && grant.texGroup?.homeOnly === true;
  let workspace: Doc<"workspaces"> | null;
  let role: string;
  if (homeOnly) {
    const pinned = await pinnedContextWorkspace(ctx);
    if (pinned === null || pinned._id !== grant.workspaceId) return null;
    workspace = pinned;
    role = PINNED_CONTEXT_ROLE;
  } else {
    const membership = await getMembership(ctx, grant.workspaceId, grant.userId);
    if (membership === null) return null;
    workspace = await ctx.db.get(grant.workspaceId);
    role = membership.role;
  }
  if (workspace === null) return null;

  const client = await ctx.db
    .query("oauthClients")
    .withIndex("by_clientId", (q) => q.eq("clientId", grant.clientId))
    .unique();
  if (client === null) return null;

  if (grant.clientId === TEXTS_GROUP_CLIENT_ID && !(await groupStillShares(ctx, grant))) return null;

  return { grant, workspace, role };
}

/**
 * A Tex group chat's grant (`functions/textGroups.ts`) resolves only while the
 * chat it was minted for may still see its workspace: every co-viewer is still
 * a member and still texting, the tagger too, and the chat is not muted and
 * still bound there. Re-read on every request, so a member removed mid-turn
 * stops the turn's next call. A group grant with no `texGroup` is refused.
 */
async function groupStillShares(ctx: QueryCtx, grant: Doc<"oauthGrants">): Promise<boolean> {
  const texGroup = grant.texGroup;
  if (texGroup === undefined) return false;
  const group = await ctx.db.get(texGroup.groupId);
  if (group === null || group.mutedAt !== undefined) return false;
  if (await phoneSignInPaused(ctx, grant.userId)) return false;
  // A home-only grant (`lib/textGroupHomeOnly.ts`): the chat is not muted, and the sponsor who minted it still may text.
  // Its chat is bound to nothing: the workspaces it reaches are re-checked per person, per workspace, on every request
  // in `contextsForGrant` (`lib/textGroupReach.ts` `liveReach`), so someone removed from one drops it on the next call.
  if (texGroup.homeOnly === true) return await homeOnlyStillShares(ctx, grant, group);
  // Guest mode is retired (E2, 2026-10-31): a grant minted under it (`texGroup.guestGroupId`) reads nothing. Its chat is
  // answered from its home from the next turn, so a stale guest grant never reads its workspace at the binder's tier.
  if (texGroup.guestGroupId !== undefined || group.guestGroupId !== undefined) return false;
  if (group.workspaceId !== grant.workspaceId) return false;
  for (const userId of texGroup.coViewerIds) {
    if ((await getMembership(ctx, grant.workspaceId, userId)) === null) return false;
    if (await phoneSignInPaused(ctx, userId)) return false;
  }
  // Invited family (`lib/textGroupInvited.ts`): every invitation counted still counts, and an invited person's tag
  // stands on a binder who may still open the workspace to the chat.
  if (texGroup.coInvitationIds !== undefined && !(await invitationsStillCount(ctx, grant.workspaceId, texGroup.coInvitationIds))) return false;
  if (texGroup.invitedTaggerRole !== undefined && !(await mayOpenToGuests(ctx, grant.workspaceId, grant.userId))) return false;
  return true;
}

/**
 * The most contexts one session carries.
 *
 * An unbounded `.collect()` here is a read whose cost is set by however many
 * contexts a person has joined, on the hottest path in the system — every MCP
 * request resolves a session. Nobody is in fifty; if somebody ever is, this
 * wants paging rather than a bigger number, and the guarantee that must survive
 * either way is the one below: the grant's own context is in the set, whatever
 * else is dropped.
 */
export const MAX_SESSION_CONTEXTS = 50;

/**
 * Every context this grant's person can reach right now.
 *
 * **Live membership, re-read on every request, never a list frozen at consent
 * time.** A workspace shared with somebody after they connected a client is
 * reachable from that client, and one they are removed from stops being
 * reachable the moment the row goes — the same immediacy rule 5 of
 * `resolveLiveGrant` already gives the grant's own context.
 *
 * The grant's own context is first and is present even when the cap truncates,
 * because the gateway reads it as the session's default and refuses a default
 * that is not in the covered set. A person in fifty-one contexts must lose
 * reach into the fifty-first, never the ability to open the one they actually
 * authorized.
 *
 * ## The pinned context is appended here, and only here
 *
 * `@context-lc` is reachable by every account without an invitation. This is
 * the one place that is decided for an MCP session, and it needs no change in
 * the gateway at all — which is the property worth stating, because it is what
 * makes the pin cheap and what would make a second implementation expensive:
 *
 *  - `sessionForContext` finds it in this set like any other covered context,
 *    then applies the clamps it applies to all of them. `effectiveScopes`
 *    intersects the grant with `member`, which drops `context:write`;
 *    `visibilityTierForGrant` answers `team` for anybody who is not the owner.
 *    So the pin reaches notes and refuses writes without a line of gateway code
 *    knowing it exists.
 *  - `openStorageBinding` selects the binding to open from *this same set*, by
 *    matching an id it then drops. A pinned context that were reachable but not
 *    in this list would resolve a session and then fail to open a store, which
 *    presents as a context that is visible and empty.
 *
 * It is appended **last and after the cap**, for the same reason the grant's
 * own context is first: somebody in fifty contexts must not lose the one they
 * authorized, and must not lose the bug tracker either. Appending after the
 * truncation costs one row over `MAX_SESSION_CONTEXTS` in the worst case, which
 * is a bounded overshoot of one rather than an unbounded read.
 *
 * A real membership wins — an owner or editor of that workspace is already in
 * `rows`, and `pinnedContextRow` stands down when the id is already covered, so
 * nobody is demoted to a viewer in a context they run.
 */
export async function contextsForGrant(
  ctx: QueryCtx,
  live: LiveGrant,
): Promise<
  Array<{
    workspaceId: Id<"workspaces">;
    slug: string;
    role: string;
    kind: "personal" | "shared";
    grantedNames?: string[];
    setupOnly?: true;
    chatHome?: string;
    homeOnly?: true;
  }>
> {
  const includeGrantedNames = live.grant.clientId === CONSOLE_CLIENT_ID;
  const own: {
    workspaceId: Id<"workspaces">;
    slug: string;
    role: string;
    kind: "personal" | "shared";
    grantedNames?: string[];
  } = {
    workspaceId: live.workspace._id,
    slug: live.workspace.slug,
    role: live.role,
    kind: live.workspace.kind,
  };
  if (includeGrantedNames) {
    own.grantedNames = await grantedNamesFor(ctx, own.workspaceId, live.grant.userId);
  }
  // A group chat's grant reaches its chat's workspaces and nothing else: not the
  // tagger's other memberships, not their personal workspace. The pin comes
  // back marked `setupOnly`: the gateway never lists or addresses it, and
  // reads only Tex's own setup there (`ai/production/`), the file a 1:1 text
  // already runs on (`apps/mcp/src/agent/production.js`).
  if (live.grant.clientId === TEXTS_GROUP_CLIENT_ID) {
    // A home-only grant reaches its chat's home in the pin, then each shared workspace every person in the chat is a live
    // member of, at the lowest role among them (`lib/textGroupReach.ts`); nothing of its sponsor's own, no setup, and no
    // pin reader's names (`lib/textGroupHomeOnly.ts`).
    if (live.grant.texGroup?.homeOnly === true) return await homeOnlyRows(ctx, live.grant, live.workspace);
    const setup = await groupSetupRow(ctx, live, own.workspaceId);
    // An invited person's tag: the binder's grant, never past the invitation's role, and never an owner's tools.
    const invitedRole = live.grant.texGroup?.invitedTaggerRole;
    if (invitedRole !== undefined) return [{ ...own, role: own.role === "member" ? "member" : invitedRole }, ...setup];
    return [own, ...setup];
  }

  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", live.grant.userId))
    .take(MAX_SESSION_CONTEXTS);

  // Oldest first, tie-broken on the id: arbitrary, but *stable*, so two
  // requests a second apart do not hand a client the same set in a different
  // order and make it look like something changed.
  memberships.sort(
    (a, b) =>
      a.joinedAt - b.joinedAt ||
      (a.workspaceId < b.workspaceId ? -1 : a.workspaceId > b.workspaceId ? 1 : 0),
  );

  const rows = [own];
  for (const membership of memberships) {
    if (membership.workspaceId === own.workspaceId) continue;
    const workspace = await ctx.db.get(membership.workspaceId);
    // A membership row pointing at a workspace that is gone is skipped rather
    // than reported: the reach it would name does not exist.
    if (workspace === null) continue;
    const row = {
      workspaceId: workspace._id,
      slug: workspace.slug,
      role: membership.role,
      kind: workspace.kind,
    } as {
      workspaceId: Id<"workspaces">;
      slug: string;
      role: string;
      kind: "personal" | "shared";
      grantedNames?: string[];
    };
    if (includeGrantedNames) {
      row.grantedNames = await grantedNamesFor(ctx, workspace._id, live.grant.userId);
    }
    rows.push(row);
  }

  // See the header. Last, after the cap, and skipped when a real membership
  // already put this workspace in the set.
  const pinned = await pinnedContextRow(
    ctx,
    new Set(rows.map((row) => row.workspaceId)),
  );
  if (pinned !== null) {
    // The pin reader's guest names go to every client, not only the console's: they are what makes the gateway
    // read the pinned workspace as a guest (`lib/pinnedReaders.ts`), and without them an AI client would be
    // judged as a member. None before the migration, as there always were none here.
    const names = (await pinReaderNames(ctx, pinned.workspaceId, live.grant.userId)) ?? [];
    rows.push(names.length === 0 ? pinned : { ...pinned, grantedNames: names });
  }

  return rows;
}

/**
 * The pin for a group chat's grant, as a row the gateway may open only to read
 * Tex's setup, or nothing: no pin on this deployment, or the chat's own
 * workspace is the pin (then the setup is read there already).
 *
 * A chat with a home there (`lib/textGroupHome.ts`) holds its row's token to
 * edit beside the names every pin reader holds, read as a chat reads
 * (`READS_AS_CHAT`, `lib/nodes/chatFolders.ts`): the home is the one row it
 * holds to edit, so the gateway's chat-home session (`sessionForChatHome`)
 * may change that folder and only read the rest. `chatHome` names the folder.
 */
/**
 * The group chat a grant is for, by its key (`textGroups.groupKey`), or null for any other grant. Read from the
 * grant's own row, never from the request: the gateway keys a chat's Tex notes by it (`store/texRouting.js`), so
 * this is the one place a turn learns which chat it is.
 */
export async function texChatIdOf(ctx: QueryCtx, live: LiveGrant): Promise<string | null> {
  const groupId = live.grant.texGroup?.groupId;
  if (groupId === undefined) return null;
  return (await ctx.db.get(groupId))?.groupKey ?? null;
}

async function groupSetupRow(ctx: QueryCtx, live: LiveGrant, own: Id<"workspaces">) {
  const pinned = await pinnedContextRow(ctx, new Set([own]));
  if (pinned === null) return [];
  const home = live.grant.texGroup === undefined ? null : await chatHomeOf(ctx, live.grant.texGroup.groupId);
  if (home !== null && home.workspaceId === pinned.workspaceId) {
    const token = `#${home.noteId}`;
    const names = [...new Set([...(await guestNamesIn(ctx, pinned.workspaceId)), READS_AS_CHAT_NAME, token, `${token}!edit`])];
    return [{ ...pinned, role: "editor", grantedNames: names, chatHome: home.folder, setupOnly: true as const }];
  }
  const names = (await pinReaderNames(ctx, pinned.workspaceId, live.grant.userId)) ?? [];
  return [{ ...pinned, ...(names.length === 0 ? {} : { grantedNames: names }), setupOnly: true as const }];
}

/** The rows a clearance may act on: never the setup-only pin of a group chat's grant. */
export function addressable<T extends { setupOnly?: true }>(rows: T[]): T[] {
  return rows.filter((row) => row.setupOnly !== true);
}
