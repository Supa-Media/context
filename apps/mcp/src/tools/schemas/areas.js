/** An area's settings (owner and delegate among them), metric and bots (`manage area`). See `tools/notes/setArea.js`. */
export function areaToolDefinitions() {
  return [
    {
      name: "set_area",
      title: "Set up an area",
      description:
        "Change an area's settings, as the app's area panel does: owner (@handle or bot name), delegate (the one bot or Tex acting for a " +
        "person owner in this area), modes, approval rules and its one metric (a metric note's name in the data folder's metrics/, with a " +
        "target). bot makes or changes a bot's card; webhook saves a bot's webhook sealed (never shown again); test_webhook sends it a signed test call; " +
        "attach and detach say which projects serve the area.",
      inputSchema: {
        type: "object",
        properties: {
          area: { type: "string", description: 'The area\'s folder, like "areas/finance".' },
          owner: { type: ["string", "null"], description: "@handle or bot name; null clears it." },
          delegate: { type: ["string", "null"], description: "The one bot's name (or Tex) that acts for this area's person owner here; never a person, none when a bot owns it; null clears it." },
          modes: { type: "array", items: { type: "string" }, description: "Any of Visionary, Manager, Doer; [] clears them." },
          approvals: { type: "array", items: { type: "string" }, description: "One-line rules that need the owner's approval first; [] clears them." },
          metric: {
            type: ["object", "null"],
            description: "The area's one metric; null clears it.",
            properties: { name: { type: "string" }, target: { type: "string", description: 'What good looks like, like "over $5" or "under 2 days".' } },
            additionalProperties: false,
          },
          bot: {
            type: "object",
            properties: {
              name: { type: "string" },
              kind: { type: "string", description: "grok (the default)." },
              whose: { type: "string", description: "The @handle of the person the bot belongs to." },
              reach: { type: "string", enum: ["webhook", "mail"], description: "webhook: Context calls it; mail: it checks its mail on a timer." },
              avatar: {
                type: "object",
                description: "Its logo, shown for it in the app: data (its base64), or url (https), which Context fetches only when the person's own words ask for it (person_said).",
                properties: { url: { type: "string" }, data: { type: "string" } },
                additionalProperties: false,
              },
            },
            required: ["name"],
            additionalProperties: false,
          },
          webhook: {
            type: "object",
            properties: {
              bot: { type: "string", description: "The bot's name; bot.name when left out." },
              address: { type: "string", description: "A public https address." },
              header: { type: "string", description: "One header to send, as Name: value." },
              signing_key: { type: "string", description: "ctxbot_ and 64 hex characters from a random source; Context makes one nobody sees when left out." },
              header_from_shell: { type: "string", description: "A header's name (Authorization): you get a one-time curl command that sends its value from your shell, so you never see the secret." },
            },
            required: ["address"],
            additionalProperties: false,
          },
          test_webhook: { type: "string", description: "A bot's name: send its webhook a signed test call." },
          create: { type: "boolean", description: "Make the area's about.md when it is not there yet." },
          attach: {
            type: ["string", "array"],
            items: { type: "string" },
            description: 'A project\'s folder, or a list, like "projects/website": writes area: <this area> in its front note. A project serves one area, so this moves one that serves another.',
          },
          detach: {
            type: ["string", "array"],
            items: { type: "string" },
            description: "A project's folder, or a list: removes its area line, only when it names this area or one inside it.",
          },
        },
        required: ["area"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
  ];
}
