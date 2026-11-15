/**
 * LAB DRAFTS OF TEX'S TEST CONVERSATIONS (Dev2, 2026-11-15: "build the 60 20 20 splits ... we're actually testing and
 * training based on real conversations"; "make sure that through the MCP it's easy for an agent to see and modify and
 * change training, dev sets"; prototype https://claude.ai/artifact/GAScQuRxZyASpH8xes4n9K).
 *
 * The Training and Dev conversations live in the repo, one file each (`apps/mcp/bench/sets/<set>/<id>.json`). A
 * change made in the Lab's Testing tab, or by an AI over the MCP's `tex_dev`, is kept here as a draft over that file:
 * the whole conversation as it now reads, its revision, and what each revision touched. Promote asks for the pull
 * request that writes the drafts into the repo (`.github/workflows/tex-lab-promote.yml`, `scripts/tex-sets-promote.mjs`);
 * once it merges, the drafts it carried are cleared. Nothing here changes Tex or a test run by itself.
 *
 * Two doors, the same edits (`packages/shared/src/texSetOps.cjs`): the Lab page as a staff member (`requireAdmin`),
 * and `tex_dev` through the gateway (`setAction`, reached from `texLabDrafts.forGateway`, which has already checked the
 * caller is a staff editor of the pinned context on an AI client of their own). The Test Set is never stored here: it
 * is people only and lives in the eval service, so every write refuses it.
 */

