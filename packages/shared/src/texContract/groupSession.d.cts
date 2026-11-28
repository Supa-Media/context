/** Types for `groupSession.cjs`; see that file. */

export declare const TEXTS_GROUP_CLIENT_ID: "context_texts_group";
export declare const GROUP_OWN_ACCOUNT_TOOLS: readonly ["send_email", "calendar_event"];

export declare function isGroupSession(session: unknown): boolean;
export declare function actsOnOwnAccount(session: unknown, name: string): boolean;
