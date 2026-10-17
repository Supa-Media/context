/** The email tool. See `tools/email.js` and `tools/emailGate.js`. */
export function emailToolDefinitions() {
  return [
    {
      name: "send_email",
      title: "Send an email",
      description:
        "Send one plain-text email as the person, through their own connected Gmail. It is never sent straight away: " +
        "the person is shown this exact email and must say yes to it, and any change is a new email they are asked about again. " +
        "Write the whole email first (to, subject, body as they would send it) from what the person asked for; for a reply, " +
        "use the sender's address from the email in their inbox and start the subject with Re:. Don't repeat the whole email " +
        "in your answer; Context shows it to them. Only when the person asked for this email; if they only asked for a draft, " +
        "give them the draft instead. At most 10 addresses, 5 emails an hour, 20 a day, and 3 a day to one address.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "array", items: { type: "string" }, description: "Plain email addresses, like jo@example.com." },
          cc: { type: "array", items: { type: "string" }, description: "Optional plain email addresses." },
          subject: { type: "string", description: "One line, up to 200 characters." },
          body: { type: "string", description: "The email's plain text, as it will be sent." },
          from: {
            type: "string",
            description: "Optional: which of the person's connected Gmail addresses sends it. Left out, their first one that can.",
          },
        },
        required: ["to", "subject", "body"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
  ];
}
