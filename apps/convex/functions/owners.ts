/**
 * Who can own a project: the search behind a folder page's owner picker.
 *
 * An owner line (`owner:` in a note's frontmatter) names a person in the
 * workspace, an agent the workspace lists (optionally somebody's), or "any
 * agent". The picker offers only
 * those, and asks here for them as the person types, so a workspace with a
 * hundred members sends back the eight that match rather than the roster.
 * Ranking is `lib/owners/rank.ts`.
 *
 * ## What it discloses, and to whom
 *
 * People: this workspace's members by handle (`@seyi`), with their name beside
 * it, to a member — less than `workspaces.listMembers` already gives them, and
 * nothing about anybody outside it. An address is matched against what is
 * typed but never sent: a project page shows who owns the work, not how to
 * email them. A member with no handle is offered by name, and by address only
 * when there is nothing else to call them. A non-member gets
 * `workspaceNotFound`, identical to a workspace that does not exist.
 *
 * `resolveOwners` answers the other half: an owner line written before handles
 * (`owner: seyi@example.com`, `owner: Seyi Olujide`) still names that member,
 * and the page shows it as `@seyi` without rewriting anybody's note.
 *
 * Agents are not looked up here. They are a short list of names a workspace
 * writes down itself (`agents: Claude, Codex, Cursor` in its projects folder's
 * front note), each optionally somebody's (`@shay's Claude`), and the app
 * reads that list from the folder it is showing. Connected clients are not
 * that list: their names are whatever their software registered, and an
 * integration such as the Sentry incident inbox is connected without being
 * anybody's agent (Dev2, 2026-09-28). `agents` here is only the starting list
 * matched against what is typed, for an app older than the folder's own.
 *
 * ## The suggested owner
 *
 * On Premium, `suggestOwner` asks Jev which of those same candidates the note
 * being assigned names (`lib/owners/suggest.ts`). It reads that one note at
 * the caller's own clearance, never a locked one, and only an editor may ask:
 * the one who could write the answer. `searchOwners` says whether it is worth
 * asking (`suggests`), so a workspace without it makes no call at all.
 */

import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireAuthId } from "@supa-media/convex/auth";
import { internal } from "../_generated/api";
import { action, internalQuery, query, type QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { requireWorkspaceAccess } from "./lib/workspaceAuth";
import { handleForUser } from "./lib/identities";
import { DEFAULT_AGENTS } from "@context/shared/src/agentOwners";
import { fold, matchAgents, ownerValue, rankMembers, resolveOwnerWords, type OwnerMember } from "./lib/owners/rank";
import { type OwnerCandidates, type SuggestedOwner, mayRead, ownerRequest, readOwnerAnswer } from "./lib/owners/suggest";
import type { OperationResult } from "./lib/filesFns/operationTypes";
import { withJev } from "./lib/jev/client";
import { featureIsOn } from "./lib/jev/meter";
import { planFor, statusOf } from "./lib/billing/plan";
import { planIsPaying } from "./lib/premium";

/**
 * The most memberships one search reads. Far past any workspace this product
 * has, and a bound on a read whose size is otherwise set by whoever can invite.
 */
export const MAX_OWNER_SCAN = 1000;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const MAX_AGENTS = 12;
const MAX_TEXT = 80;
const MAX_PREFER = 12;
/** The most owner words one `resolveOwners` call reads: a folder's worth. */
const MAX_WORDS = 50;
/**
 * The most members whose handle one read looks up. A handle is two index reads
 * a member, so past this a very large workspace is offered by name instead of
 * running into the read limits; no workspace today is near it.
 */
const MAX_HANDLE_SCAN = 300;

/**
 * A name as one line an owner field can hold. Names are what their holders
 * typed, and an agent's is whatever a folder's front note says, so control
 * characters and line breaks go before either is offered to be written.
 */
function oneLine(text: string | undefined): string | undefined {
  const line = text?.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  return line === "" ? undefined : line;
}

export const searchOwners = query({
  args: {
    workspaceId: v.id("workspaces"),
    query: v.string(),
    /** Owner words the caller's folder already uses, most used first. */
    prefer: v.optional(v.array(v.string())),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    /** `value` is what the owner line will say; `name` is shown beside a handle. */
    people: v.array(v.object({ value: v.string(), name: v.optional(v.string()), isMe: v.boolean() })),
    /** The starting agents matching the query, for apps that predate the folder's own list. */
    agents: v.array(v.string()),
    /** The workspace has more members than one search reads. */
    truncated: v.boolean(),
    /** `suggestOwner` is on for this workspace: Premium, and not switched off. */
    suggests: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    const found = await findOwners(ctx, args.workspaceId, userId, args);
    return { ...found, suggests: await suggestsOwners(ctx, args.workspaceId) };
  },
});

async function findOwners(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  userId: Id<"users">,
  args: { query: string; prefer?: string[]; limit?: number },
) {
  await requireWorkspaceAccess(ctx, workspaceId, userId);

  const text = args.query.slice(0, MAX_TEXT);
  const prefer = (args.prefer ?? []).slice(0, MAX_PREFER).map((word) => word.slice(0, MAX_TEXT));
  const asked = Number.isFinite(args.limit) ? Math.floor(args.limit as number) : DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(MAX_LIMIT, asked));

  const { members, truncated } = await loadMembers(ctx, workspaceId, userId);
  const people = rankMembers(members, text, prefer, limit).map((member) => ({
    value: member.value,
    // A name that only repeats the handle (`@sayo`, Sayo) says nothing beside it.
    ...(member.name === undefined || member.name === member.value || fold(member.name) === fold(member.handle ?? "")
      ? {}
      : { name: member.name }),
    isMe: member.isMe,
  }));

  return { people, agents: matchAgents(DEFAULT_AGENTS, text, MAX_AGENTS), truncated };
}

