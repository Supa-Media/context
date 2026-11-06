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

/** Cloud jobs at once in a chat (`apps/agent/src/jobs.ts` holds the same). */
export const MAX_CLOUD_JOBS = 3;
/** The most slots one computer can have (`slotCounts`, `workspaceStore/machines.js`). */
export const MAX_MACHINE_SLOTS = 8;

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
    /** Free slots on one computer, `{ id, slots }` as `machinesFor` lists it. */
    freeOn: (computer) => Math.max(0, slotsOf(computer) - busyOn(computer.id)),
    /** Whether a job may start where it would run: the cloud, or `computer`. */
    room: (computer = null) => (computer === null ? cloudBusy() < MAX_CLOUD_JOBS : busyOn(computer.id) < slotsOf(computer)),
  };
}
