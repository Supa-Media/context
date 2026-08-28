/**
 * What Context is, in six lines, for somebody who has never heard of it.
 *
 * Separated from the component because two of these sentences are load-bearing
 * rather than decorative, and a claim that only exists inside JSX is a claim no
 * test can read:
 *
 *  - **`team` never means public.** The sharing line has to say who can see a
 *    context — named people the owner granted access to — and must not leave
 *    room for a reader to assume there is a public tier, because there is not
 *    one and there is not going to be one.
 *  - **A shared context has no ingestion address.** Not a disabled one, not one
 *    awaiting configuration: mail lands in a personal context and nowhere else
 *    (see `resolvePersonalContextForIngestion` in the control plane). The
 *    shared-buckets line is the one place on this screen where somebody could
 *    reasonably infer a team capture address, so it denies it outright rather
 *    than staying silent. `__tests__/contextOverview.test.ts` holds that line.
 *
 * The rest is ordinary product copy, and the house voice applies: short,
 * concrete, no adjectives doing work a noun should do.
 */

export interface OverviewFact {
  /** The mono key, in `colors.codeKey`. */
  title: string;
  body: string;
  /**
   * Set when the thing described does not exist yet, and rendered as a `Pill`.
   *
   * Present rather than implied: a line about shared buckets sitting
   * unqualified beside five things that work today reads as a sixth thing that
   * works today.
   */
  status?: "coming soon";
}

export const CONTEXT_OVERVIEW_FACTS: readonly OverviewFact[] = [
  {
    title: "One context, every client",
    body: "ChatGPT, Claude, Codex, Notion AI — one MCP endpoint, and the same notes in all of them.",
  },
  {
    title: "Start here, continue there",
    body: "Start a task in one place and continue it somewhere else. No re-explaining yourself to each new tool.",
  },
  {
    title: "Your own bucket",
    body: "Your own S3 or R2 bucket, holding plain Markdown. No vendor lock-in: revoke the key and we're gone, and every file is still sitting where it was.",
  },
  {
    title: "Your own structure",
    body: "PARA, or folders you invented years ago. We don't impose a schema on a brain you have already arranged.",
  },
  {
    title: "Named people only",
    body: "Sharing is with named people the owner granted access to, never the public internet. There is no anonymous tier.",
  },
  {
    title: "Shared workspaces",
    status: "coming soon",
    body: "One bucket, several members, one set of privacy rules. Mail is not part of it — a capture address belongs to one person's brain, and a workspace has none.",
  },
];

/**
 * The trust sentence, verbatim from the onboarding flow's footer.
 *
 * Said in the same words in both places on purpose. Somebody who accepts an
 * invitation today and runs onboarding next week should meet one promise
 * twice, not two paraphrases they have to check against each other.
 */
export const CONTEXT_OVERVIEW_FOOT =
  "Your notes stay in a bucket you own. Nothing here moves a file you already have.";
