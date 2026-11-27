/**
 * How the workspace's area routines ran, asked of the gateway's `POST /@slug/files/area-routines` with the console's
 * own grant, as the data sync is (`../../data/useSourceSync.ts`): the session's own workspace, named in the body. The
 * gateway reads the workspace object's `state` (`workspaceStore/areaRoutines.js`) and answers each routine's next and
 * last run and each bot's week, or `{served: false}`.
 *
 * `"loading"` until the first answer; null where it can't be asked (no workspace or slug, a demo, no gateway
 * address) or wasn't served, so the panel draws the rows without run lines rather than placeholders forever.
 */

import { useEffect, useState } from "react";
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

/** One ask: the state, or null when it can't be had. */
export async function askAreaRoutines(options: { url: string; workspaceId: string; token: (refresh: false | { rejected: string }) => Promise<string>; fetchImpl?: typeof fetch }): Promise<RoutineStateNow> {
  const answer = await postDataSync({ url: options.url, token: options.token, payload: { workspaceId: options.workspaceId }, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
  if (answer === null || answer.status !== 200) return null;
  return readRoutineState(answer.body);
}

/**
 * The state while `asking`, asked again when `again` changes (a routine added, moved or paused). Absent a gateway,
 * null at once.
 */
export function useAreaRoutineState(asking: boolean, again: string): RoutineStateNow {
  const data = useOptionalConsoleData();
  const current = data === null ? null : selectedContext(data);
  const mint = useConsoleGrant();
  const url = current === null || data?.demo === true ? null : areaRoutinesUrl(MCP_ENDPOINT, current.slug);
  const workspaceId = current?.id ?? null;
  const [state, setState] = useState<RoutineStateNow>(url === null ? null : "loading");
  useEffect(() => {
    if (!asking) return;
    if (url === null || workspaceId === null) {
      setState(null);
      return;
    }
    let live = true;
    void askAreaRoutines({
      url,
      workspaceId,
      token: async (refresh) => (await mint({ workspaceId: workspaceId as Id<"workspaces"> }, refresh)).accessToken,
    })
      .catch(() => null)
      .then((answer) => {
        if (live) setState(answer);
      });
    return () => {
      live = false;
    };
  }, [asking, again, url, workspaceId, mint]);
  return state;
}
