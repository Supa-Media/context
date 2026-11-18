/** Types for `jobPartEnd.cjs`; see that file for the rules and the reasons. */
export type PartCause = "done" | "waiting" | "stuck" | "check_limit" | "timeout" | "crash" | "model_down" | "steps_out" | "unfinished" | "changed" | "stopped" | "refused";
export interface JobLimits { parts: number; minutes: number; machineParts: number; machineMinutes: number; resumeAfterMinutes: number; staleParts: number }
export interface PartEndInput { cause: PartCause; part: number; startedAt: number; now: number; machine?: boolean; hasDraft?: boolean; idle?: boolean; wasIdle?: boolean; rejected?: boolean; refusal?: "daily_limit" | "no_model"; checked?: "done" | "waiting" | "stuck"; fresh?: number; staleBefore?: number }
export interface PartEndChoice { to: "carry" | "deliver" | "end"; ended?: "done" | "waiting" | "stuck" | "failed"; cause: PartCause; room: boolean; spinning?: true; stale?: true; resumeAt?: number }
export declare const CAUSES: readonly PartCause[];
export declare const DETERMINISTIC: readonly PartCause[];
export declare const DEFAULT_LIMITS: Readonly<JobLimits>;
export declare function limitsOf(config?: Partial<JobLimits> | null): JobLimits;
export declare function roomLeft(at: { part: number; startedAt: number; now: number; machine?: boolean }, limits: JobLimits): boolean;
export declare function limitResetAt(now: number, limits?: JobLimits): number;
export declare function decidePartEnd(input: PartEndInput, config?: Partial<JobLimits> | null): PartEndChoice;
export declare function configLimits(config?: { nodes?: readonly { id: string; limits?: unknown }[] } | null): JobLimits;
