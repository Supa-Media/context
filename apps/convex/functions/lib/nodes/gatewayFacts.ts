/**
 * `POST /gateway/tree/facts`: the Convex tree's facts (`lib/nodes/facts.ts`)
 * for the gateway, so a move's link rewrite and `orient`'s chaos score stop
 * asking the search database (decided by the owner, 2026-10-13).
 *
 * The same rules as `/gateway/tree/manifest` (`gatewayManifest.ts`): the
 * gateway secret gets the request in, the person's access token chooses the
 * workspace and the clearance, and every refusal is `{ served: false }`; a
 * reader whose workspace is not served yet is told `{ served: false }`.
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
 * - `ask: "props"` with `paths` (at most `PROPS_REQUEST_PATHS`): each note's
 *   props as its row keeps them (`props`, `sealed`, the `version` they were
 *   read at), for the notes the reader may see. A note whose text the facts
 *   have not read yet is absent. This is what `orient`'s folder descriptions,
 *   `evaluate_lists`, `list_meetings`, `list_channel_days` and
 *   `list_contacts` show in place of reading note bodies.
 * - `ask: "names"`: a write's "is this name taken?" and the note cap's count,
 *   unfiltered and so for a writer only (`gatewayNames.ts`).
 * - `ask: "jobs"`: which folder does each built-in job (`folderJobs.ts`), and
 *   the root's folder names, both only where this reader can see the folder.
 * - `ask: "forwarding"`: the forwarding ledger (`smallData.ledger`), oldest
 *   first, for this reader: an entry whose old path the reader may not see is
 *   left out, and one whose new path they may not see comes back with
 *   `to: null`, "moved out of sight", so a stale path they hold is never
 *   followed somewhere they cannot go and never named to them. A folder
 *   entry is judged by the folder rule a listing uses, a note's by `canSee`.
 *   The ledger lives in Convex since 2026-10-14; nothing reads the bucket's
 *   `.context/forwarding.json`, which is written from it.
 * - `ask: "neighbors"` with `path`: that note's links and backlinks, for
 *   `related_notes` (`neighbors.ts`), every one a note this reader may see.
 *   A seed they may not see answers exactly what an absent one does.
 *   `neighbors: null` until the facts have read every note once.
 *
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { loadPrivacyState } from "../fileOps";
import { json } from "../gatewayAuth";
import { canSee, isPlumbing } from "../privacy";
import { clearanceOf } from "../clearance";
import { folderVisibleAtScope } from "../fileOps/listing";
import { GATEWAY_PATH_LENGTH } from "./gatewayManifest";
import { MOVE_RENAMES_CAP, PROPS_AT_PATHS, dayOf } from "./facts";
import { NO_BUCKET, servedKeys, servedMoves, servedNodesStore } from "./manifestStore";
import { logicalPath as queuedLogicalPath } from "./movePaths";
import { namesFor } from "./gatewayNames";
import { resolveNeighbors } from "./neighbors";
import { isIndexableNote } from "../../../../mcp/src/search/indexable.js";

const NOT_SERVED = { served: false } as const;

/** What a request may ask for. */
const ASKS = new Set(["links", "chaos", "props", "forwarding", "jobs", "neighbors"]);

/** Notes one props request may name: one `propsAt` query's worth. */
export const PROPS_REQUEST_PATHS = PROPS_AT_PATHS;

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
  // A write's names and the cap's count, which only a writer may ask (`gatewayNames.ts`).
  if (body.ask === "names") return json(await namesFor(ctx, body));
  return json(await factsFor(ctx, body));
}