import { ConvexError, v } from "convex/values";
import { internalQuery, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { applyOps, blank, conflicts, OpError, OPEN_SETS } from "@context/shared/src/texSetOps.cjs";
import { requireAdmin } from "./lib/admin";
import { handleForUser } from "./lib/identities";
import { internalMutation, mutation } from "./lib/rowWatch/mutations";

/** A conversation must fit well inside a row. */
export const MAX_CONVO = 200_000;
/** At most this many change rows read back for a conflict check; a writer further behind reads the chat again. */
const MAX_CHANGES = 200;
const CONVO_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d{1,7}$/;
const TEST_REFUSED = "the Test Set is people only and lives in the eval service: it is never stored here";

type Row = Doc<"texSetConvos">;
type Convo = { id: string; set: string; msgs: unknown[]; [k: string]: unknown };
type Who = { userId: Id<"users">; via: string };
type Answer = Record<string, unknown> & { status: string };

const parse = (s: string): Convo | null => {
  try {
    const c = JSON.parse(s);
    return c && typeof c === "object" && Array.isArray(c.msgs) ? c : null;
  } catch {
    return null;
  }
};

async function rowOf(ctx: QueryCtx, convoId: string): Promise<Row | null> {
  if (!CONVO_ID.test(convoId)) return null;
  return await ctx.db
    .query("texSetConvos")
    .withIndex("by_convo", (q) => q.eq("convoId", convoId))
    .unique();
}

const nameOf = async (ctx: QueryCtx, cache: Map<string, string>, id: Id<"users">) => {
  let name = cache.get(id);
  if (name === undefined) {
    name = (await handleForUser(ctx, id).then((h) => (h ? "@" + h : null))) ?? "Someone";
    cache.set(id, name);
  }
  return name;
};

const draftOf = async (ctx: QueryCtx, r: Row, cache = new Map<string, string>()) => ({
  id: r.convoId,
  set: r.set,
  conv: r.data,
  rev: r.rev,
  by: await nameOf(ctx, cache, r.by),
  via: r.via,
  at: r.updatedAt,
  isNew: r.isNew,
  removed: r.removed,
  promote: r.promote ? { state: r.promote.state, rev: r.promote.rev, pr: r.promote.pr ?? null, why: r.promote.why ?? null } : null,
});

/** A conversation as a caller handed it (an object or its JSON): the one this store may hold, or why not. */
function sound(value: unknown, id?: string): { convo: Convo } | { error: string } {
  const c = typeof value === "string" ? parse(value) : value && typeof value === "object" && Array.isArray((value as Convo).msgs) ? (value as Convo) : null;
  if (c === null) return { error: "a conversation is { id, title, set, kind, members, msgs }" };
  if (typeof c.id !== "string" || !CONVO_ID.test(c.id)) return { error: "a conversation's id is lowercase letters, digits and dashes" };
  if (id !== undefined && c.id !== id) return { error: `the conversation's id is ${id}` };
  if (c.set === "test") return { error: TEST_REFUSED };
  if (!(OPEN_SETS as readonly string[]).includes(c.set)) return { error: 'set is "training" or "dev"' };
  if (JSON.stringify(c).length > MAX_CONVO) return { error: "this conversation is too big to save" };
  return { convo: c };
}

/** Every draft, newest first. */
async function listDrafts(ctx: QueryCtx) {
  const rows = (await ctx.db.query("texSetConvos").collect()).sort((a, b) => b.updatedAt - a.updatedAt);
  const cache = new Map<string, string>();
  return await Promise.all(rows.map((r) => draftOf(ctx, r, cache)));
}

/**
 * A batch of edits to one conversation. `base` is the repo's file, needed only the first time a repo conversation is
 * changed (its revision is 0 then). An edit against an older revision lands unless a revision since touched one of the
 * same pieces; then it is refused with the conversation as it is now, so neither side overwrites the other unseen.
 */
async function editConvo(ctx: MutationCtx, who: Who, a: { id: unknown; rev: unknown; ops: unknown; base?: unknown }, now: number): Promise<Answer> {
  const id = typeof a.id === "string" ? a.id : "";
  if (!CONVO_ID.test(id)) return { status: "bad_request", error: "name the conversation by its id" };
  const row = await rowOf(ctx, id);
  let current: Convo;
  if (row) {
    if (row.removed) return { status: "bad_request", error: `${id} is set to be deleted at the next Promote; restore it first` };
    current = parse(row.data) as Convo;
  } else {
    if (a.base === undefined) return { status: "not_found", error: `there is no draft of ${id}: pass base, the repo's conversation, to start one` };
    const base = sound(a.base, id);
    if ("error" in base) return { status: "bad_request", error: base.error };
    current = base.convo;
  }
  const rowRev = row?.rev ?? 0;
  const baseRev = typeof a.rev === "number" && Number.isSafeInteger(a.rev) ? a.rev : -1;
  if (baseRev < 0 || baseRev > rowRev) return { status: "bad_request", error: `rev is the revision you read (now ${rowRev})` };
  let applied;
  try {
    applied = applyOps(current as never, a.ops as never) as { convo: Convo; keys: string[]; said: string[]; full: string[] };
  } catch (error) {
    if (error instanceof OpError) return { status: "bad_request", error: error.message };
    throw error;
  }
  if (baseRev < rowRev) {
    const since = await ctx.db
      .query("texSetChanges")
      .withIndex("by_convo_rev", (q) => q.eq("convoId", id).gt("rev", baseRev))
      .take(MAX_CHANGES);
    const touched = since.flatMap((c) => c.keys);
    const hit = since.length >= MAX_CHANGES ? ["*"] : conflicts(applied.keys, touched);
    if (hit.length) return { status: "conflict", rev: rowRev, keys: hit, conv: row!.data, next: "read the conversation again and redo the edit against it" };
  }
  const check = sound(applied.convo, id);
  if ("error" in check) return { status: "bad_request", error: check.error };
  const data = JSON.stringify(applied.convo);
  const rev = rowRev + 1;
  const set = applied.convo.set as "training" | "dev";
  if (row) await ctx.db.patch(row._id, { data, set, rev, by: who.userId, via: who.via, updatedAt: now });
  else await ctx.db.insert("texSetConvos", { convoId: id, set, data, isNew: false, removed: false, rev, by: who.userId, via: who.via, updatedAt: now });
  await ctx.db.insert("texSetChanges", { convoId: id, rev, by: who.userId, via: who.via, keys: applied.keys, said: applied.said, at: now });
  return { status: "ok", id, rev, said: applied.said, conv: data };
}

/** A conversation the repo does not have yet: an empty one in a set, or a whole one handed in. */
async function createConvo(ctx: MutationCtx, who: Who, a: { conv?: unknown; id?: unknown; title?: unknown; set?: unknown; kind?: unknown; members?: unknown }, repoIds: string[], now: number): Promise<Answer> {
  let convo: unknown = a.conv;
  if (convo === undefined) {
    try {
      convo = blank({ id: String(a.id ?? ""), title: typeof a.title === "string" ? a.title : undefined, set: typeof a.set === "string" ? a.set : undefined, kind: a.kind === "group" ? "group" : "one", members: Array.isArray(a.members) ? (a.members as string[]) : undefined } as never);
    } catch (error) {
      if (error instanceof OpError) return { status: "bad_request", error: error.message };
      throw error;
    }
  }
  const got = sound(convo);
  if ("error" in got) return { status: "bad_request", error: got.error };
  const id = got.convo.id;
  if ((await rowOf(ctx, id)) !== null || repoIds.includes(id)) return { status: "bad_request", error: `there is already a conversation ${id}` };
  const data = JSON.stringify(got.convo);
  await ctx.db.insert("texSetConvos", { convoId: id, set: got.convo.set as "training" | "dev", data, isNew: true, removed: false, rev: 1, by: who.userId, via: who.via, updatedAt: now });
  await ctx.db.insert("texSetChanges", { convoId: id, rev: 1, by: who.userId, via: who.via, keys: ["*"], said: [`made ${id}`], at: now });
  return { status: "ok", id, rev: 1, conv: data };
}

/**
 * Delete a conversation: a new one goes at once; one in the repo is marked to be deleted at the next Promote (its
 * file is public history, so the deletion is the pull request's). `restore` takes the mark, and the draft, back.
 */
async function removeConvo(ctx: MutationCtx, who: Who, a: { id?: unknown; base?: unknown; restore?: unknown }, now: number): Promise<Answer> {
  const id = typeof a.id === "string" ? a.id : "";
  const row = await rowOf(ctx, id);
  if (a.restore === true) {
    if (!row) return { status: "ok", id, restored: true };
    if (row.isNew) return { status: "bad_request", error: `${id} is new: it has no repo copy to go back to (delete it instead)` };
    await deleteRows(ctx, id);
    return { status: "ok", id, restored: true };
  }
  if (row?.isNew) {
    await deleteRows(ctx, id);
    return { status: "ok", id, deleted: "now" };
  }
  let data = row?.data;
  if (data === undefined) {
    const base = sound(a.base, id);
    if ("error" in base) return { status: row ? "bad_request" : "not_found", error: row ? base.error : `pass base, the repo's ${id}, to delete it` };
    data = JSON.stringify(base.convo);
  }
  const rev = (row?.rev ?? 0) + 1;
  const set = (parse(data)?.set ?? "dev") as "training" | "dev";
  if (row) await ctx.db.patch(row._id, { removed: true, rev, by: who.userId, via: who.via, updatedAt: now });
  else await ctx.db.insert("texSetConvos", { convoId: id, set, data, isNew: false, removed: true, rev, by: who.userId, via: who.via, updatedAt: now });
  await ctx.db.insert("texSetChanges", { convoId: id, rev, by: who.userId, via: who.via, keys: ["*"], said: [`asked to delete ${id}`], at: now });
  return { status: "ok", id, deleted: "at the next Promote" };
}

async function deleteRows(ctx: MutationCtx, id: string) {
  const row = await rowOf(ctx, id);
  if (row) await ctx.db.delete(row._id);
  for (const c of await ctx.db
    .query("texSetChanges")
    .withIndex("by_convo_rev", (q) => q.eq("convoId", id))
    .collect())
    await ctx.db.delete(c._id);
}

/** Ask for the drafts named (or every draft) to go into the repo through a pull request. */
async function askPromote(ctx: MutationCtx, who: Who, a: { ids?: unknown }, now: number): Promise<Answer> {
  const rows = await ctx.db.query("texSetConvos").collect();
  const want = Array.isArray(a.ids) ? new Set(a.ids.filter((x): x is string => typeof x === "string")) : null;
  const picked = rows.filter((r) => !want || want.has(r.convoId));
  if (want && picked.length !== want.size) return { status: "not_found", error: `no draft of ${[...want].filter((id) => !rows.some((r) => r.convoId === id)).join(", ")}` };
  for (const r of picked) await ctx.db.patch(r._id, { promote: { state: "asked", by: who.userId, at: now, rev: r.rev } });
  return { status: "ok", asked: picked.map((r) => r.convoId), then: "the pull request opens within 15 minutes; it merges through CI, and the drafts it carried are cleared" };
}

/**
 * Every `tex_dev` action on test conversations, for a caller `texLabDrafts.forGateway` has already let in: null for
 * any other action. The gateway reads the repo's conversations itself and passes `repoIds` for `set_create`.
 */
export async function setAction(ctx: MutationCtx, who: Who, action: string, a: Record<string, unknown>, now: number): Promise<Answer | null> {
  switch (action) {
    case "set_drafts":
      return { status: "ok", drafts: await listDrafts(ctx) };
    case "set_edit":
      return await editConvo(ctx, who, { id: a.id, rev: a.rev, ops: a.ops, base: a.base }, now);
    case "set_create":
      return await createConvo(ctx, who, a, Array.isArray(a.repoIds) ? (a.repoIds as string[]) : [], now);
    case "set_remove":
      return await removeConvo(ctx, who, a, now);
    case "set_promote":
      return await askPromote(ctx, who, a, now);
    default:
      return null;
  }
}

const fail = (answer: Answer) => {
  if (answer.status === "ok") return answer;
  throw new ConvexError(answer.status === "conflict" ? `Someone else changed the same thing (now revision ${answer.rev}): read it again` : String(answer.error ?? "That could not be saved"));
};

// The Lab's Testing tab: the same work, as a staff member with their second factor.

/** Every draft over the repo's conversations. */
export const list = query({
  args: {},
  returns: v.object({ drafts: v.array(v.any()) }),
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return { drafts: await listDrafts(ctx) };
  },
});

