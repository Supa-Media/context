/**
 * How the workspace's area routines ran, asked of the gateway's `POST /@slug/files/area-routines` with the console's
 * own grant, as the data sync is (`../../data/useSourceSync.ts`): the session's own workspace, named in the body. The
 * gateway reads the workspace object's `state` (`workspaceStore/areaRoutines.js`) and answers each routine's next and
 * last run and each bot's week, or `{served: false}`.
 *
 * `"loading"` until the first answer; null where it can't be asked (no workspace or slug, a demo, no gateway
 * address) or wasn't served, so the panel draws the rows without run lines rather than placeholders forever.
 */

import { useCallback, useEffect, useState } from "react";
import type { Id } from "@context/convex/_generated/dataModel";
import { useConsoleGrant } from "../../../../agent/useConsoleGrant";
import { useOptionalConsoleData } from "../../../ConsoleDataContext";
import { MCP_ENDPOINT } from "../../../placeholderData";
import { selectedContext } from "../../../types";
import { postDataSync } from "../../data/dataSync";
import { readRoutineState, type RoutineStateNow } from "./areaRoutines";

export const AREA_ROUTINES_PATH = "/files/area-routines";
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** `POST /@slug/files/area-routines` on the gateway that serves `mcpEndpoint`, or null. */
export function areaRoutinesUrl(mcpEndpoint: string, slug: string | null | undefined): string | null {
  if (typeof slug !== "string" || !SLUG.test(slug)) return null;
  let parsed: URL;
  try {
    parsed = new URL(mcpEndpoint);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return `${parsed.origin}/@${slug}${AREA_ROUTINES_PATH}`;
}

type Token = (refresh: false | { rejected: string }) => Promise<string>;

/** One ask: the state, or null when it can't be had. */
export async function askAreaRoutines(options: { url: string; workspaceId: string; token: Token; fetchImpl?: typeof fetch }): Promise<RoutineStateNow> {
  const answer = await postDataSync({ url: options.url, token: options.token, payload: { workspaceId: options.workspaceId }, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
  if (answer === null || answer.status !== 200) return null;
  return readRoutineState(answer.body);
}

/** What Run now came back with: the state after it, or why it didn't run. */
export type RunAnswer = { state: RoutineStateNow } | { problem: string };

/**
 * Run now: the gateway sends one routine to its bot out of turn, as its clock would (its bot, its card's list and
 * the area's share, so a spent cap holds it), and answers the state after. The outcome shows on the row's last run.
 */
export async function runAreaRoutine(options: { url: string; workspaceId: string; path: string; token: Token; fetchImpl?: typeof fetch }): Promise<RunAnswer> {
  const answer = await postDataSync({ url: options.url, token: options.token, payload: { workspaceId: options.workspaceId, run: options.path }, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
  if (answer === null) return { problem: "Context couldn't be reached. Try again." };
  if (answer.status === 403) return { problem: "Only an editor or owner can run a routine now." };
  if (answer.status !== 200) return { problem: "The routine couldn't be run. Try again." };
  const state = readRoutineState(answer.body);
  if (state === null) return { problem: "Routines can't run from here yet." };
  if (answer.body?.ran === null) return { problem: "That routine isn't scheduled, so it can't run now." };
  if (answer.body?.ran === "recent") return { problem: "It was just sent. Give it a minute before running it again." };
  return { state };
}

/**
 * The state while `asking`, asked again when `again` changes (a routine added, moved or paused). Absent a gateway,
 * null at once. `run` is Run now, absent where there is no gateway to ask.
 */
export function useAreaRoutineState(asking: boolean, again: string): { state: RoutineStateNow; run?: (path: string) => Promise<string | null> } {
  const data = useOptionalConsoleData();
  const current = data === null ? null : selectedContext(data);
  const mint = useConsoleGrant();
  const url = current === null || data?.demo === true ? null : areaRoutinesUrl(MCP_ENDPOINT, current.slug);
  const workspaceId = current?.id ?? null;
  const [state, setState] = useState<RoutineStateNow>(url === null ? null : "loading");
  const token = useCallback(
    async (refresh: false | { rejected: string }) => (await mint({ workspaceId: workspaceId as Id<"workspaces"> }, refresh)).accessToken,
    [mint, workspaceId],
  );
  useEffect(() => {
    if (!asking) return;
    if (url === null || workspaceId === null) {
      setState(null);
      return;
    }
    let live = true;
    void askAreaRoutines({ url, workspaceId, token })
      .catch(() => null)
      .then((answer) => {
        if (live) setState(answer);
      });
    return () => {
      live = false;
    };
  }, [asking, again, url, workspaceId, token]);
  const run = useCallback(
    async (path: string): Promise<string | null> => {
      if (url === null || workspaceId === null) return "Routines can't run from here.";
      const answer = await runAreaRoutine({ url, workspaceId, path, token }).catch((): RunAnswer => ({ problem: "The routine couldn't be run. Try again." }));
      if ("problem" in answer) return answer.problem;
      setState(answer.state);
      return null;
    },
    [url, workspaceId, token],
  );
  return url === null || workspaceId === null ? { state } : { state, run };
}
