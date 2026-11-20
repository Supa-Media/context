/**
 * The Conversations view's pure rule for the "In the prompt" column of the ledger table (the artifact's `renderConvo`):
 * `yes` and `no` as written, and for names-only entries the setting decides: `names only` when tool calls are slim,
 * `whole` when they are not. Kept apart from the view so it can be tested without the Lab's state or Convex.
 */
export function inPrompt(kind: string, sh: string, slim: boolean): string {
  if (sh === "yes") return "yes";
  if (sh === "no") return "no";
  return slim || kind !== "tool" ? sh : "whole";
}
