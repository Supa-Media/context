/** Types for `vaultShapes.cjs`; see that file for the reasons. */

export declare const CARD_FIELDS: readonly string[];
export declare const CARD_PARTS: readonly string[];
export declare function cardLabel(meta: unknown): string;
export declare function cardPartValue(part: string, field: (name: string) => string | null | undefined): string | null;
export declare function entryType(meta: unknown): "login" | "secret" | "card";
export declare const PASSWORD_LENGTH: number;
export declare const MIN_LENGTH: number;
export declare const MAX_LENGTH: number;
export declare function randomBelow(n: number): number;
export declare function newPassword(options?: { length?: number; symbols?: boolean }): string;
export declare const CHAT_SHARE_PREFIX: "#chat:";
export declare function chatShareTo(chatKey: string): string;
