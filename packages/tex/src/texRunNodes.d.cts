/** Types for `texRunNodes.cjs`: the run steps (kind `run`) and the input steps each one's code can start. */
export type RunStepDecl = { readonly starts: readonly string[]; readonly fallback: string; readonly what: string };
export const RUN_STEPS: Readonly<Record<string, RunStepDecl>>;
export function runTarget(config: unknown, id: string): string | null;
export function runStepProblems(config: unknown): string[];
