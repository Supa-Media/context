/** Types for `texScreen.cjs`; see that file. */
export const SCREEN_TABS: number;
export const SCREEN_SELECTION: number;
/** What is wrong with a message's `screen`, as sentences; empty when the app could have sent it. */
export function screenProblems(screen: unknown): string[];
