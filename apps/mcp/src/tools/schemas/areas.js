/** An area's settings, metric, bots and a person's delegate (`manage area`). See `tools/notes/setArea.js`. */
export function areaToolDefinitions() {
  return [
    {
      name: "set_area",
      title: "Set up an area",
      description:
        "Change an area's settings, as the app's area panel does: owner and helper (@handle or bot name), modes, approval rules and its one " +
        "metric (a metric note's name in the data folder's metrics/, with a target). bot makes or changes a bot's card; delegate says who " +
        "answers for a person; webhook saves a bot's webhook sealed (never shown again); test_webhook sends it a signed test call.",
      inputSchema: {
        type: "object",
        properties: {
          area: { type: "string", description: 'The area\'s folder, like "areas/finance".' },
          owner: { type: ["string", "null"], description: "@handle or bot name; null clears it." },
          helper: { type: ["string", "null"], description: "@handle or bot name; null clears it." },
          modes: { type: "array", items: { type: "string" }, description: "Any of Visionary, Manager, Doer; [] clears them." },
          approvals: { type: "array", items: { type: "string" }, description: "One-line rules that need the owner's approval first; [] clears them." },
          metric: {
            type: ["object", "null"],
            description: "The area's one metric; null clears it.",
            properties: { name: { type: "string" }, target: { type: "string", description: 'What good looks like, like "over $5" or "under 2 days".' } },
          },
          bot: {
            type: "object",
            properties: {
              name: { type: "string" },
              kind: { type: "string", description: "grok (the default)." },
              whose: { type: "string", description: "The @handle of the person the bot belongs to." },
              reach: { type: "string", enum: ["webhook", "mail"], description: "webhook: Context calls it; mail: it checks its mail on a timer." },
            },
            required: ["name"],
          },
          delegate: {
            type: "object",
            properties: { person: { type: "string" }, to: { type: ["string", "null"] } },
            required: ["person"],
          },
          webhook: {
            type: "object",
            properties: {
              bot: { type: "string", description: "The bot's name; bot.name when left out." },
              address: { type: "string", description: "A public https address." },
              header: { type: "string", description: "One header to send, as Name: value." },
              signing_key: { type: "string", description: "ctxbot_ and 64 hex characters from a random source; Context makes one nobody sees when left out." },
            },
            required: ["address"],
          },
          test_webhook: { type: "string", description: "A bot's name: send its webhook a signed test call." },
          create: { type: "boolean", description: "Make the area's about.md when it is not there yet." },
        },
        required: ["area"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
  ];
}
