/** Types for `botRelay.cjs`; see that file for the reasons. */

export declare const RELAY_PROMPT: string;
export declare function relayStep(): string;
export declare function bindStep(name: string, workspace?: string): string;
export declare function relayMemory(): string;
export declare function refreshAsk(name: string, workspace?: string): string;
