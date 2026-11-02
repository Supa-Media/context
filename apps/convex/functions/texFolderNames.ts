/**
 * The one-time rename that gives a person's Tex folder and a group chat's home the same names (decided by the owner,
 * 2026-11-01: "1:1 tex folders and group tex folders ... i would like them to mirror";
 * `docs/decisions/texting-assistant/tex-folders.md`).
 *
 *  - `personal`: in each personal workspace, `tex/about-me.md` becomes `tex/about.md`.
 *  - `homes`: in each chat's home, `about-us.md` becomes `about.md`, `voice-<id>.md` becomes `voice.md` and
 *    `chat-<id>.md` (the history page) becomes `history.md`, `<id>` being the chat's key as the gateway hashed it.
 *
 * Each rename is a row move (`nodesMoveStart`, `nodesMoveBatch` for a home's notes, made whole or not at all), so a
 * note keeps its key, its text and its history, and the gateway's reads by key are the same note after it. A name
 * already taken is never moved onto: both are counted (`both`) and left as they are, for a person to look at. Nothing
 * is deleted. Until this has run everywhere, the gateway reads a note under its old name when the new one has nothing
 * (`apps/mcp/src/agent/homeNames.js`, `aboutMe.js`).
 *
 * Run from the `Tex folder names` workflow, `dryRun` first. Internal only, so only the workflow's deploy key starts
 * them. The answers are counts and fixed codes, never a workspace, a path or a key: the workflow's log is public.
 * Running it again renames nothing already renamed.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, type ActionCtx } from "../_generated/server";
import type { OperationResult } from "./lib/filesFns/operationTypes";
import { hashToken } from "./lib/crypto";
import { READS_AS_CHAT_NAME } from "./lib/nodes/chatFolders";
import { consoleTexBuckets } from "./lib/texStore";

export type Rename = { from: string; to: string };

/** Person's note about them, before and after. */
export const PERSONAL_RENAMES: readonly Rename[] = [{ from: "tex/about-me.md", to: "tex/about.md" }];

/** A home's notes, before and after, for the chat whose key hashes to `keyHash` (`apps/mcp/src/agent/homeNames.js`). */
export function homeRenames(folder: string, keyHash: string): Rename[] {
  const id = keyHash.slice(0, 12);
  return [
    { from: `${folder}/about-us.md`, to: `${folder}/about.md` },
    { from: `${folder}/voice-${id}.md`, to: `${folder}/voice.md` },
    { from: `${folder}/chat-${id}.md`, to: `${folder}/history.md` },
  ];
}

/** Which renames to make, given the live paths: the old name there and the new one free. Both there is `both`. */
export function planRenames(renames: readonly Rename[], live: ReadonlySet<string>): { moves: Rename[]; both: number } {
  const moves = renames.filter((rename) => live.has(rename.from) && !live.has(rename.to));
  return { moves, both: renames.filter((rename) => live.has(rename.from) && live.has(rename.to)).length };
}

const count = (counts: Record<string, number>, code: string) => {
  counts[code] = (counts[code] ?? 0) + 1;
};

/** A refusal's fixed code, never its message. */
function refusalCode(result: OperationResult): string | null {
  if (result.kind === "moveQueued") return result.queued ? null : `refused_${result.error ?? "not_queued"}`;
  if (result.kind === "moveBatch") return result.ok ? null : `refused_${result.error ?? "batch"}`;
  return "refused_unexpected";
}

async function liveOf(ctx: ActionCtx, workspaceId: Id<"workspaces">, renames: readonly Rename[]): Promise<Set<string>> {
  const paths = [...new Set(renames.flatMap((rename) => [rename.from, rename.to]))];
  const live: string[] = await ctx.runQuery(internal.functions.texFolderNamesRows.liveFiles, { workspaceId, paths });
  return new Set(live);
}

type Counts = { wouldRename: number; renamed: number; both: number; failed: Record<string, number> };
type PersonalCounts = Counts & { workspaces: number; personal: number; cursor: string; done: boolean };
type HomeCounts = Counts & { chats: number; homes: number; shapes: Record<string, number> };

