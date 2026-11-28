/**
 * A split job's part asleep (`packages/shared/src/jobSplit.cjs`, Part end's "sleep" in `jobPartEnd.cjs`).
 *
 * A part of a split that ends waiting, on a partner's mail or on them, no longer ends: its words go to the chat's
 * coordinator as a waiting part's do, and the job's object keeps the run with `asleep` set to when the sleep runs
 * out. It holds its slot, as a running job does, and uses up no parts while it sleeps. Mail on its note, or a text
 * of theirs passed to it, wakes it (`jobRun.ts` `steerJob`, `jobDrive.ts` `wakeDrive`) into its next part, which is
 * shown what came. A sleep that runs out with nothing come ends the job waiting, as it would have ended before
 * (2026-11-06: a split's parts each ended, or spent their parts checking, while they waited on each other).
 */

import type { InboxStorage } from "./inbox";
import type { JobSteer } from "./jobs";

/** What a pass of a sleeping part does: its next part ("wake"), the end it slept instead of ("end"), or more sleep. */
export type Wake = { kind: "wake" } | { kind: "end" } | { kind: "sleep"; ms: number };

/** Whether mail or a text came for it (`steers`), and whether its sleep ran out by `now`. */
export async function wakeOf(storage: InboxStorage, steersKey: string, asleep: number, now: number): Promise<Wake> {
  const steers = (await storage.get<JobSteer[]>(steersKey)) ?? [];
  if (steers.length > 0) return { kind: "wake" };
  return now >= asleep ? { kind: "end" } : { kind: "sleep", ms: asleep - now };
}
