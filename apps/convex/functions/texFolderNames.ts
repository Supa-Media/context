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
  return new Set(await ctx.runQuery(internal.functions.texFolderNamesRows.liveFiles, { workspaceId, paths }));
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
  handler: async (ctx, { dryRun, cursor, limit }) => {
    const page = await ctx.runQuery(internal.functions.texFolderNamesRows.personalPage, {
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
  returns: v.object({ chats: v.number(), homes: v.number(), ...countsValidator }),
  handler: async (ctx, { dryRun }) => {
    const found = await ctx.runQuery(internal.functions.texFolderNamesRows.homes, {});
    const totals = { chats: found.chats, homes: found.homes.length, wouldRename: 0, renamed: 0, both: 0, failed: {} as Record<string, number> };
    for (const home of found.homes) {
      try {
        const renames = homeRenames(home.folder, await hashToken(home.groupKey));
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
