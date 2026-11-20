/** Types for `toolRules.cjs`; see that file for the rules and the reasons. */
export type ErrorRating = "actionable" | "partial" | "not";
export interface StateFile { file: string; what: string; action: string | null }
export declare const TOOL_CHAR_LIMIT: number;
export declare function toolChars(tool: { description?: string; input_schema?: unknown; inputSchema?: unknown } | null | undefined): number;
export declare function rateError(text: string): ErrorRating;
export declare const TEX_STATE_FILES: readonly StateFile[];
export declare function stateFileOf(path: string): StateFile | null;
export declare const SHELL_NAMES: readonly string[];