async function factsFor(ctx: ActionCtx, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const accessToken = typeof body.accessToken === "string" && body.accessToken !== "" ? body.accessToken : null;
  const expected = typeof body.expectedWorkspaceId === "string" ? body.expectedWorkspaceId : null;
  if (expected === null || !ASKS.has(body.ask as string)) return NOT_SERVED;
  if (accessToken === null) return NOT_SERVED;
  const sources = body.ask === "links" ? pathList(body.sources, MOVE_RENAMES_CAP) : [];
  const names = body.ask === "links" ? pathList(body.names, MOVE_RENAMES_CAP) : [];
  const paths = body.ask === "props" ? pathList(body.paths, PROPS_REQUEST_PATHS) : [];
  const seed = body.ask === "neighbors" ? pathList([body.path], 1)?.[0] : "";
  if (sources === null || names === null || paths === null || seed === undefined) return NOT_SERVED;
  try {
    const reader = await ctx.runQuery(internal.functions.nodesGateway.readClearance, {
      hashedAccessToken: await hashToken(accessToken),
      expectedWorkspaceId: expected,
    });
    if (reader === null) return NOT_SERVED;
    const served = await servedNodesStore(ctx, reader.workspaceId, NO_BUCKET, reader.audience);
    if (served === null) return NOT_SERVED;
    const state = await loadPrivacyState(served);
    if (state.invalid) return NOT_SERVED;
    // A pin reader's guest names (`lib/pinnedReaders.ts`); none for an ordinary connection.
    const clearance = clearanceOf(reader.scope, reader.names);
    const visible = (path: string) => canSee(path, reader.scope, state.rules, state.overrides, clearance.names);

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

    if (body.ask === "neighbors") {
      const rows = await ctx.runQuery(internal.functions.nodeFacts.neighbors, { workspaceId: reader.workspaceId, path: seed });
      if (rows === null) return { served: true, neighbors: null };
      // Link rows name the keys they were read at, and a queued move shows those notes elsewhere
      // already (`moveOverlay.ts`): every key at the name the tree shows now, as the map draws it.
      const queued = servedMoves(served);
      const logical = (path: string) => (queued.length === 0 ? path : queuedLogicalPath(path, queued));
      // Asked either way, so a hidden seed costs what a visible one does.
      const notes = new Set<string>();
      for (const key of await servedKeys(served)) {
        if (isIndexableNote(key) && !isPlumbing(key) && visible(key) && visible(logical(key))) notes.add(logical(key));
      }
      const moving = queued.length > 0;
      if (!notes.has(seed)) return { served: true, neighbors: { links: [], backlinks: [], complete: !moving } };
      const found = resolveNeighbors(
        seed,
        {
          links: rows.links.map((link) => (link.kind === "path" ? { ...link, target: logical(link.target) } : link)),
          byPath: rows.byPath.map(logical),
          byName: rows.byName.map(logical),
        },
        notes,
      );
      // Only the seed's own state and whether anything is moving, which this reader may see.
      return { served: true, neighbors: { ...found, complete: rows.present && rows.current && !moving } };
    }

    if (body.ask === "forwarding") {
      // A workspace whose ledger has not been imported yet starts that; it answers from what Convex holds.
      await ctx.runMutation(internal.functions.smallData.request, { workspaceId: reader.workspaceId }).catch(() => {});
      const ledger = await ctx.runQuery(internal.functions.smallData.ledger, { workspaceId: reader.workspaceId });
      const sees = (path: string, kind: "note" | "folder") =>
        kind === "folder" ? folderVisibleAtScope(path, clearance, state.rules, state.overrides) : visible(path);
      const forwarding = [];
      for (const entry of ledger) {
        if (!sees(entry.from, entry.kind)) continue;
        forwarding.push({ ...entry, to: sees(entry.to, entry.kind) ? entry.to : null });
      }
      return { served: true, forwarding };
    }

    if (body.ask === "jobs") {
      const sees = (path: string) => folderVisibleAtScope(path, clearance, state.rules, state.overrides);
      const found = await ctx.runQuery(internal.functions.nodesGateway.folderJobs, { workspaceId: reader.workspaceId });
      const jobs: Record<string, string | null> = {};
      for (const [job, path] of Object.entries(found.jobs)) jobs[job] = path !== null && sees(path) ? path : null;
      return { served: true, jobs, roots: found.roots.filter(sees) };
    }

    if (body.ask === "props") {
      // Filtered before the lookup, so a path the reader may not see is never read.
      const seen = [...new Set(paths)].filter(visible);
      const props = seen.length === 0 ? [] : await ctx.runQuery(internal.functions.nodeFacts.propsAt, { workspaceId: reader.workspaceId, paths: seen });
      return { served: true, props };
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
