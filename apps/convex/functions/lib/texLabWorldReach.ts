/**
 * MADE-UP GROUP CHATS ON MAIN (Dev, 2026-11-24: "test main", rather than on a pull request's preview).
 *
 * A Lab test chat with made-up people, run on this deployment: nobody is made. The people live only in the test chat,
 * each with a role in some of the Lab user's OWN shared workspaces, and this answers what a real group chat of theirs
 * would reach, by the rule `lib/textGroupReach.ts` keeps for real chats:
 *
 *  - every SHARED workspace that ALL the people on Context are in, and every person with no account is invited to by
 *    number, at the LOWEST role among them;
 *  - never a personal workspace, and the pin only as a home-only grant's home row is, read as the chat with no home:
 *    Tex's own setup and nothing else;
 *  - read at team tier: no `context:private`, no granted names.
 *
 * It only ever narrows the Lab user's own access. A made-up role can't add a workspace the Lab user isn't in, nor
 * lift the role the Lab user holds there, so the session answered is a subset of the 1:1 session the Lab already runs
 * test texts on. No token is minted and nothing is written: the test turn runs on the Lab user's own token, as every
 * test chat on main does (`texLabSandbox.ts` `sessionFor`).
 */
import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { READS_AS_CHAT_NAME } from "./nodes/chatFolders";
import { pinnedContextRow, pinnedContextWorkspace } from "./pinnedContext";
import type { WorkspaceRole } from "./workspaceAuth";

/** Most people in a made-up chat (`world.js` `MAX_WORLD_PEOPLE`), and most workspaces a reach reads. */
const MAX_PEOPLE = 8;
const MEMBERSHIP_SCAN = 200;
/** Most workspaces a turn names as kept out, as a real chat's turn does (`textGroupBlockers.ts`). */
const MAX_BLOCKED = 3;
const RANK: Record<WorkspaceRole, number> = { member: 0, editor: 1, owner: 2 };
const ROLES = new Set<WorkspaceRole>(["owner", "editor", "member"]);

export type WorldPersonIn = { name: string; account: "on" | "off" | "invited"; roles?: Record<string, WorkspaceRole>; invited?: { slug: string; role: WorkspaceRole } };
export type Blocked = { slug: string; who: string; why: "not_member" | "no_account" };
type SessionRow = { workspaceId: Id<"workspaces">; slug: string; role: string; kind: "personal" | "shared"; setupOnly?: true; homeOnly?: true; grantedNames?: string[] };
/** The row token a made-up chat with no reach holds: shaped like one (`rowAccess.js` `ROW_NAME_PATTERN`), held by no row. */
export const NO_HOME = "#lab-world-no-home";

/** The people as asked, checked: names, accounts and roles of the right shapes, or null. */
export function worldPeopleOf(raw: unknown): WorldPersonIn[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_PEOPLE) return null;
  const out: WorldPersonIn[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") return null;
    const r = p as Record<string, unknown>;
    if (typeof r.name !== "string" || r.name.length < 1 || r.name.length > 40) return null;
    if (r.account !== "on" && r.account !== "off" && r.account !== "invited") return null;
    const roles: Record<string, WorkspaceRole> = {};
    if (r.account === "on" && r.roles && typeof r.roles === "object") {
      for (const [slug, role] of Object.entries(r.roles as Record<string, unknown>)) if (typeof role === "string" && ROLES.has(role as WorkspaceRole)) roles[slug] = role as WorkspaceRole;
    }
    const inv = r.invited as Record<string, unknown> | undefined;
    const invited = r.account === "invited" && inv && typeof inv.slug === "string" && (inv.role === "editor" || inv.role === "member") ? { slug: inv.slug, role: inv.role as WorkspaceRole } : undefined;
    out.push({ name: r.name, account: r.account, ...(r.account === "on" ? { roles } : {}), ...(invited ? { invited } : {}) });
  }
  return out;
}

/** The role a person counts at in `slug`, or null when they keep it out (and why). */
function standing(p: WorldPersonIn, slug: string): { role: WorkspaceRole } | { why: Blocked["why"] } {
  if (p.account === "on") return p.roles?.[slug] ? { role: p.roles[slug] } : { why: "not_member" };
  if (p.account === "invited" && p.invited?.slug === slug) return { role: p.invited.role };
  return { why: "no_account" };
}

/**
 * The Lab user's shared workspaces a made-up chat could reach, by slug: the ones its people can be given roles in.
 * Never personal, never the pin.
 */
