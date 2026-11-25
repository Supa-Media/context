/**
 * An area's routines and its bots' week, asked of the workspace object that keeps them (`workspaceStore/areaRoutines.js`),
 * for a session that reads that object (`objectReader`). `null` where it does not; `state()` answers `null` where the
 * object did not serve it, and a reader then says nothing about runs or budgets rather than guessing.
 */
import { objectReader } from "./objectLookup.js";

/**
 * @param {Parameters<typeof objectReader>[0]} options
 * @returns {{state: () => Promise<{week: string, routines: object[], usage: object[]}|null>} | null}
 */
export function objectFirstBots(options) {
  const reader = objectReader(options);
  if (reader === null || typeof reader.client?.botsState !== "function") return null;
  const { client, judged, log, workspaceId } = reader;
  return {
    async state() {
      try {
        const answer = await client.botsState({ ...judged });
        return answer?.served === true ? { week: answer.week, routines: answer.routines ?? [], usage: answer.usage ?? [] } : null;
      } catch (error) {
        log("workspace_object_bots_failed", { workspaceId, error: error?.name ?? "Error" });
        return null;
      }
    },
  };
}
