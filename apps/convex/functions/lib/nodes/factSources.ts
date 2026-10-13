/**
 * The Convex facts (`lib/nodes/facts.ts`) as the sources a List and the chaos
 * score read, in place of the search database's `tree_props` and
 * `chaos_daily` (decided by the owner, 2026-10-13). Each answers only once
 * the facts have read every note; until then the caller reads the search
 * database as before.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { chaosDays } from "../../../../mcp/src/chaos/table.js";
import type { ChaosSource } from "../filesFns/chaosOps";
import type { PropSource } from "../filesFns/folderNotes";
import type { ProjectionClient } from "../fileOps";
import { CHAOS_DAYS, PROPS_AT_PATHS, dayOf } from "./facts";

type Ctx = Pick<ActionCtx, "runQuery" | "runMutation">;

/** Whether the facts have read every note once. */
export async function factsReady(ctx: Ctx, workspaceId: Id<"workspaces">): Promise<boolean> {
  return await ctx.runQuery(internal.functions.nodeFacts.ready, { workspaceId }).catch(() => false);
}

/** Each note's props from its own row. A stale row's re-read is kept by the fill, not here. */
export function factPropSource(ctx: Ctx, workspaceId: Id<"workspaces">): PropSource {
  return {
    rows: async (paths) => {
      const found = new Map<string, { version: string | null; encrypted: boolean; props: string | null }>();
      for (let at = 0; at < paths.length; at += PROPS_AT_PATHS) {
        const rows = await ctx.runQuery(internal.functions.nodeFacts.propsAt, {
          workspaceId,
          paths: paths.slice(at, at + PROPS_AT_PATHS),
        });
        for (const row of rows) found.set(row.path, { version: row.version, encrypted: row.sealed, props: row.props });
      }
      return found;
    },
  };
}

/**
 * The chaos score's extras and history from Convex. The first day it records,
 * the search database's days (`client`, where there is one) are carried over,
 * so "a week ago" does not go blank for a week.
 */
export function factChaosSource(ctx: Ctx, workspaceId: Id<"workspaces">, client: ProjectionClient | null): ChaosSource {
  let recorded: number | null = null;
  return {
    extras: async () => {
      const rows = await ctx.runQuery(internal.functions.nodeChaos.extras, { workspaceId });
      if (rows === null) return null;
      return new Map(rows.map(({ path, ...extra }) => [path, extra]));
    },
    weekAgo: async (audience) => {
      const history = await ctx.runQuery(internal.functions.nodeChaos.history, { workspaceId, daysAgo: 7, now: Date.now() });
      recorded = history.recorded;
      return history.then === null ? null : history.then[audience];
    },
    record: async (totals) => {
      const seed = recorded === 0 && client !== null ? (await chaosDays(client)).slice(-CHAOS_DAYS) : [];
      await ctx.runMutation(internal.functions.nodeChaos.recordDay, {
        workspaceId,
        today: { day: dayOf(Date.now()), ...totals },
        ...(seed.length === 0 ? {} : { seed }),
      });
    },
  };
}