/** A workspace's members as owners, read once for a search or a resolve. */
async function loadMembers(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  userId: Id<"users">,
): Promise<{ members: OwnerMember[]; truncated: boolean }> {
  const rows = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .take(MAX_OWNER_SCAN + 1);
  const truncated = rows.length > MAX_OWNER_SCAN;
  const withHandles = rows.length <= MAX_HANDLE_SCAN;
  const members: OwnerMember[] = [];
  for (const row of rows.slice(0, MAX_OWNER_SCAN)) {
    const user = await ctx.db.get(row.userId);
    const name = oneLine(user?.name);
    const email = oneLine(user?.email);
    const handle = withHandles ? oneLine((await handleForUser(ctx, row.userId)) ?? undefined) : undefined;
    const value = ownerValue({ handle, name, email });
    if (value === undefined) continue;
    members.push({
      value,
      ...(name === undefined ? {} : { name }),
      ...(email === undefined ? {} : { email }),
      ...(handle === undefined ? {} : { handle }),
      isMe: row.userId === userId,
    });
  }
  return { members, truncated };
}

/**
 * What owner words written before handles mean now: for each of `words` that
 * names exactly one member by address, full name or handle, the value the
 * picker would write for them (`@seyi`). Words that already say it that way,
 * name nobody, or name two people are left out, and the page shows them as
 * written. Any member may ask — it is the owner column every member reads —
 * and learns only handles, which `@name` addressing already makes public.
 */
export const resolveOwners = query({
  args: { workspaceId: v.id("workspaces"), words: v.array(v.string()) },
  returns: v.array(v.object({ word: v.string(), value: v.string() })),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    await requireWorkspaceAccess(ctx, args.workspaceId, userId);
    const words = args.words.slice(0, MAX_WORDS).map((word) => word.slice(0, MAX_TEXT));
    if (words.length === 0) return [];
    const { members } = await loadMembers(ctx, args.workspaceId, userId);
    return resolveOwnerWords(members, words);
  },
});

/** Premium, and the owner suggestion not switched off through Jev smarts. */
async function suggestsOwners(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<boolean> {
  if (!(await featureIsOn(ctx, "ownerSuggest"))) return false;
  return planIsPaying(statusOf(await planFor(ctx, workspaceId)));
}

/**
 * The agents a suggestion may name: the folder's own list as the app sent it,
 * each made one line, or the starting list when it sent none.
 */
function agentList(agents: readonly string[] | undefined): string[] {
  if (agents === undefined) return [...DEFAULT_AGENTS];
  const lines = agents.slice(0, MAX_AGENTS).map((agent) => oneLine(agent)).filter((agent): agent is string => agent !== undefined);
  return matchAgents(lines, "", MAX_AGENTS);
}

/** The candidates a suggestion chooses among: what the caller's own search offers first. */
export const ownerCandidates = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    prefer: v.array(v.string()),
    agents: v.optional(v.array(v.string())),
  },
  returns: v.object({
    people: v.array(v.string()),
    agents: v.array(v.string()),
    names: v.array(v.union(v.string(), v.null())),
  }),
  handler: async (ctx, args) => {
    const found = await findOwners(ctx, args.workspaceId, args.userId, { query: "", prefer: args.prefer });
    return {
      people: found.people.map((person) => person.value),
      agents: agentList(args.agents),
      names: found.people.map((person) => person.name ?? null),
    };
  },
});

/**
 * The owner the note at `path` names, among the people the caller's own
 * search would offer and the folder's agents — or null: not Premium, switched
 * off, a locked note, a note that names nobody, or Jev not answering. Null is "no
 * suggestion", never an error the picker has to show.
 */
export const suggestOwner = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    /** As `searchOwners`: the current owner first, then the folder's. */
    prefer: v.optional(v.array(v.string())),
    /** The folder's agents (`agents:` in its front note); the starting list when absent. */
    agents: v.optional(v.array(v.string())),
  },
  returns: v.union(
    v.null(),
    v.object({ value: v.string(), kind: v.union(v.literal("person"), v.literal("agent"), v.literal("any")) }),
  ),
  handler: async (ctx, args): Promise<SuggestedOwner | null> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    // Only somebody who could write the owner may ask, at their own clearance.
    const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId: userId,
      workspaceId: args.workspaceId,
      minimum: "editor",
    });
    const prefer = (args.prefer ?? []).slice(0, MAX_PREFER).map((word) => word.slice(0, MAX_TEXT));
    return await withJev(ctx, { feature: "ownerSuggest", workspaceId: args.workspaceId }, async (jev): Promise<SuggestedOwner | null> => {
      if (!jev) return null;
      let read: OperationResult;
      try {
        read = (await ctx.runAction(internal.functions.files.runFileOperation, {
          workspaceId: args.workspaceId,
          scope,
          grantedNames,
          operation: { kind: "read", path: args.path },
        })) as OperationResult;
      } catch {
        return null;
      }
      if (read.kind !== "file") return null;
      const note = { text: read.text, encrypted: read.encrypted };
      if (!mayRead(note)) return null;
      const candidates: OwnerCandidates = await ctx.runQuery(internal.functions.owners.ownerCandidates, {
        workspaceId: args.workspaceId,
        userId,
        prefer,
        ...(args.agents === undefined ? {} : { agents: args.agents }),
      });
      return readOwnerAnswer(await jev.decide(ownerRequest(note.text, candidates)), candidates);
    });
  },
});
