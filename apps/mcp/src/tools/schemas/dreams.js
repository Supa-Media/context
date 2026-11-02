/** Tex's dream now. See `tools/dreamNow.js`. */
export function dreamToolDefinitions() {
  return [
    {
      name: "dream_now",
      title: "Dream now",
      description:
        "Start Tex's dream for the person now instead of at 3 am: Tex reads its recent conversations with them (and, on a first dream, their front page) " +
        "and rewrites tex/about.md, logging what changed in tex/dreams/. It runs within a minute or two and takes a few minutes; nothing is texted. " +
        "Use it once you have learned a lot about someone new, for example after reading their recent email during onboarding, then read tex/about.md " +
        "in a later turn and confirm it with them. Only the owner of their own personal workspace, only where their plan includes dreams, never while one is running, " +
        "and at most once every six hours. The answer says which, in words you can pass on.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      // It changes a note (later, as the dreams client), so it is a write; it
      // reaches nothing outside Context and widens nothing.
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
  ];
}