/**
 * What kind of note a file in a home is, as a fixed code a public log may carry: one of the chat's own (old or new
 * name, by this chat's key or not), or anything else.
 */
export function homeFileShape(name: string, keyHash: string): string {
  const id = keyHash.slice(0, 12);
  if (["history.md", "voice.md", "about.md", "about-us.md"].includes(name)) return name.replace(".md", "").replace("-", "_");
  const old = /^(chat|voice)-([0-9a-f]{12,16})\.md$/.exec(name);
  if (old !== null) return `${old[1]}_${old[2] === id ? "key" : "other"}`;
  return "other";
}

const countsValidator = {
  wouldRename: v.number(),
  renamed: v.number(),
  both: v.number(),
  failed: v.record(v.string(), v.number()),
};

export const personal = internalAction({
  args: { dryRun: v.boolean(), cursor: v.optional(v.string()), limit: v.optional(v.number()) },
  returns: v.object({ workspaces: v.number(), personal: v.number(), ...countsValidator, cursor: v.string(), done: v.boolean() }),
  handler: async (ctx, { dryRun, cursor, limit }): Promise<PersonalCounts> => {
    const page: { workspaceIds: Id<"workspaces">[]; seen: number; cursor: string; done: boolean } = await ctx.runQuery(internal.functions.texFolderNamesRows.personalPage, {
      ...(cursor === undefined ? {} : { cursor }),
      ...(limit === undefined ? {} : { limit }),
    });
    const totals = { workspaces: page.seen, personal: page.workspaceIds.length, wouldRename: 0, renamed: 0, both: 0, failed: {} as Record<string, number> };
    for (const workspaceId of page.workspaceIds) {
      try {
        const { moves, both } = planRenames(PERSONAL_RENAMES, await liveOf(ctx, workspaceId, PERSONAL_RENAMES));
        totals.both += both;
        totals.wouldRename += moves.length;
        if (dryRun) continue;
        for (const { from, to } of moves) {
          const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
            workspaceId,
            scope: "private",
            grantedNames: [],
            operation: { kind: "nodesMoveStart", from, to },
          })) as OperationResult;
          const refused = refusalCode(result);
          if (refused === null) totals.renamed += 1;
          else count(totals.failed, refused);
        }
      } catch {
        count(totals.failed, "FAILED");
      }
    }
    return { ...totals, cursor: page.cursor, done: page.done };
  },
});

export const homes = internalAction({
  args: { dryRun: v.boolean() },
  returns: v.object({ chats: v.number(), homes: v.number(), shapes: v.record(v.string(), v.number()), ...countsValidator }),
  handler: async (ctx, { dryRun }): Promise<HomeCounts> => {
    const found: { chats: number; homes: { groupKey: string; workspaceId: Id<"workspaces">; folder: string; noteId: string; lastSeenAt: number }[] } = await ctx.runQuery(internal.functions.texFolderNamesRows.homes, {});
    const totals = { chats: found.chats, homes: found.homes.length, wouldRename: 0, renamed: 0, both: 0, failed: {} as Record<string, number>, shapes: {} as Record<string, number> };
    for (const home of found.homes) {
      try {
        const keyHash = await hashToken(home.groupKey);
        const names: string[] = await ctx.runQuery(internal.functions.texFolderNamesRows.homeFiles, { workspaceId: home.workspaceId, folder: home.folder });
        for (const name of names) count(totals.shapes, homeFileShape(name, keyHash));
        const renames = homeRenames(home.folder, keyHash);
        const { moves, both } = planRenames(renames, await liveOf(ctx, home.workspaceId, renames));
        totals.both += both;
        totals.wouldRename += moves.length;
        if (dryRun || moves.length === 0) continue;
        // Read and changed as the chat's own turn does: through its row token, to edit, read as a chat (`liveGrants.ts`).
        const token = `#${home.noteId}`;
        const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
          workspaceId: home.workspaceId,
          scope: "team",
          grantedNames: [READS_AS_CHAT_NAME, token, `${token}!edit`],
          operation: { kind: "nodesMoveBatch", moves },
        })) as OperationResult;
        const refused = refusalCode(result);
        if (refused === null) totals.renamed += moves.length;
        else count(totals.failed, refused);
      } catch {
        count(totals.failed, "FAILED");
      }
    }
    return totals;
  },
});

