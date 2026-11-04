/**
 * A person's texting with Tex, copied into their person object so a text's session is opened there and not here
 * (decided by the owner, 2026-11-04: `docs/decisions/texting-assistant/texting-in-objects.md`).
 *
 * - **The record** (`recordFor`): the phones linked to the person, kept in the object only as keyed hashes
 *   (`apps/mcp/src/agent/textingPhone.js`, the same key the gateway derives); whether texting is paused; the scopes
 *   their role allows; their zone, Tex style and the identity block Tex is told every turn.
 * - **The push** (`push`): the record written whole into the object. A newer record always wins there, and an
 *   unlinked phone or a pause revokes every texting token the object opened.
 * - **The switch** (`texting` on the workspace's homes row): `object` once a push landed. Only then does
 *   `/agent-texts/session` name the personal workspace, which the texting Worker keeps and sends with the next text.
 * - **Each text** (`keepOpened`): the gateway asks the object, then Convex, in one write, re-checks the phone is still
 *   linked and texting not paused, keeps its copy of the grant (every route that takes the token resolves it from that
 *   copy), writes the audit row and re-arms the dream, check-in and housekeeping. Convex therefore still has the last
 *   word on a link: an unlink or a pause the object has not caught up on refuses the session here. A record older
 *   than `REFRESH_MS` is pushed again behind the answer, so a changed zone, style or name reaches the object.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalQuery, type ActionCtx, type DatabaseReader } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import { phoneSignInPaused } from "./lib/emailProof";
import { clampScopes, hasOperationScope } from "./lib/consentScopes";
import { getMembership } from "./lib/workspaceAuth";
import { accountTimeZone } from "./lib/routines/access";
import { effectiveTimeZone } from "./lib/routines/model";
import { personRow, settingsOf } from "./lib/texChatRules";
import { identityOfPerson } from "./lib/texIdentity/identity";
import { accessHomeOf } from "./lib/accessObjects/home";
import { consoleWorkspaceClient } from "./lib/workspaceObjects/door";
import { GATEWAY_SECRET_ENV_VAR } from "./lib/gatewayAuth";
import { TEXTS_SCOPES, isPhoneNumber, keepTextsGrant, personalWorkspaceOf } from "./textLinks";
import { textingPhoneHash } from "../../mcp/src/agent/textingPhone.js";

/** A record older than this is pushed again behind the next text. */
export const REFRESH_MS = 10 * 60 * 1000;
const MAX_PHONES = 10;

const plainRecord = v.object({
  userId: v.id("users"),
  phones: v.array(v.string()),
  paused: v.boolean(),
  scopes: v.array(v.string()),
  timeZone: v.union(v.string(), v.null()),
  settings: v.any(),
  identity: v.any(),
});

async function homesRow(ctx: { db: DatabaseReader }, workspaceId: Id<"workspaces">) {
  return await ctx.db
    .query("workspaceObjectHomes")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
}

/** The texting record for a personal workspace's person, phones in the clear (hashed by `push`), or null. */
export const recordFor = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(plainRecord, v.null()),
  handler: async (ctx, { workspaceId }) => {
    const workspace = await ctx.db.get(workspaceId);
    if (workspace === null || workspace.kind !== "personal" || workspace.createdBy === undefined) return null;
    const userId = workspace.createdBy as Id<"users">;
    const links = await ctx.db
      .query("phoneLinks")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(MAX_PHONES);
    const membership = await getMembership(ctx, workspaceId, userId);
    const scopes = membership === null ? [] : clampScopes(TEXTS_SCOPES, membership.role);
    return {
      userId,
      phones: links.map((link) => link.phone).filter(isPhoneNumber),
      paused: await phoneSignInPaused(ctx, userId),
      scopes: hasOperationScope(scopes) ? scopes : [],
      timeZone: effectiveTimeZone(undefined, await accountTimeZone(ctx, userId)),
      settings: settingsOf((await personRow(ctx, userId)) ?? {}),
      identity: await identityOfPerson(ctx, userId, workspaceId),
    };
  },
});

