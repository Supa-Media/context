/** Types for `jobStart.cjs`; see that file for the rules and the reasons. */
export interface StartLimits { cloudSlots: number; machineSlots: number }
export interface StartInput { hasTitle: boolean; hasBrief: boolean; already?: { title: string; startedAt?: number; status?: string } | null; computer?: { id: string; slots?: number } | null; cloudBusy?: number; machineBusy?: number }
export interface StartChoice { to: "start" | "already" | "full" | "refuse"; where?: "cloud" | "computer"; slots?: number; title?: string; startedAt?: number; status?: string; why?: string }
export declare const DEFAULT_LIMITS: Readonly<StartLimits>;
export declare function limitsOf(config?: Partial<StartLimits> | null): StartLimits;
export declare function configStartLimits(config?: { nodes?: readonly { id: string; limits?: unknown }[] } | null): StartLimits;
export declare function slotsOn(computer: { slots?: number } | null, limits: StartLimits): number;
export declare function decideStart(input: StartInput, config?: Partial<StartLimits> | null): StartChoice;
