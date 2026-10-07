import { makeFunctionReference } from "convex/server";
import type { CrossMove, GraphAnswer, HistoryEntry } from "./convert";

/**
 * THE MAP'S CONTROL-PLANE CALLS, IN ONE PLACE.
 *
 * The three functions the map reads are being added to the control plane
 * beside this page (`files.workspaceGraph`, `files.listActivity`'s `since`, and
 * `workspaceMoves.list`), so they are named here by their string path rather
 * than through `api`, and typed by the shapes `convert.ts` reads. When they
 * land, these can become `api.functions.…` references with no change anywhere
 * else; if a name moves, this is the only file to touch.
 */

/** Every visible note of one workspace and the links between them. */
export const workspaceGraphRef = makeFunctionReference<"action", { workspaceId: string }, GraphAnswer>(
  "functions/files:workspaceGraph",
);

/** `activity.md`'s lines since `since` (epoch ms), newest first, each with its move pairs. */
export const listActivityRef = makeFunctionReference<
  "action",
  { workspaceId: string; since?: number; limit?: number },
  HistoryEntry[]
>("functions/files:listActivity");

/** Notes moved between the caller's own workspaces in `[from, to]`. */
export const workspaceMovesRef = makeFunctionReference<
  "action",
  { from: number; to: number },
  { moves: CrossMove[]; truncated: boolean }
>("functions/workspaceMoves:list");

