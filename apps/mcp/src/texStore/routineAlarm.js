/**
 * Keeping a routine's alarm on its owner's Tex store, as the routine's file is
 * written or removed (`activity/record.js` calls this after a write; the control
 * plane's scan stays the source of truth, and the cron is the backstop).
 *
 * The time comes from the routine's own file, read with the same module the
 * control plane reads its schedule with (`packages/shared/src/routines.cjs`),
 * in the zone the file names or the routines' default. The control plane may
 * know the account's zone and this may not: then the alarm fires, the control
 * plane finds nothing due, and the cron runs the routine on its own clock.
 *
 * Never throws. A write is not failed by its alarm: a failure is logged and the
 * cron, which runs every routine every minute, is what catches it.
 */

import { nextRunAt, routineFromPath, routineSettings, TEX_ROUTINES_FOLDER } from "../../../../packages/shared/src/routines.cjs";
import { DEFAULT_TIME_ZONE } from "../agent/localNow.js";
import { ownerName, texStoreStub, texTimers } from "./wire.js";

/**
 * When the routine at `path`, written as `text`, next runs after `now`; `null`
 * for a paused routine, one that will not run as written, and a path that is
 * no routine.
 */
export function routineAlarmAt(path, text, now, fallbackZone = DEFAULT_TIME_ZONE) {
  if (typeof text !== "string") return null;
  const routine = routineFromPath(path);
  if (routine?.kind !== "routine") return null;
  const { settings, problems } = routineSettings(text, routine.cadence);
  if (problems.length > 0 || settings.paused) return null;
  return nextRunAt(routine.cadence, settings, settings.timeZone ?? fallbackZone, now);
}

/**
 * Sets or cancels the alarm of each routine path under `tex/routines/` in the
 * person's workspace, by what its file now says. `store` reads the files; the
 * env binds the Tex store. Other paths are not Tex's routines and are skipped.
 *
 * @param {object} env the Worker's bindings (`TEX_STORE`)
 * @param {string} workspaceId the person's personal workspace
 * @param {{get(path: string): Promise<{text(): Promise<string>} | null>}} store
 * @param {string[]} paths the paths a write just touched
 * @param {number} [now]
 */
export async function syncRoutineAlarms(env, workspaceId, store, paths, now = Date.now()) {
  const mine = (Array.isArray(paths) ? paths : []).filter((path) => typeof path === "string" && path.startsWith(TEX_ROUTINES_FOLDER));
  if (mine.length === 0) return;
  let timers;
  try {
    const stub = texStoreStub(env, { person: workspaceId });
    if (stub === null) return;
    timers = texTimers(stub);
  } catch {
    return;
  }
  const owner = ownerName({ person: workspaceId });
  for (const path of mine) {
    try {
      const object = await store.get(path);
      const at = object === null || object === undefined ? null : routineAlarmAt(path, await object.text(), now);
      if (at === null) await timers.cancel(path);
      else await timers.schedule({ id: path, at, payload: { owner } });
    } catch {
      console.log(JSON.stringify({ event: "tex_routine_alarm", outcome: "failed", workspace: workspaceId }));
    }
  }
}
