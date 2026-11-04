/**
 * "Let Tex use this Mac" (bridge version 10), split out of `contract.ts` to
 * keep that file under the size ceiling. Re-exported from there.
 *
 * The page reads whether this Mac runs Tex's jobs and turns it on or off.
 * Nothing in this shape is a credential or a path: the machine grant lives in
 * the main process's keychain store and goes to the runner as a file the page
 * never learns about (`apps/desktop/src/main/machineRunner.ts`).
 */

export type MachineRunState = "off" | "unavailable" | "starting" | "online" | "offline" | "paused" | "notReady" | "failed";

export interface MachineRunStatus {
  /** This build carries the runner and this platform can run it. */
  available: boolean;
  /** The person turned it on. */
  enabled: boolean;
  state: MachineRunState;
  slots: number;
  busy: number;
  /** The Mac is being kept awake for Tex (only while plugged in). */
  awake: boolean;
  /** One plain sentence when something needs the person, else null. */
  message: string | null;
}

const STATES: readonly MachineRunState[] = ["off", "unavailable", "starting", "online", "offline", "paused", "notReady", "failed"];

/** A status rebuilt field by field from whatever crossed the bridge; anything odd reads as off. */
export function machineStatusFrom(value: unknown): MachineRunStatus {
  const r = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 64 ? v : 0);
  return {
    available: r.available === true,
    enabled: r.enabled === true,
    state: STATES.includes(r.state as MachineRunState) ? (r.state as MachineRunState) : "off",
    slots: count(r.slots),
    busy: count(r.busy),
    awake: r.awake === true,
    message: typeof r.message === "string" && r.message.length > 0 ? r.message.slice(0, 200) : null,
  };
}

/** At most this many folders, each an absolute path of at most 1,024 characters; anything else is dropped. */
export const MAX_MACHINE_FOLDERS = 20;

/** The folders a shell answered, rebuilt: `null` stays `null` (unknown), never an empty list. */
export function machineFoldersFrom(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.startsWith("/") || entry.length > 1024 || out.includes(entry)) continue;
    out.push(entry);
    if (out.length === MAX_MACHINE_FOLDERS) break;
  }
  return out;
}

/** A machine id as the gateway mints them (`ID` in `apps/mcp/src/machines/appRoutes.js`), or `null`. */
export function machineIdFrom(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
}
