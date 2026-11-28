/** Types for `egressLedger.cjs`; see that file. */

export interface EgressLedger {
  untrusted: boolean;
  outside: boolean;
  asked: unknown[];
  [key: string]: unknown;
}

export declare function newLedger(): EgressLedger;
export declare function markUntrusted(ledger: EgressLedger | null | undefined): void;
export declare function markChatWords(ledger: EgressLedger | null | undefined): void;
export declare function oneLine(text: unknown): string;
export declare function mightWiden(name: string, args: unknown, options?: { into?: string | null; writes?: boolean }): boolean;
