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
/** The most times one routine's `at:` may name. */
export declare const MAX_ROUTINE_TIMES: number;
/** Several times in `at:`: each time, the problems, and the note without its `at:` line; null for one time or none. */
export declare function routineTimes(text: string | null): { times: { hour: number; minute: number }[]; problems: string[]; text: string } | null;
export declare function cardSlug(holder: unknown): string;
export declare function botsHome(areasRoot: string): string;
export declare function legacyBotsFolder(areasRoot: string): string;
/** The name before a card's first ` · `, `Tex Quality · Tex reply quality` → `Tex Quality`; null when there is none. */
export declare function botShortName(bot: unknown): string | null;
export declare function botCardPaths(areasRoot: string, bot: string): string[];
export declare function isBotCardPath(path: unknown, areasRoot: string): boolean;
export declare function areaRoutineOf(path: unknown, areasRoot: string): AreaRoutine | null;
export declare function areaRoutineNext(routine: AreaRoutine | null, text: string | null, afterMs: number): { at: number | null; problems: string[]; settings: unknown };
export declare function areaRoutineWhen(routine: AreaRoutine | null, text: string | null): string;
export declare function parseWorksIn(value: unknown): WorksIn[] | null;
export declare function parseWorksInEntry(raw: unknown): WorksIn | null;
export declare function worksInLine(entry: { area: string; cap: number | null | undefined }): string;
export declare function botCapIn(worksIn: WorksIn[] | null | undefined, area: string): number | null;
export declare function weekOf(ms: number, timeZone?: string): string;
export declare function mailOnlyText(): string;
export declare function routinesText(where: string): string;