export const edit = mutation({
  args: { id: v.string(), rev: v.number(), ops: v.array(v.any()), base: v.optional(v.any()) },
  returns: v.any(),
  handler: async (ctx, a) => {
    const actor = await requireAdmin(ctx);
    const answer = await editConvo(ctx, { userId: actor.userId, via: "lab" }, a, Date.now());
    // A conflict is an answer the tab shows (the chat as it is now), not an error.
    return answer.status === "conflict" ? answer : fail(answer);
  },
});

export const create = mutation({
  args: { conv: v.any(), repoIds: v.optional(v.array(v.string())) },
  returns: v.any(),
  handler: async (ctx, a) => {
    const actor = await requireAdmin(ctx);
    return fail(await createConvo(ctx, { userId: actor.userId, via: "lab" }, { conv: a.conv }, a.repoIds ?? [], Date.now()));
  },
});

export const remove = mutation({
  args: { id: v.string(), base: v.optional(v.any()), restore: v.optional(v.boolean()) },
  returns: v.any(),
  handler: async (ctx, a) => {
    const actor = await requireAdmin(ctx);
    return fail(await removeConvo(ctx, { userId: actor.userId, via: "lab" }, a, Date.now()));
  },
});

export const promote = mutation({
  args: { ids: v.optional(v.array(v.string())) },
  returns: v.any(),
  handler: async (ctx, a) => {
    const actor = await requireAdmin(ctx);
    return fail(await askPromote(ctx, { userId: actor.userId, via: "lab" }, a, Date.now()));
  },
});

