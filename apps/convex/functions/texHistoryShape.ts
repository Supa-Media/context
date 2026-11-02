/**
 * The shape of each person's one-to-one Tex history record around a window of time (2026-11-02): which turns it
 * holds, by kind and minute, never their words. A person said "yes please" to a check-in and Tex answered that it
 * had no open question, so this says whether the check-in reached the record the turn read, and in what order.
 *
 * Read only. It answers fixed codes, minutes from the window's start and counts, never an id, a name or a word: it
 * is run from the `Tex history shape` workflow, whose log is public. A workspace is told apart by the first six
 * characters of its id's hash.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction } from "../_generated/server";
import { hashToken } from "./lib/crypto";
import { consoleTexBuckets } from "./lib/texStore";

/** Where the record is kept in the person's object (`apps/mcp/src/store/texRouting.js`, `isAgentHomeKey`). */
const RECORD = "state/agent/history/texts.json";

type Turn = { role?: unknown; text?: unknown; at?: unknown; thread?: unknown; theirs?: unknown; tainted?: unknown; id?: unknown };

/** What a kept question was, as a code: the gateway's own fixed lines name a check-in, a routine and the rest. */
function kindOf(turn: Turn): string {
  if (turn.role === "assistant") return "answer";
  const text = typeof turn.text === "string" ? turn.text : "";
  if (!text.startsWith("(Not a text from them.")) return "texted";
  if (text.includes("check-in")) return "check_in";
  if (text.includes("routine")) return "routine";
  if (text.includes("no model")) return "told";
  if (text.includes("attention") || text.includes("ping")) return "attention";
  if (text.includes("job") || text.includes("task")) return "job";
  return "not_theirs_other";
}

export const shape = internalAction({
  args: { from: v.string(), to: v.string() },
  returns: v.any(),
  handler: async (ctx, { from, to }): Promise<unknown> => {
    const start = Date.parse(from);
    const end = Date.parse(to);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { error: "bad_window" };
    const out: unknown[] = [];
    let cursor: string | undefined;
    let looked = 0;
    for (;;) {
      const page: { workspaceIds: Id<"workspaces">[]; cursor: string; done: boolean } = await ctx.runQuery(internal.functions.texFolderNamesRows.personalPage, { cursor, limit: 25 });
      for (const workspaceId of page.workspaceIds) {
        looked += 1;
        const buckets = consoleTexBuckets(ctx, workspaceId);
        if (buckets === null) return { error: "no_door" };
        let parsed: { turns?: Turn[]; moved?: unknown } | null = null;
        try {
          const held = await buckets(`person:${workspaceId}`).get(RECORD);
          if (held === null) continue;
          parsed = JSON.parse(await held.text()) as { turns?: Turn[]; moved?: unknown };
        } catch {
          out.push({ ws: (await hashToken(workspaceId)).slice(0, 6), error: "unreadable" });
          continue;
        }
        const turns = Array.isArray(parsed?.turns) ? parsed.turns : [];
        let at: number | null = null;
        const shown: unknown[] = [];
        turns.forEach((turn, index) => {
          if (typeof turn.at === "number") at = turn.at;
          if (at === null || at < start || at > end) return;
          shown.push({
            i: index,
            min: Math.round((at - start) / 60_000),
            kind: kindOf(turn),
            ...(turn.thread ? { thread: true } : {}),
            ...(turn.theirs === true ? { theirs: true } : {}),
            ...(turn.tainted === true ? { tainted: true } : {}),
            ...(typeof turn.text === "string" && turn.role === "user" && turn.text.length <= 12 ? { short: true } : {}),
          });
        });
        if (shown.length === 0) continue;
        out.push({
          ws: (await hashToken(workspaceId)).slice(0, 6),
          turns: turns.length,
          ...(typeof parsed?.moved === "number" ? { movedMin: Math.round((parsed.moved - start) / 60_000) } : {}),
          shown,
        });
      }
      if (page.done) break;
      cursor = page.cursor;
    }
    return { looked, records: out };
  },
});
