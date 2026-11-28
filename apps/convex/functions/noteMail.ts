/**
 * Note mail mailboxes: which note an agent joined, as whom, and how far it
 * has read (`docs/decisions/note-mail.md`). The mail is in the note; nothing
 * here holds a word of it.
 *
 * Every function takes the presenting access token's hash and resolves the
 * live grant itself, so a mailbox is only ever reached by the connection that
 * joined it, and only while that grant is live and still reaches the
 * workspace.
 */

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { addressable, contextsForGrant, resolveLiveGrant, resolveRunGrant } from "./lib/controlPlane/liveGrants";
import { resolveHelperGrant } from "./lib/controlPlane/helperGrants";
import { deviceStillLive } from "./texMachineDevices";
import { TEXTS_CLIENT_ID } from "./textLinks";
import { handleForUser } from "./lib/identities";

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
const MAX_PATH = 1024;
const JOB_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_JOB_MAILBOXES = 20;
/** The roster's own names on every job note (`packages/tex/gateway/agent/jobNote.js`): a job never joins as one. */
const ROSTER_NAMES = new Set(["tex", "advisor"]);
/** The name a person's own Tex has in mail (`unjoinedName` in `apps/mcp/src/tools/notes/mail.js`). */
const TEX_NAME = "tex";
/** The most Tex-in-mail runs one mailbox may ask for in an hour: two agents answering each other stop here. */
export const MAX_TEX_MAIL_RUNS_PER_HOUR = 100;
const HOUR_MS = 60 * 60 * 1000;

/**
 * A person's own Tex's mailbox: joined as "tex" from their 1:1 texts (the texting grant, never a group chat's), by
 * no job and no machine. Mail sent to it wakes their Tex (`askTexMail`).
 */
function isTexBox(row: Doc<"noteMailboxes">, grant: Doc<"oauthGrants"> | null): grant is Doc<"oauthGrants"> {
  return row.name === TEX_NAME && row.jobId === undefined && row.machineId === undefined && grant !== null && grant.status === "active" && grant.clientId === TEXTS_CLIENT_ID;
}

const mailboxView = v.object({
  mailboxId: v.string(),
  workspaceId: v.id("workspaces"),
  path: v.string(),
  name: v.string(),
  readThrough: v.union(v.string(), v.null()),
});

function view(row: Doc<"noteMailboxes">) {
  return {
    mailboxId: row.mailboxId,
    workspaceId: row.workspaceId,
    path: row.path,
    name: row.name,
    readThrough: row.readThrough ?? null,
  };
}

/**
 * The grant a mail call acts as: a live grant, or a job part's run grant on the person's computer, which acts as the
 * job's own texting grant (`liveGrants.ts` `resolveRunGrant`). So a part reads and sends on the job note's mail with
 * the mailbox its job joined (the owner, 2026-11-05: the job, Tex and the advisor on one job note's mail).
 *
 * A run grant reaches only the mailboxes bound to its own job (`onlyJob`), never the rest of what its parent joined:
 * the part runs untrusted work on a computer, so it must not speak as Tex, the advisor or another job. It may join
 * any note's mail its grant reaches, but only as its job's own name and bound to its job (the owner, 2026-11-06:
 * "that's the whole point"; `joinMailbox`). A run grant that names no job reaches no mail.
 */
async function mailGrant(ctx: QueryCtx, hashedAccessToken: string) {
  const live = await resolveLiveGrant(ctx, hashedAccessToken);
  if (live !== null) return { ...live, onlyJob: null as string | null };
  // A bot's helper uses mail as its bot's grant does (`helperGrants.ts`); the gateway signs its lines as the helper.
  const helper = await resolveHelperGrant(ctx, hashedAccessToken);
  if (helper !== null) return { ...helper, onlyJob: null as string | null };
  const run = await resolveRunGrant(ctx, hashedAccessToken);
  if (run === null || run.run.jobId === undefined) return null;
  return { ...run, onlyJob: run.run.jobId as string | null };
}