// The promote workflow, with the deploy key.

/** The drafts asked to be promoted, at the revision asked, with who asked (a handle, never an address). */
export const asked = internalQuery({
  args: {},
  returns: v.array(v.object({ id: v.string(), set: v.string(), conv: v.string(), removed: v.boolean(), isNew: v.boolean(), rev: v.number(), by: v.string(), at: v.number() })),
  handler: async (ctx) => {
    const rows = (await ctx.db.query("texSetConvos").collect()).filter((r) => r.promote?.state === "asked");
    const cache = new Map<string, string>();
    const out = [];
    for (const r of rows.sort((x, y) => (x.promote?.at ?? 0) - (y.promote?.at ?? 0))) out.push({ id: r.convoId, set: r.set, conv: r.data, removed: r.removed, isNew: r.isNew, rev: r.rev, by: await nameOf(ctx, cache, r.promote!.by), at: r.promote!.at });
    return out;
  },
});

/** The drafts whose pull request is open, for the workflow to clear once it merges. */
export const opened = internalQuery({
  args: {},
  returns: v.array(v.object({ id: v.string(), rev: v.number(), pr: v.string() })),
  handler: async (ctx) =>
    (await ctx.db.query("texSetConvos").collect()).flatMap((r) => (r.promote?.state === "opened" && r.promote.pr ? [{ id: r.convoId, rev: r.promote.rev, pr: r.promote.pr }] : [])),
});

/** The workflow's answer for each draft: the pull request it went into, or why it was refused. */
export const answered = internalMutation({
  args: { items: v.array(v.object({ id: v.string(), at: v.number(), pr: v.optional(v.string()), why: v.optional(v.string()) })) },
  returns: v.null(),
  handler: async (ctx, { items }) => {
    for (const { id, at, pr, why } of items) {
      if (pr !== undefined && !PR_URL.test(pr)) throw new ConvexError("Not a pull request address");
      const row = await rowOf(ctx, id);
      if (!row?.promote || row.promote.state !== "asked" || row.promote.at !== at) continue;
      await ctx.db.patch(row._id, { promote: { ...row.promote, state: pr !== undefined ? "opened" : "refused", ...(pr !== undefined ? { pr } : {}), ...(why !== undefined ? { why: why.slice(0, 300) } : {}) } });
    }
    return null;
  },
});

/** Its pull request merged: a draft unchanged since it was promoted is now the repo's file, so it goes. */
export const merged = internalMutation({
  args: { pr: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, { pr }) => {
    if (!PR_URL.test(pr)) throw new ConvexError("Not a pull request address");
    const cleared: string[] = [];
    for (const r of await ctx.db.query("texSetConvos").collect()) {
      if (r.promote?.pr !== pr) continue;
      if (r.rev === r.promote.rev) {
        await deleteRows(ctx, r.convoId);
        cleared.push(r.convoId);
      } else await ctx.db.patch(r._id, { isNew: false, removed: false, promote: undefined });
    }
    return cleared;
  },
});
