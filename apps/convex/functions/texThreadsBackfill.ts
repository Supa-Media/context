/**
 * Replaying every Tex chat's whole history into its conversations (Dev2,
 * 2026-11-07: "Backfill full history";
 * `docs/decisions/texting-assistant/conversation-threads.md`). Live turns sort
 * each new text as it comes; this sorts the texts from before.
 *
 * The replay itself is the gateway's (`apps/mcp/src/agent/threadsBackfill.js`):
 * a chat's words are read from its Tex object, sorted by the classifier and
 * written back there, and never come here. This only pages through the chats
 * and calls the gateway's door (`POST /internal/threads/backfill`) for each,
 * with the gateway secret and a ticket naming that chat's object, part after
 * part until it is finished. A page that runs out of time is answered with the
 * cursor it started from, so the next call goes on with it; a chat already
 * finished answers `done` at once.
 *
 * `scope` is `chats` (each personal workspace's one-to-one chat) or `groups`
 * (each group chat, its ticket in the workspace it is bound to, else the pin).
 * Run from the `Tex chats into their ledger` workflow, first with `dryRun`.
 * It answers counts and fixed codes only: the workflow's log is public.
 * Internal only.
 */

import { v } from "convex/values";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { internalAction, internalQuery } from "../_generated/server";
import { hashToken } from "./lib/crypto";
import { GATEWAY_SECRET_ENV_VAR, randomOpaqueToken } from "./lib/gatewayAuth";
import { pinnedContextWorkspace } from "./lib/pinnedContext";
import { storageMoverOrigin } from "./lib/storageMover";
import { failureCode } from "./texHistoryMigration";

const PATH = "/internal/threads/backfill";
const CHATS_PER_CALL = 5;
/** One door call: the gateway stops a part well before this. */
const CALL_TIMEOUT_MS = 90_000;
/** How long one page may work before it hands back its cursor (as `workspaceObjects.ts`): a first run of 7 minutes died at about 5 with no answer, 2026-11-07. */
const ACTION_BUDGET_MS = 2 * 60_000;

type Chat = { workspaceId: Id<"workspaces">; owner: string };
type Part = { state: string; turns: number; written: number; failed: number; left: number };
type Counts = {
  chats: number;
  skipped: number;
  already: number;
  finished: number;
  partly: number;
  none: number;
  would: number;
  left: number;
  turns: number;
  written: number;
  unsorted: number;
  failed: number;
  failedCodes: Record<string, number>;
  cursor: string;
  done: boolean;
};

/** One page of group chats, each with the workspace its ticket is minted in. */
export const groupPage = internalQuery({
  args: { cursor: v.optional(v.string()), limit: v.number() },
  returns: v.object({ chats: v.array(v.object({ groupKey: v.string(), workspaceId: v.union(v.id("workspaces"), v.null()) })), cursor: v.string(), done: v.boolean() }),
  handler: async (ctx, { cursor, limit }) => {
    const pin = (await pinnedContextWorkspace(ctx))?._id ?? null;
    const page = await ctx.db.query("textGroups").paginate({ cursor: cursor ?? null, numItems: limit });
    return { chats: page.page.map((chat) => ({ groupKey: chat.groupKey, workspaceId: chat.workspaceId ?? pin })), cursor: page.continueCursor, done: page.isDone };
  },
});