/** Whether this grant may use a mailbox row: its own, and for a run grant only its job's. */
function mayUse(live: { grant: { _id: Id<"oauthGrants"> }; onlyJob: string | null }, row: Doc<"noteMailboxes">): boolean {
  return row.grantId === live.grant._id && (live.onlyJob === null || row.jobId === live.onlyJob);
}

/** The live mailbox this token's grant joined, or null for anything else. */
async function ownMailbox(ctx: QueryCtx, hashedAccessToken: string, mailboxId: string) {
  const live = await mailGrant(ctx, hashedAccessToken);
  if (live === null) return null;
  const row = await ctx.db
    .query("noteMailboxes")
    .withIndex("by_mailboxId", (q) => q.eq("mailboxId", mailboxId))
    .unique();
  if (row === null || !mayUse(live, row)) return null;
  const reach = addressable(await contextsForGrant(ctx, live));
  if (!reach.some((entry) => entry.workspaceId === row.workspaceId)) return null;
  return row;
}

/**
 * Join a note's mail as `name`. Joining again with the same name from the
 * same grant returns the same mailbox; a name another connection holds on
 * that note is refused, so two agents never share one inbox by accident.
 */
export const joinMailbox = internalMutation({
  args: {
    hashedAccessToken: v.string(),
    workspaceId: v.string(),
    path: v.string(),
    name: v.string(),
    mailboxId: v.string(),
    /** The Tex background job whose turn is joining, when it is one. Bound to the mailbox; see `jobMailboxes`. */
    jobId: v.optional(v.string()),
    /**
     * The person's own machine whose session is joining (a cloud VM's Claude Code). It must be live and the joining
     * grant's own person's; the gateway pushes new mail down its socket. See `jobMailboxes`.
     */
    machineId: v.optional(v.string()),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), mailbox: mailboxView }),
    v.object({ ok: v.literal(false), error: v.union(v.literal("name_taken"), v.literal("refused")) }),
    // A job part joined under a name that is not its job's own: `name` is the one it must use.
    v.object({ ok: v.literal(false), error: v.literal("own_name"), name: v.string() }),
  ),
  handler: async (ctx, args) => {
    const refused = { ok: false as const, error: "refused" as const };
    if (!NAME_RE.test(args.name) || args.name === "everyone") return refused;
    if (!args.path || args.path.length > MAX_PATH || !/^mb_[a-z0-9]{8,32}$/.test(args.mailboxId)) return refused;
    if (args.jobId !== undefined && !JOB_ID_RE.test(args.jobId)) return refused;
    const live = await mailGrant(ctx, args.hashedAccessToken);
    if (live === null) return refused;
    // A run grant (a job part on a computer) joins only for its own job: the job is taken from the grant, never from
    // the call, it never joins as one of the person's machines, and never as a roster name (Tex, the advisor).
    if (live.onlyJob !== null && ((args.jobId !== undefined && args.jobId !== live.onlyJob) || args.machineId !== undefined)) return refused;
    if (live.onlyJob !== null && ROSTER_NAMES.has(args.name)) return refused;
    const jobId = live.onlyJob ?? args.jobId;
    let machineId: Id<"texMachines"> | undefined;
    if (args.machineId !== undefined) {
      const id = ctx.db.normalizeId("texMachines", args.machineId);
      const machine = id === null ? null : await ctx.db.get(id);
      if (machine === null || machine.ownerId !== live.grant.userId || !(await deviceStillLive(ctx, machine))) return refused;
      machineId = machine._id;
    }
    const target = addressable(await contextsForGrant(ctx, live)).find((entry) => entry.workspaceId === args.workspaceId);
    if (!target) return refused;
    // A group chat's home in the pin is the one place in the pin it may hold a mailbox: its folder, never the pin.
    if (target.homeOnly === true && !(typeof target.chatHome === "string" && args.path.startsWith(`${target.chatHome}/`))) return refused;
    // A group asker's own personal workspace is read only to the chat (`lib/textGroupReach.ts` `askerOwnPersonal`): no mailbox there.
    if (target.askerOwn === true) return refused;
    const existing = await ctx.db
      .query("noteMailboxes")
      .withIndex("by_workspace_path_name", (q) =>
        q.eq("workspaceId", target.workspaceId).eq("path", args.path).eq("name", args.name),
      )
      .collect();
    const mine = existing.find((row) => row.grantId === live.grant._id);
    // The parent grant's box under this name is Tex's or another job's: a part never takes it over.
    if (live.onlyJob !== null && mine !== undefined && !mayUse(live, mine)) return refused;
    if (live.onlyJob !== null && mine === undefined) {
      // A job speaks under one name everywhere, the one its first mailbox has (its job note's), so it can never pass
      // itself off as a sibling job on a note that sibling has not joined yet.
      const own = await ctx.db
        .query("noteMailboxes")
        .withIndex("by_job", (q) => q.eq("jobId", live.onlyJob!))
        .filter((q) => q.eq(q.field("grantId"), live.grant._id))
        .first();
      if (own !== null && own.name !== args.name) return { ok: false as const, error: "own_name" as const, name: own.name };
    }
    if (mine) {
      // A rejoin that names a job re-binds the mailbox to it; a rejoin that names none leaves the binding as it is.
      if (jobId !== undefined && mine.jobId !== jobId) await ctx.db.patch(mine._id, { jobId });
      if (machineId !== undefined && mine.machineId !== machineId) await ctx.db.patch(mine._id, { machineId });
      return { ok: true as const, mailbox: view((await ctx.db.get(mine._id))!) };
    }
    if (existing.length > 0) return { ok: false as const, error: "name_taken" as const };
    const id = await ctx.db.insert("noteMailboxes", {
      mailboxId: args.mailboxId,
      grantId: live.grant._id,
      workspaceId: target.workspaceId,
      path: args.path,
      name: args.name,
      readThrough: new Date().toISOString(),
      ...(jobId !== undefined ? { jobId } : {}),
      ...(machineId !== undefined ? { machineId } : {}),
      createdAt: Date.now(),
    });
    return { ok: true as const, mailbox: view((await ctx.db.get(id))!) };
  },
});