/** Whether texting for this personal workspace is answered by its object, and when its record was last pushed. */
export const textingHome = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ object: v.boolean(), pushedAt: v.union(v.number(), v.null()) }),
  handler: async (ctx, { workspaceId }) => {
    const row = await homesRow(ctx, workspaceId);
    return { object: row?.texting === "object", pushedAt: typeof row?.textingPushedAt === "number" ? row.textingPushedAt : null };
  },
});

/** The record pushed: when, and (on the first push of a switched person) the switch turned on. */
export const markPushed = internalMutation({
  args: { workspaceId: v.id("workspaces"), at: v.number(), switchOn: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { workspaceId, at, switchOn }) => {
    const row = await homesRow(ctx, workspaceId);
    if (row === null) return null;
    // Only a person whose connections their object already decides (`personAccess: object`) is switched.
    const on = switchOn && row.personAccess === "object";
    await ctx.db.patch(row._id, { textingPushedAt: at, ...(on && row.texting !== "object" ? { texting: "object" as const, textingSince: at } : {}) });
    return null;
  },
});

/** Back to Convex for this person: `/agent-texts/session` stops naming the workspace, so every text asks here again. */
export const switchOff = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, { workspaceId }) => {
    const row = await homesRow(ctx, workspaceId);
    if (row !== null && row.texting !== undefined) await ctx.db.patch(row._id, { texting: "convex" as const });
    return null;
  },
});

/** The hashed record as the object keeps it. */
export async function objectRecord(secret: string, record: { phones: string[]; paused: boolean; scopes: string[]; timeZone: string | null; settings: unknown; identity: unknown }, at: number) {
  const hashes = (await Promise.all(record.phones.map((phone) => textingPhoneHash(secret, phone)))).filter((hash): hash is string => typeof hash === "string");
  return { phoneHashes: hashes, paused: record.paused, scopes: record.scopes, timeZone: record.timeZone, settings: record.settings ?? null, identity: record.identity ?? null, at };
}

type TextingObject = { access: { texting: { put: (record: unknown) => Promise<{ kept?: boolean; revoked?: number; error?: string }> } } };
export type OpenTexting = (ctx: ActionCtx, workspaceId: Id<"workspaces">) => TextingObject | null;

/** Push the record; `switchOn` turns texting on for a switched person once it landed. */
export async function pushRecord(ctx: ActionCtx, workspaceId: Id<"workspaces">, switchOn: boolean, open: OpenTexting = (c, id) => consoleWorkspaceClient(c, id) as unknown as TextingObject | null): Promise<"pushed" | "skipped"> {
  const secret = process.env[GATEWAY_SECRET_ENV_VAR];
  if (!secret) return "skipped";
  const record = await ctx.runQuery(internal.functions.textingObjects.recordFor, { workspaceId });
  if (record === null) return "skipped";
  const client = open(ctx, workspaceId);
  if (client === null) return "skipped";
  const at = Date.now();
  const answer = await client.access.texting.put(await objectRecord(secret, record, at));
  if (answer?.kept !== true && answer?.kept !== false) throw new Error("the person object did not take the texting record");
  await ctx.runMutation(internal.functions.textingObjects.markPushed, { workspaceId, at, switchOn });
  return "pushed";
}

export const push = internalAction({
  args: { workspaceId: v.id("workspaces"), switchOn: v.optional(v.boolean()) },
  returns: v.union(v.literal("pushed"), v.literal("skipped")),
  handler: async (ctx, { workspaceId, switchOn }) => await pushRecord(ctx, workspaceId, switchOn === true),
});

/** Every personal workspace whose person's access is in their object, a page at a time. */
export const switchedPersonal = internalQuery({
  args: { after: v.union(v.string(), v.null()), limit: v.number() },
  returns: v.object({ ids: v.array(v.id("workspaces")), next: v.union(v.string(), v.null()) }),
  handler: async (ctx, { after, limit }) => {
    const page = await ctx.db
      .query("workspaceObjectHomes")
      .withIndex("by_person_access", (q) => q.eq("personAccess", "object"))
      .paginate({ cursor: after, numItems: Math.max(1, Math.min(limit, 100)) });
    return { ids: page.page.map((row) => row.workspaceId), next: page.isDone ? null : page.continueCursor };
  },
});

