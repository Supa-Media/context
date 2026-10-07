import { api } from "@context/convex/_generated/api";

/**
 * THE MAP'S CONTROL-PLANE CALLS, IN ONE PLACE.
 *
 * The three functions the map reads, so that a renamed function is one line
 * here and the hooks never name `api` themselves. What each answer means, and
 * how it becomes the engine's shapes, is `convert.ts`'s.
 */

/** Every visible note of one workspace and the links between them (`files.workspaceGraph`). */
export const workspaceGraphRef = api.functions.files.workspaceGraph;

/** `activity.md`'s lines since `since` (epoch ms), each with its move pairs (`files.listActivity`). */
export const listActivityRef = api.functions.files.listActivity;

/** Notes moved between the caller's own workspaces in `[from, to]`, at most 31 days (`workspaceMoves.list`). */
export const workspaceMovesRef = api.functions.workspaceMoves.list;
