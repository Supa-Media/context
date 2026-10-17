/** Getting the person's attention. See `tools/attention.js`. */
export function attentionToolDefinitions() {
  return [
    {
      name: "notify_me",
      title: "Notify me",
      description:
        "Have Tex text the person you work for. Only when they asked to be told " +
        '("text me when it is in production") or something is broken or at risk and waiting would hurt; never for progress, ' +
        "a summary, or something that can wait for them to come back to you. Say how urgent it is honestly: emergency (it is broken " +
        "or at risk and they would want to know now), asked (they asked to be told), or fyi (anything else; most people hold these). " +
        "Their own settings decide whether it is texted, they are told which agent sent it, ordinary pings never go at night, and there is a " +
        "daily limit, so send it once and never again another way. message is the whole text they will read, one or two plain sentences " +
        "with the link or detail itself; why is one line on why it is worth interrupting them. Only reaches the person themselves, " +
        "from a connection to their own personal workspace. The answer says whether it was accepted, held or refused, in words you can pass on.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "What they will read, up to 300 characters." },
          urgency: { type: "string", enum: ["emergency", "asked", "fyi"] },
          why: { type: "string", description: "One line: why this is worth interrupting them. Logged, not texted." },
        },
        required: ["message", "urgency"],
        additionalProperties: false,
      },
      // It writes their log note and texts their own phone; it widens nothing and names nobody.
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
  ];
}