/** The mailbox, if this token's grant joined it. */
export const getMailbox = internalQuery({
  args: { hashedAccessToken: v.string(), mailboxId: v.string() },
  returns: v.union(mailboxView, v.null()),
  handler: async (ctx, args) => {
    const row = await ownMailbox(ctx, args.hashedAccessToken, args.mailboxId);
    return row === null ? null : view(row);
  },
});

/** Move the mailbox's read mark forward to `readThrough`; never back. */
export const markMailRead = internalMutation({
  args: { hashedAccessToken: v.string(), mailboxId: v.string(), readThrough: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!Number.isFinite(Date.parse(args.readThrough))) return null;
    const row = await ownMailbox(ctx, args.hashedAccessToken, args.mailboxId);
    if (row === null) return null;
    const current = row.readThrough ? Date.parse(row.readThrough) : -Infinity;
    if (Date.parse(args.readThrough) > current) await ctx.db.patch(row._id, { readThrough: args.readThrough });
    return null;
  },
});

/**
 * The mailboxes on this note that a Tex background job joined, or a session on one of the person's own machines, and
 * whose own grant (and machine) is still live. The gateway reads these to deliver new mail at once: to the job, or
 * down the machine's socket in its own workspace's object (`machineWorkspaceId`). Empty unless the presenting grant reaches the workspace; capped at
 * `MAX_JOB_MAILBOXES`. Names and ids only, never mail text.
 */
