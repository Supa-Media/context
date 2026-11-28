/** Types for `emailRead.cjs`; see that file for the rules and the reasons. */
export declare const ACCOUNT: RegExp;
export declare const EMAIL_ID_PREFIX: "email:";
export declare function parseEmailId(id: unknown): { address: string; messageId: string } | null;
export declare const REFUSED: Record<string, string>;