/** One part of one chat's replay, through the gateway's door. */
async function callDoor(ctx: ActionCtx, chat: Chat, dryRun: boolean, env: Record<string, string | undefined> = process.env): Promise<Part> {
  const origin = storageMoverOrigin(env);
  const secret = env[GATEWAY_SECRET_ENV_VAR];
  if (origin === null || !secret) throw Object.assign(new Error("no way to the gateway"), { code: "NO_GATEWAY" });
  const ticket = randomOpaqueToken();
  await ctx.runMutation(internal.functions.texStoreTickets.mint, { hashedTicket: await hashToken(ticket), workspaceId: chat.workspaceId, owners: [chat.owner], now: Date.now() });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const response = await fetch(`${origin}${PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "x-tex-ticket": ticket, "content-type": "application/json" },
      body: JSON.stringify({ owner: chat.owner, dryRun }),
      signal: controller.signal,
      redirect: "manual",
    });
    const body = (await response.json().catch(() => null)) as (Part & { error?: string }) | null;
    if (!response.ok || body === null || typeof body.state !== "string") {
      const code = typeof body?.error === "string" && /^[a-z_]{1,40}$/.test(body.error) ? body.error : `HTTP_${response.status}`;
      throw Object.assign(new Error("the door refused"), { code });
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One chat, part after part while `timeLeft()` says there is time: the last
 * part's state, and what all its parts sorted.
 */
export async function replayChat(call: () => Promise<Part>, timeLeft: () => boolean): Promise<{ last: Part | null; turns: number; written: number; unsorted: number }> {
  let last: Part | null = null;
  let turns = 0;
  let written = 0;
  let unsorted = 0;
  while (timeLeft()) {
    last = await call();
    turns += last.turns;
    written += last.written;
    unsorted += last.failed;
    if (last.state !== "partly") break;
  }
  return { last, turns, written, unsorted };
}

export const run = internalAction({
  args: { scope: v.union(v.literal("chats"), v.literal("groups")), dryRun: v.boolean(), cursor: v.optional(v.string()) },
  returns: v.object({
    chats: v.number(),
    skipped: v.number(),
    already: v.number(),
    finished: v.number(),
    partly: v.number(),
    none: v.number(),
    would: v.number(),
    left: v.number(),
    turns: v.number(),
    written: v.number(),
    unsorted: v.number(),
    failed: v.number(),
    failedCodes: v.record(v.string(), v.number()),
    cursor: v.string(),
    done: v.boolean(),
  }),
  handler: async (ctx, { scope, dryRun, cursor }): Promise<Counts> => {
    const began = Date.now();
    const counts: Counts = { chats: 0, skipped: 0, already: 0, finished: 0, partly: 0, none: 0, would: 0, left: 0, turns: 0, written: 0, unsorted: 0, failed: 0, failedCodes: {}, cursor: "", done: false };
    const fail = (code: string) => {
      counts.failed += 1;
      counts.failedCodes[code] = (counts.failedCodes[code] ?? 0) + 1;
    };
    let chats: Chat[] = [];
    let next: { cursor: string; done: boolean };
    if (scope === "chats") {
      const page: { workspaceIds: Id<"workspaces">[]; cursor: string; done: boolean } = await ctx.runQuery(internal.functions.folderNumbers.workspacePage, { ...(cursor ? { cursor } : {}), limit: CHATS_PER_CALL });
      for (const workspaceId of page.workspaceIds) {
        if ((await ctx.runQuery(internal.functions.texHistoryMigrationRows.kindOf, { workspaceId })) === "personal") chats.push({ workspaceId, owner: `person:${workspaceId}` });
        else counts.skipped += 1;
      }
      next = { cursor: page.cursor, done: page.done };
    } else {
      const page: { chats: { groupKey: string; workspaceId: Id<"workspaces"> | null }[]; cursor: string; done: boolean } = await ctx.runQuery(internal.functions.texThreadsBackfill.groupPage, { ...(cursor ? { cursor } : {}), limit: CHATS_PER_CALL });
      for (const chat of page.chats) {
        if (chat.workspaceId === null || !/^[0-9a-f]{64}$/.test(chat.groupKey)) counts.skipped += 1;
        else chats.push({ workspaceId: chat.workspaceId, owner: `chat:${chat.groupKey}` });
      }
      next = { cursor: page.cursor, done: page.done };
    }
    let unfinished = false;
    for (const chat of chats) {
      counts.chats += 1;
      try {
        const replayed = await replayChat(() => callDoor(ctx, chat, dryRun), () => Date.now() - began < ACTION_BUDGET_MS);
        const part = replayed.last;
        counts.turns += replayed.turns;
        counts.written += replayed.written;
        counts.unsorted += replayed.unsorted;
        const state = part?.state ?? "partly";
        if (state === "done") counts.already += 1;
        else if (state === "finished") counts.finished += 1;
        else if (state === "none") counts.none += 1;
        else if (state === "would") {
          counts.would += 1;
          counts.left += part?.left ?? 0;
        } else {
          counts.partly += 1;
          unfinished = true;
        }
      } catch (error) {
        // Counted by a fixed code, never named: the workflow's log is public.
        const code = failureCode(error);
        fail(code);
        console.error(JSON.stringify({ event: "tex_threads_backfill_failed", code }));
      }
      if (Date.now() - began >= ACTION_BUDGET_MS) {
        unfinished = true;
        break;
      }
    }
    // A page not all finished is run again from where it started: its finished chats answer `done` at once.
    return unfinished ? { ...counts, cursor: cursor ?? "", done: false } : { ...counts, cursor: next.cursor, done: next.done };
  },
});
