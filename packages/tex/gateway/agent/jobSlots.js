/**
 * A CHAT'S JOB SLOTS: THREE IN THE CLOUD, AND EACH COMPUTER'S OWN
 * (docs/decisions/texting-assistant/machines.md, "A slot is compute, not a
 * tool"; Dev, 2026-11-04: "count machine slots separately from the 3 cloud
 * slots").
 *
 * A job on one of their computers used to take one of the chat's three cloud
 * slots, so two running there left one for everything else, and a computer
 * with eight slots never ran more than three. Now a cloud job counts against
 * the chat's three, and a job on a computer counts against that computer's
 * own slots (its owner's count, at most `MAX_MACHINE_SLOTS`). The workspace
 * object still refuses an assignment that would overfill a computer two chats
 * share (`admit`, "busy"): this is the chat's own check before it starts one.
 */

import { configLimits } from "../../../shared/src/jobPartEnd.cjs";
import { configStartLimits } from "../../../shared/src/jobStart.cjs";
import { TEX_CONFIG } from "./texConfig.js";

/** Cloud jobs at once in a chat: the Job start node's config (`jobStart.cjs`; `packages/tex/worker/jobs.ts` holds the same). */
export const MAX_CLOUD_JOBS = configStartLimits(TEX_CONFIG).cloudSlots;
/** Parts one job may take, the first included, before it reports what it has: its Part end node's config (`jobPartEnd.cjs`). */
export const MAX_JOB_ATTEMPTS = configLimits(TEX_CONFIG).parts;
/** The most slots one computer can have: the Job start node's config (`slotCounts`, `workspaceStore/machines.js`). */
export const MAX_MACHINE_SLOTS = configStartLimits(TEX_CONFIG).machineSlots;

/** The computer a running entry or a started job is on: its machine id, or null in the cloud. */
export function machineOf(entry) {
  if (typeof entry?.on === "string" && entry.on !== "") return entry.on;
  if (typeof entry?.machine?.machineId === "string") return entry.machine.machineId;
  return null;
}

/** A computer's own slots: its owner's count, one when it names none, never over the most. */
export function slotsOf(computer) {
  const slots = computer?.slots;
  return Number.isSafeInteger(slots) && slots > 0 ? Math.min(slots, MAX_MACHINE_SLOTS) : 1;
}

/**
 * The chat's slots, counted from what is running and what this turn started or
 * picked back up. `jobs()` returns every live job: the running entries, the
 * started ones and the resumed ones.
 */
export function jobSlots(jobs) {
  const live = () => jobs();
  const cloudBusy = () => live().filter((entry) => machineOf(entry) === null).length;
  const busyOn = (machineId) => live().filter((entry) => machineOf(entry) === machineId).length;
  return {
    cloudFree: () => Math.max(0, MAX_CLOUD_JOBS - cloudBusy()),
    /** Jobs running in the cloud (null) or on one computer, this turn's starts included. */
    busy: (computer = null) => (computer === null ? cloudBusy() : busyOn(computer.id)),
    /** Free slots on one computer, `{ id, slots }` as `machinesFor` lists it. */
    freeOn: (computer) => Math.max(0, slotsOf(computer) - busyOn(computer.id)),
    /** Whether a job may start where it would run: the cloud, or `computer`. */
    room: (computer = null) => (computer === null ? cloudBusy() < MAX_CLOUD_JOBS : busyOn(computer.id) < slotsOf(computer)),
  };
}
