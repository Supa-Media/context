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
        return answer?.served === true ? { week: answer.week, routines: answer.routines ?? [], usage: answer.usage ?? [], checks: answer.checks ?? [], inbox: answer.inbox ?? [] } : null;
      } catch (error) {
        log("workspace_object_bots_failed", { workspaceId, error: error?.name ?? "Error" });
        return null;
      }
    },
    /** A bot's check-in (`workspaceStore/botInbox.js`): `{items}` it may read, or null where unserved. */
    async check(bot) {
      if (typeof client.botsCheck !== "function") return null;
      try {
        const answer = await client.botsCheck({ ...judged, bot });
        if (answer?.served !== true) return null;
        const previousAt = typeof answer.previousAt === "number" && Number.isFinite(answer.previousAt) ? answer.previousAt : null;
        return { items: Array.isArray(answer.items) ? answer.items : [], previousAt };
      } catch (error) {
        log("workspace_object_bots_failed", { workspaceId, error: error?.name ?? "Error" });
        return null;
      }
    },
    /** One routine sent now: its outcome, null for no routine this reader sees, or undefined where unserved. */
    async runNow(path) {
      if (typeof client.botsRunNow !== "function") return undefined;
      try {
        const answer = await client.botsRunNow({ ...judged, path });
        return answer?.served === true ? (answer.outcome ?? null) : undefined;
      } catch (error) {
        log("workspace_object_bots_failed", { workspaceId, error: error?.name ?? "Error" });
        return undefined;
      }
    },
  };
}
