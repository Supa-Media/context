/** An area's settings, metric, bots and a person's delegate (`manage area`). See `tools/notes/setArea.js`. */
export function areaToolDefinitions() {
  return [
    {
      name: "set_area",
      title: "Set up an area",
      description:
        "Change an area's settings in one call, the same front matter the app's area panel writes: who holds it (owner, helper: a person's @handle " +
        "or a bot's name), its modes (Visionary, Manager, Doer), the rules that need the owner's approval, and its one metric (the name of a metric note " +
        "in the data folder's metrics/, with a target). bot { name, kind: grok, whose: @handle, reach: webhook | mail } makes or changes a bot's card " +
        "and lists it among the workspace's agents; set owner to its name to give it the area. delegate { person: @handle, to: bot name | Tex | null } says " +
        "who answers for a person in every area they hold. webhook { address, header?, signing_key? } saves the bot's webhook sealed (an owner or " +
        "editor only; Context calls it signed when the area's mail gets a new message, and never shows the address, header or key again); " +
        "test_webhook: <bot name> sends it a signed test call. orient { area } shows an area afterwards.",
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
