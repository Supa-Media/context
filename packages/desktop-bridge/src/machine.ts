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
