export declare const CHAT_LOOK_PATH: "(check-in)";
export declare function lastRanWords(since: number | undefined, timeZone: string | undefined): string | null;
export declare function chatRoutineQuestion(path: string, lastRan?: string | null): string;
export declare function chatLookQuestion(since: number | undefined, lastRan: string | null, options?: { mail?: boolean }): string;