/** The record's one name in its chat's object: sha256 of "memory" (`apps/mcp/src/agent/chatMemoryRecord.js`). */
async function chatRecord(ctx: ActionCtx, pin: Id<"workspaces">, groupKey: string): Promise<Record<string, unknown> | null> {
  const owner = `chat:${groupKey}`;
  const buckets = consoleTexBuckets(ctx, pin, { ticketOwners: [owner] });
  if (buckets === null) return null;
  const held = await buckets(owner).get(`state/${await hashToken("memory")}.json`);
  if (held === null) return null;
  const record = JSON.parse(await held.text()) as unknown;
  return record !== null && typeof record === "object" && !Array.isArray(record) ? (record as Record<string, unknown>) : null;
}

/** When turns began moving a home's history onto its page (#2569 live in production, 2026-11-01). */
export const ON_PAGE_SINCE = Date.parse("2026-11-01T14:30:00Z");

/**
 * Where each homed chat's history page is, by the key its record keeps for it (`direct.memory`), as fixed codes: the
 * record (`no_record`, `on_page` or not), the key (`no_key`), and the row that key's note id names (`no_row`, or the
 * shape of its name, `homeFileShape`), whether a record off its page has carried the old notes in, and whether the chat
 * has spoken since turns began moving history onto pages. Read only; reads each chat's record from its object.
 */
export const pages = internalAction({
  args: {},
  returns: v.object({ homes: v.number(), codes: v.record(v.string(), v.number()), chats: v.record(v.string(), v.number()) }),
  handler: async (ctx): Promise<{ homes: number; codes: Record<string, number>; chats: Record<string, number> }> => {
    const found: { homes: { groupKey: string; workspaceId: Id<"workspaces">; folder: string; noteId: string; lastSeenAt: number }[] } = await ctx.runQuery(internal.functions.texFolderNamesRows.homes, {});
    const codes: Record<string, number> = {};
    // Each chat's codes joined, so two codes can be told to belong to one chat (`seen+not_carried`).
    const chats: Record<string, number> = {};
    for (const home of found.homes) {
      const own: string[] = [];
      const note = (code: string) => {
        own.push(code);
        count(codes, code);
      };
      // Whether the chat has spoken since a turn could move its history onto its page (`ON_PAGE_SINCE`).
      note(home.lastSeenAt >= ON_PAGE_SINCE ? "seen_since_page_move" : "not_seen_since_page_move");
      try {
        const record = await chatRecord(ctx, home.workspaceId, home.groupKey);
        if (record === null) {
          note("no_record");
          count(chats, own.join("+"));
          continue;
        }
        if (record.onPage !== 1) note(record.carried === 1 ? "carried" : "not_carried");
        // Why the last turn's page write was refused, as the gateway coded it (`groupMemoryNote.js` `reasonCode`).
        if (typeof record.pageRefused === "string") note(/^[a-z][a-z0-9_]{0,39}$/.test(record.pageRefused) ? `refused_${record.pageRefused}` : "refused_other");
        note(record.onPage === 1 ? "on_page" : "not_on_page");
        if (Array.isArray(record.turns)) note(`record_turns_${record.turns.length > 0 ? "some" : "none"}`);
        const key = (record.direct as { memory?: unknown } | undefined)?.memory;
        const id = typeof key === "string" ? /(?:^|\/)notes\/([^/]+)\.md$/.exec(key)?.[1] : undefined;
        if (id === undefined) {
          note("no_key");
          count(chats, own.join("+"));
          continue;
        }
        const path: string | null = await ctx.runQuery(internal.functions.texFolderNamesRows.rowOfNote, { workspaceId: home.workspaceId, noteId: id });
        if (path === null) note("no_row");
        else if (!path.startsWith(`${home.folder}/`)) note("row_elsewhere");
        else note(`row_${homeFileShape(path.slice(home.folder.length + 1), await hashToken(home.groupKey))}`);
      } catch {
        note("FAILED");
      }
      count(chats, own.join("+"));
    }
    return { homes: found.homes.length, codes, chats };
  },
});
