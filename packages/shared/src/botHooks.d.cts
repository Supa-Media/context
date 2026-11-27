/** Types for `botHooks.cjs`; see that file for the reasons. */

export interface HookPayload {
  type: "test" | "mail" | "routine";
  workspace: string;
  bot: string;
  from: string;
  area?: string;
  note?: string;
  /** Where the answer goes: the mail note, or a routine's area mail (or the setup check's note). */
  answer_in?: string;
  at?: number;
}

export declare const HOOK_TIMEOUT_MS: number;
export declare function makeSigningKey(random: (bytes: Uint8Array) => unknown): string;
export declare function signingKeyShaped(key: unknown): boolean;
export declare function headerLine(raw: unknown): { name: string; value: string } | null;
export declare function hookInstructions(payload: HookPayload): string;
export declare function hookPayload(input: HookPayload): HookPayload & { at: string; instructions: string };
export declare function signHook(key: string, timestamp: string, body: string): Promise<string>;
