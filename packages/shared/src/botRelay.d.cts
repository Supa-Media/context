/** Types for `botRelay.cjs`; see that file for the reasons. */

export declare const RELAY_PROMPT: string;
export declare function relayStep(): string;
export declare function bindStep(name: string, workspace?: string): string;
export declare function setupStep(name: string, workspace?: string): string;
export declare function relayMemory(): string;
export declare function pictureStep(card?: string, workspace?: string): string;
export declare function refreshAsk(name: string, workspace?: string, card?: string): string;
export declare function setupAnswer(fields: {
  holder: string;
  bot: string;
  card: string;
  checkPath: string | null;
  failed: string | null;
  webhook: boolean;
  workspace?: string;
  /** "sent" when Context sent the webhook a test routine for the check, else why not. */
  routineTest?: string;
}): string;
