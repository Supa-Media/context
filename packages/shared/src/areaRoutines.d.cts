/** Types for `areaRoutines.cjs`; see that file for the reasons. */

export interface AreaRoutine {
  area: string;
  folder: string;
  name: string;
  cadence: { unit: string; every: number } | null;
}
export interface WorksIn {
  area: string;
  cap: number | null;
}

export declare const AREA_ROUTINES_FOLDER: "routines";
export declare const BOTS_FOLDER: "bots";
export declare const PEOPLE_FOLDER: "people";
export declare const DEFAULT_ROUTINE_ZONE: string;
export declare const MAX_AREA_ROUTINES: number;
export declare function cardSlug(holder: unknown): string;
export declare function botCardPaths(areasRoot: string, bot: string): [string, string];
export declare function isBotCardPath(path: unknown, areasRoot: string): boolean;
export declare function areaRoutineOf(path: unknown, areasRoot: string): AreaRoutine | null;
export declare function areaRoutineNext(routine: AreaRoutine | null, text: string | null, afterMs: number): { at: number | null; problems: string[]; settings: unknown };
export declare function areaRoutineWhen(routine: AreaRoutine | null, text: string | null): string;
export declare function parseWorksIn(value: unknown): WorksIn[] | null;
export declare function parseWorksInEntry(raw: unknown): WorksIn | null;
export declare function worksInLine(entry: { area: string; cap: number | null | undefined }): string;
export declare function botAllowedIn(worksIn: WorksIn[] | null | undefined, area: string): { allowed: boolean; cap: number | null };
export declare function weekOf(ms: number, timeZone?: string): string;
export declare function mailOnlyText(): string;
export declare function routinesText(where: string): string;