export const jobMailboxes = internalQuery({
  args: { hashedAccessToken: v.string(), workspaceId: v.string(), path: v.string() },
  returns: v.array(
    v.object({
      mailboxId: v.string(),
      name: v.string(),
      jobId: v.optional(v.string()),
      machineId: v.optional(v.id("texMachines")),
      machineWorkspaceId: v.optional(v.id("workspaces")),
      /** A person's own Tex, joined from their texts: a line to it is answered by Tex in mail (`askTexMail`). */
      texChat: v.optional(v.literal(true)),
      own: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    if (!args.path || args.path.length > MAX_PATH) return [];
    const live = await mailGrant(ctx, args.hashedAccessToken);
    if (live === null) return [];
    const target = addressable(await contextsForGrant(ctx, live)).find((entry) => entry.workspaceId === args.workspaceId);
    if (!target) return [];
    if (target.homeOnly === true && !(typeof target.chatHome === "string" && args.path.startsWith(`${target.chatHome}/`))) return [];
    if (target.askerOwn === true) return [];
    const rows = await ctx.db
      .query("noteMailboxes")
      .withIndex("by_workspace_path_name", (q) => q.eq("workspaceId", target.workspaceId).eq("path", args.path))
      .collect();
    const out: Array<{
      mailboxId: string;
      name: string;
      jobId?: string;
      machineId?: Id<"texMachines">;
      machineWorkspaceId?: Id<"workspaces">;
      texChat?: true;
      own: boolean;
    }> = [];
    for (const row of rows) {
      if (out.length >= MAX_JOB_MAILBOXES) break;
      if (row.jobId === undefined && row.machineId === undefined && row.name !== TEX_NAME) continue;
      const grant = await ctx.db.get(row.grantId);
      if (grant === null || grant.status !== "active") continue;
      // `own`: joined by the presenting grant, so the sender is that job's own Tex (the gateway lets only Tex's own turn interrupt it).
      const own = mayUse(live, row);
      if (row.jobId === undefined && row.machineId === undefined) {
        if (isTexBox(row, grant)) out.push({ mailboxId: row.mailboxId, name: row.name, texChat: true, own });
      } else if (row.jobId !== undefined) out.push({ mailboxId: row.mailboxId, name: row.name, jobId: row.jobId, own });
      else if (row.machineId !== undefined) {
        const machine = await ctx.db.get(row.machineId);
        if (machine === null || !(await deviceStillLive(ctx, machine))) continue;
        out.push({ mailboxId: row.mailboxId, name: row.name, machineId: machine._id, machineWorkspaceId: machine.workspaceId, own });
      }
    }
    return out;
  },
});

/**
 * Wake a person's own Tex for mail sent to it on a note (Dev, 2026-11-27: "Tex in mail should be the same flow as tex
 * in comments, its own mini tex"; `docs/decisions/note-mail.md`). The gateway asks with the sender's token, right
 * after the line is written: the sender must reach the note's workspace, and the mailbox must be a person's own Tex's
 * on that same note (`isTexBox`). Tex's own grant never wakes itself. One run waits per mailbox at a time, so a burst
 * of lines is read by one run, and at most `MAX_TEX_MAIL_RUNS_PER_HOUR` an hour.
 *
 * Answers the owner's personal workspace, whose Tex store the gateway wakes, or null for every refusal alike.
 */
export const askTexMail = internalMutation({
  args: {
    hashedAccessToken: v.string(),
    workspaceId: v.string(),
    path: v.string(),
    mailboxId: v.string(),
    /**
     * The line is to an agent working for this person (`@handle` without the @), not to Tex: woken only when the
     * mailbox is that person's own Tex, the seat for an agent that holds none (`texSeatMailbox`).
     */
    forHandle: v.optional(v.string()),
  },
  returns: v.union(v.null(), v.object({ owner: v.id("workspaces") })),
  handler: async (ctx, args) => {
    if (!args.path || args.path.length > MAX_PATH || !/^mb_[a-z0-9]{8,32}$/.test(args.mailboxId)) return null;
    const live = await mailGrant(ctx, args.hashedAccessToken);
    if (live === null) return null;
    const target = addressable(await contextsForGrant(ctx, live)).find((entry) => entry.workspaceId === args.workspaceId);
    if (!target || target.askerOwn === true) return null;
    if (target.homeOnly === true && !(typeof target.chatHome === "string" && args.path.startsWith(`${target.chatHome}/`))) return null;
    const row = await ctx.db
      .query("noteMailboxes")
      .withIndex("by_mailboxId", (q) => q.eq("mailboxId", args.mailboxId))
      .unique();
    if (row === null || row.workspaceId !== target.workspaceId || row.path !== args.path) return null;
    const grant = await ctx.db.get(row.grantId);
    if (!isTexBox(row, grant) || mayUse(live, row)) return null;
    if (args.forHandle !== undefined && (await handleForUser(ctx, grant.userId)) !== args.forHandle) return null;
    const now = Date.now();
    const runs = await ctx.db
      .query("texMailRuns")
      .withIndex("by_mailbox", (q) => q.eq("mailboxId", row.mailboxId))
      .collect();
    let recent = 0;
    let waiting = false;
    for (const run of runs) {
      if (now - run.createdAt >= HOUR_MS) await ctx.db.delete(run._id); // ran, or never claimed: gone after an hour
      else {
        recent += 1;
        if (run.status === "due") waiting = true;
      }
    }
    if (!waiting) {
      if (recent >= MAX_TEX_MAIL_RUNS_PER_HOUR) return null;
      await ctx.db.insert("texMailRuns", {
        mailboxId: row.mailboxId,
        userId: grant.userId,
        ownerWorkspaceId: grant.workspaceId,
        workspaceId: row.workspaceId,
        path: row.path,
        status: "due",
        createdAt: now,
      });
    }
    return { owner: grant.workspaceId };
  },
});

/**
 * The person's own Tex as the seat for an agent of theirs that holds none (Dev, 2026-11-28: "I'll ask you to tell
 * Grokbot to do something, and you're not really holding a seat ... how do we work this out where even things that
 * don't hold a seat can still get an answer?"; `docs/decisions/note-mail.md`). When such an agent sends mail on a note,
 * the gateway asks with its token: the person's texting grant gets a "tex" mailbox on that note, so a reply to the
 * agent wakes their Tex there (`askTexMail` with `forHandle`) even after the agent's session has ended.
 *
 * Only the person's own agents: a live grant (never a job's run grant, a helper or Tex itself), reaching the note's
 * workspace, and their own active texting grant. A note where another grant already holds "tex" is left alone.
 * Answers the mailbox id, or null for every refusal alike.
 */
export const texSeatMailbox = internalMutation({
  args: { hashedAccessToken: v.string(), workspaceId: v.string(), path: v.string(), mailboxId: v.string() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, args) => {
    if (!args.path || args.path.length > MAX_PATH || !/^mb_[a-z0-9]{8,32}$/.test(args.mailboxId)) return null;
    const live = await resolveLiveGrant(ctx, args.hashedAccessToken);
    if (live === null || live.grant.clientId === TEXTS_CLIENT_ID) return null;
    const target = addressable(await contextsForGrant(ctx, { ...live, onlyJob: null })).find((entry) => entry.workspaceId === args.workspaceId);
    if (!target || target.askerOwn === true || target.homeOnly === true) return null;
    const grants = await ctx.db
      .query("oauthGrants")
      .withIndex("by_user", (q) => q.eq("userId", live.grant.userId))
      .collect();
    const texts = grants.find((grant) => grant.clientId === TEXTS_CLIENT_ID && grant.status === "active");
    if (texts === undefined) return null;
    const existing = await ctx.db
      .query("noteMailboxes")
      .withIndex("by_workspace_path_name", (q) => q.eq("workspaceId", target.workspaceId).eq("path", args.path).eq("name", TEX_NAME))
      .collect();
    const mine = existing.find((row) => row.grantId === texts._id && row.jobId === undefined && row.machineId === undefined);
    if (mine !== undefined) return mine.mailboxId;
    if (existing.length > 0) return null;
    await ctx.db.insert("noteMailboxes", {
      mailboxId: args.mailboxId,
      grantId: texts._id,
      workspaceId: target.workspaceId,
      path: args.path,
      name: TEX_NAME,
      readThrough: new Date().toISOString(),
      createdAt: Date.now(),
    });
    return args.mailboxId;
  },
});
