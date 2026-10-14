/**
 * `POST /gateway/tree/facts`: the Convex tree's facts (`lib/nodes/facts.ts`)
 * for the gateway, so a move's link rewrite and `orient`'s chaos score stop
 * asking the search database (decided by the owner, 2026-10-13).
 *
 * The same rules as `/gateway/tree/manifest` (`gatewayManifest.ts`): the
 * gateway secret gets the request in, the person's access token chooses the
 * workspace and the clearance, and every refusal is `{ served: false }`; a
 * reader whose workspace is still on its first copy is told
 * `{ served: false, loading: true }`.
 * Every path that comes back has passed `canSee` at that clearance, over the
 * tree's own rules mirror; the gateway filters again with its own engine.
 *
 * - `ask: "links"` with `sources` and `names`: the notes pointing at what a
 *   move renamed, and every note changed since its links were read
 *   (`nodeFacts.candidates`). `candidates: null` where the facts cannot be
 *   trusted for it, and the rewrite reads every note as before.
 * - `ask: "chaos"`: the long notes and contact reviews the score needs beyond
 *   the keys, and the score a week ago for this reader's audience. With
 *   `today` from an owner reading privately (the only reader whose keys
 *   count both audiences), today's score is kept too.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { NO_NAMES } from "../clearance";
import { hashToken } from "../crypto";
import { loadPrivacyState } from "../fileOps";
import { json } from "../gatewayAuth";
import { canSee } from "../privacy";
import { GATEWAY_PATH_LENGTH, NO_BUCKET, STILL_LOADING } from "./gatewayManifest";
import { readinessAndKick } from "./treeLoading";
import { MOVE_RENAMES_CAP, dayOf } from "./facts";
import { servedNodesStore } from "./manifestStore";

const NOT_SERVED = { served: false } as const;

/** A list of paths no longer than `cap`, each one path; `null` for anything else. */
function pathList(value: unknown, cap: number): string[] | null {
  if (!Array.isArray(value) || value.length > cap) return null;
  if (!value.every((entry) => typeof entry === "string" && entry !== "" && entry.length <= GATEWAY_PATH_LENGTH)) return null;
  return value as string[];
}

function totals(value: unknown): { all: number; team: number } | null {
  if (value === null || typeof value !== "object") return null;
  const { all, team } = value as Record<string, unknown>;
  if (typeof all !== "number" || typeof team !== "number" || !Number.isFinite(all) || !Number.isFinite(team)) return null;
  if (all < 0 || all > 100 || team < 0 || team > 100) return null;
  return { all, team };
}

export async function gatewayTreeFactsHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  return json(await factsFor(ctx, body));
}

async function factsFor(ctx: ActionCtx, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const accessToken = typeof body.accessToken === "string" && body.accessToken !== "" ? body.accessToken : null;
  const expected = typeof body.expectedWorkspaceId === "string" ? body.expectedWorkspaceId : null;
  if (accessToken === null || expected === null || (body.ask !== "links" && body.ask !== "chaos")) return NOT_SERVED;
  const sources = body.ask === "links" ? pathList(body.sources, MOVE_RENAMES_CAP) : [];
  const names = body.ask === "links" ? pathList(body.names, MOVE_RENAMES_CAP) : [];
  if (sources === null || names === null) return NOT_SERVED;
  try {
    const reader = await ctx.runQuery(internal.functions.nodesGateway.readClearance, {
      hashedAccessToken: await hashToken(accessToken),
      expectedWorkspaceId: expected,
    });
    if (reader === null) return NOT_SERVED;
    const served = await servedNodesStore(ctx, reader.workspaceId, NO_BUCKET);
    // Still on its first copy (now started): said so to this reader, never answered from the bucket.
    if (served === null) return (await readinessAndKick(ctx, reader.workspaceId)) === "loading" ? STILL_LOADING : NOT_SERVED;
    const state = await loadPrivacyState(served);
    if (state.invalid) return NOT_SERVED;
    const visible = (path: string) => canSee(path, reader.scope, state.rules, state.overrides, NO_NAMES);

    if (body.ask === "links") {
      const found = await ctx.runQuery(internal.functions.nodeFacts.candidates, {
        workspaceId: reader.workspaceId,
        sources,
        names,
      });
      if (found === null) return { served: true, candidates: null };
      return {
        served: true,
        candidates: { pointing: found.pointing.filter(visible), unparsed: found.unparsed.filter(visible) },
      };
    }

    const extras = await ctx.runQuery(internal.functions.nodeChaos.extras, { workspaceId: reader.workspaceId });
    if (extras === null) return { served: true, chaos: null };
    const now = Date.now();
    const history = await ctx.runQuery(internal.functions.nodeChaos.history, { workspaceId: reader.workspaceId, daysAgo: 7, now });
    const today = reader.scope === "private" ? totals(body.today) : null;
    if (today !== null) {
      await ctx
        .runMutation(internal.functions.nodeChaos.recordDay, { workspaceId: reader.workspaceId, today: { day: dayOf(now), ...today } })
        .catch(() => {});
    }
    return {
      served: true,
      chaos: {
        extras: extras.filter((extra) => visible(extra.path)),
        weekAgo: history.then === null ? null : history.then[reader.scope === "private" ? "all" : "team"],
      },
    };
  } catch {
    return NOT_SERVED;
  }
}
