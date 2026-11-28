/** Types for `toolContract.cjs`; see that file for the rules and the reasons. */
export declare const EMAIL_TOOL: "send_email";
export declare const REPORT_TOOL: "report_problem";
export declare const TEXTS_ID_PREFIX: "texts:";
export declare const MEMORY_FOLDER: "inbox/memories";
export interface ToolText { content: { type: "text"; text: string }[] }
export interface ToolError extends ToolText { isError: true }
export declare function toolText(text: string): ToolText;
export declare function toolError(text: string): ToolError;
export declare function actionOf(tool: string, args: { action?: unknown }): unknown;
export declare const HANDLE: RegExp;
export declare function addressedTo(words: unknown, who: string | null | undefined): boolean;
