/** Types for `arrival.js`, which the texting Worker's tests import by path (`packages/tex/worker/gatewayOver.testing.ts`). */
export declare const ARRIVAL_KINDS: ReadonlySet<string>;
export declare const INBOX_NAME: RegExp;
export declare const MAX_EVENT_ID: number;
export declare function isArrival(body: unknown): boolean;