export async function worldWorkspaces(ctx: QueryCtx, userId: Id<"users">) {
  const pin = await pinnedContextWorkspace(ctx);
  const memberships = await ctx.db.query("workspaceMembers").withIndex("by_user", (q) => q.eq("userId", userId)).take(MEMBERSHIP_SCAN);
  const out: Array<{ workspaceId: Id<"workspaces">; slug: string; name: string; role: WorkspaceRole }> = [];
  for (const m of memberships) {
    const w = await ctx.db.get(m.workspaceId);
    if (w === null || w.kind !== "shared" || (pin !== null && w._id === pin._id)) continue;
    out.push({ workspaceId: w._id, slug: w.slug, name: w.displayName || w.slug, role: m.role });
  }
  return out.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

/**
 * What a made-up chat reaches on main, and the session its turn runs on: the Lab user's 1:1 session (`base`) with its
 * workspaces put back to the pin's setup row and the reached workspaces only, at team tier.
 */
/** A made-up chat's group id, as the gateway names it (`labSandbox/route.js` `openWorld`). */
export const WORLD_GROUP_ID = /^lab-world-[0-9a-f]{16}$/;

/**
 * The made-up chat's key, worked out here from its group id and never taken from the caller, so a caller can't name a
 * real chat's key and read its Tex notes: a hash no real chat's key is (`textGroups.groupKey` hashes the line and the
 * chat's own id), checked against them all the same. Null when a real chat has it.
 */
export async function worldChatKey(ctx: QueryCtx, groupId: string): Promise<string | null> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`lab-world:${groupId}`)));
  const key = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const real = await ctx.db.query("textGroups").withIndex("by_key", (q) => q.eq("groupKey", key)).first();
  return real === null ? key : null;
}

export async function worldReach(ctx: QueryCtx, userId: Id<"users">, base: { scopes: string[]; texChatId?: string; [k: string]: unknown }, people: WorldPersonIn[], chatKey: string) {
  const mine = await worldWorkspaces(ctx, userId);
  const reached: SessionRow[] = [];
  const blocked: Blocked[] = [];
  for (const w of mine) {
    const stands = people.map((p) => ({ p, s: standing(p, w.slug) }));
    const out = stands.flatMap((x) => ("why" in x.s ? [{ slug: w.slug, who: x.p.name, why: x.s.why }] : []));
    if (people.length > 0 && out.length === 0) {
      // The lowest role among them, never above the Lab user's own.
      let role = w.role;
      for (const x of stands) if ("role" in x.s && RANK[x.s.role] < RANK[role]) role = x.s.role;
      reached.push({ workspaceId: w.workspaceId, slug: w.slug, role, kind: "shared" });
    } else if (new Set(blocked.map((b) => b.slug)).size < MAX_BLOCKED) {
      blocked.push(...out);
    }
  }
  const setup = await pinnedContextRow(ctx, new Set());
  if (setup === null) return { status: "not_found" as const, error: "This deployment has no pinned workspace for a made-up chat's setup." };
  // The pin as a home-only chat's home row (`textGroupHomeOnly.ts` `homeOnlyRows`), first and the default, reached or
  // not: read as the chat (`READS_AS_CHAT`), holding only a token no row has, so every row there reads as private and no
  // write lands there, at the editor's hand a real home has. The hand is what the texting routes need: a group turn
  // posts its texts and reads its day through `/agent/events` and `/agent/chat` on the default row's scopes, which a
  // member's role clamps to read (found on production, 2026-11-24: every reply was drafted and never sent, 403). A
  // made-up chat has no home of its own. Then each reached workspace, at the lowest role among its people.
  const workspaces: SessionRow[] = [{ ...setup, role: "editor", homeOnly: true as const, grantedNames: [READS_AS_CHAT_NAME, NO_HOME] }, ...reached];
  // A group chat's client, so the turn runs under a group's rules (no vault, no 1:1 approvals), and the made-up chat's
  // own key as its chat, never the 1:1's: its Tex notes are an empty chat's, and a group turn needs a chat to keep its
  // record in (found on production, 2026-11-24: with none, every turn failed at the Door).
  const { texChatId: _oneToOne, ...rest } = base;
  const session = {
    ...rest,
    clientId: "context_texts_group",
    texChatId: chatKey,
    // Team tier: a group never reads `context:private`, whoever tagged Tex.
    scopes: base.scopes.filter((s) => s !== "context:private"),
    defaultWorkspaceId: setup.workspaceId,
    workspaces,
  };
  return { status: "ok" as const, session, reach: reached.map((r) => r.slug), blocked, workspaces: mine.map(({ slug, name }) => ({ slug, name })) };
}
