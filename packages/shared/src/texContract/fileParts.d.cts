/** Types for `fileParts.cjs`; see that file for the rules and the reasons. */
export declare const PART_CHARS: number;
export declare function isTable(name: unknown, type: unknown): boolean;
export interface FilePart { part: string; from: number; to: number; total: number }
export declare function partOf(text: string, from?: number): FilePart | null;
export declare function partLines(part: FilePart, next: (at: number) => string): string[];