/** Push every switched person's record and turn texting on for each that landed. Run by hand; safe to repeat. */
export const backfill = internalAction({
  args: { after: v.optional(v.union(v.string(), v.null())), limit: v.optional(v.number()) },
  returns: v.object({ pushed: v.number(), skipped: v.number(), failed: v.number(), next: v.union(v.string(), v.null()) }),
  handler: async (ctx, { after = null, limit = 50 }): Promise<{ pushed: number; skipped: number; failed: number; next: string | null }> => {
    // Typed by hand: this action schedules itself, so inferring its type from `internal` would be circular.
    const { ids, next }: { ids: Id<"workspaces">[]; next: string | null } = await ctx.runQuery(internal.functions.textingObjects.switchedPersonal, { after, limit });
    let pushed = 0, skipped = 0, failed = 0;
    for (const workspaceId of ids) {
      try {
        if ((await pushRecord(ctx, workspaceId, true)) === "pushed") pushed += 1;
        else skipped += 1;
      } catch {
        failed += 1;
      }
    }
    if (next !== null) await ctx.scheduler.runAfter(0, internal.functions.textingObjects.backfill, { after: next, limit });
    return { pushed, skipped, failed, next };
  },
});

/**
 * A session the person object opened for one text (`/gateway/texts/opened`): Convex re-checks the phone, keeps its
 * copy of the grant with this token's hash, re-arms and audits (`keepTextsGrant`). Refused for anyone not switched.
 */
export const keepOpened = internalMutation({
  args: { personalWorkspaceId: v.id("workspaces"), phone: v.string(), hashedAccessToken: v.string(), hashedRefreshToken: v.string(), expiresAt: v.number() },
  returns: v.union(v.literal("linked"), v.literal("unlinked")),
  handler: async (ctx, args) => {
    const row = await homesRow(ctx, args.personalWorkspaceId);
    if (row?.texting !== "object" || (await accessHomeOf(ctx.db, args.personalWorkspaceId, "person")) !== "object") return "unlinked";
    const status = await keepTextsGrant(ctx, args);
    if (status === "linked" && !(typeof row.textingPushedAt === "number" && Date.now() - row.textingPushedAt < REFRESH_MS)) {
      await ctx.scheduler.runAfter(0, internal.functions.textingObjects.push, { workspaceId: args.personalWorkspaceId });
    }
    return status;
  },
});

/**
 * `/agent-texts/session` answered the old way for a linked phone: the personal workspace to name when its texting is
 * answered by its object, so the Worker sends it next time. A switched person reaching this means the object missed
 * (a first text, a new phone, a stale record), so its record is pushed again.
 */
export const sessionHint = internalMutation({
  args: { phone: v.string() },
  returns: v.union(v.id("workspaces"), v.null()),
  handler: async (ctx, { phone }) => {
    if (!isPhoneNumber(phone)) return null;
    const link = await ctx.db
      .query("phoneLinks")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .first();
    if (link === null) return null;
    const workspaceId = await personalWorkspaceOf(ctx, link.userId);
    if (workspaceId === null) return null;
    const row = await homesRow(ctx, workspaceId);
    if (row?.texting !== "object") return null;
    if (!(typeof row.textingPushedAt === "number" && Date.now() - row.textingPushedAt < 60_000)) {
      await ctx.scheduler.runAfter(0, internal.functions.textingObjects.push, { workspaceId });
    }
    return workspaceId;
  },
});

/** A workspace id as the gateway sent it, or null for anything that is not one. */
export const workspaceIdOf = internalQuery({
  args: { id: v.string() },
  returns: v.union(v.id("workspaces"), v.null()),
  handler: async (ctx, { id }) => {
    const normalized = ctx.db.normalizeId("workspaces", id);
    return normalized === null ? null : normalized;
  },
});
