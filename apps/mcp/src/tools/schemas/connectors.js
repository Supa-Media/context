/**
 * Connected apps (`tools/connectors.js`, `docs/decisions/connectors.md`):
 * `connect_app` gives the link where the person connects one, and `slack_api`
 * calls Slack through the one they connected.
 */

import { SLACK_HELD_METHODS } from "../connectors.js";

export function connectorToolDefinitions() {
  return [
    {
      name: "connect_app",
      title: "Link to connect an app",
      description:
        "Get the link where the person connects an app to their own account through the app's own approval screen, so you use its API " +
        "instead of signing in with a browser. Slack is the one app so far, and it acts as the person. It connects for one person only, " +
        "never for a shared workspace or a group chat. Never open the app's sign-in page in a browser for this.",
      inputSchema: {
        type: "object",
        properties: {
          app: { type: "string", enum: ["slack"], description: "Which app." },
        },
        required: ["app"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "slack_api",
      title: "Call Slack",
      description:
        "Call one Slack Web API method through the person's own connected Slack; Context adds the token and you never see it. " +
        "Reads: conversations.list {types: \"public_channel,private_channel,im,mpim\", limit}, conversations.history {channel, limit, oldest}, " +
        "conversations.replies {channel, ts}, search.messages {query}, users.list, users.info {user}, " +
        "users.lookupByEmail {email}, chat.getPermalink, team.info. Changes: reactions.add {channel, timestamp, name}, conversations.open {users}. " +
        `Posting (${SLACK_HELD_METHODS.join(", ")}) waits for the person's yes to the exact words first. ` +
        "Channel ids look like C0123; find them with conversations.list. If Slack is not connected, give them the link from connect_app.",
      inputSchema: {
        type: "object",
        properties: {
          method: { type: "string", description: "The Web API method, e.g. conversations.history." },
          args: {
            type: "object",
            description: "The method's arguments, as Slack documents them.",
            properties: Object.fromEntries(
              [
                ["channel", "A channel, DM or group id, e.g. C0123."],
                ["text", "The message's words."],
                ["thread_ts", "Reply in this thread."],
                ["ts", "A message's ts."],
                ["timestamp", "The message a reaction is on."],
                ["name", "A reaction's emoji name, e.g. eyes."],
                ["query", "What search.messages looks for, in Slack's search syntax."],
                ["user", "A user id, e.g. U0123."],
                ["users", "User ids, comma-separated."],
                ["email", "An email address."],
                ["types", "Conversation types, comma-separated."],
                ["cursor", "The next page's cursor."],
                ["oldest", "Only messages after this ts."],
                ["latest", "Only messages before this ts."],
                ["post_at", "When a scheduled message goes, as a Unix time."],
                ["message_ts", "The message chat.getPermalink links to."],
                ["blocks", "Block Kit blocks, as a JSON string."],
              ].map(([key, description]) => [key, { type: "string", description }]),
            ),
            additionalProperties: false,
          },
          limit: { type: "integer", minimum: 1, maximum: 200, description: "How many to list, for a method that pages." },
          team: { type: "string", description: "Which Slack, by name, when more than one is connected." },
        },
        required: ["method"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
  ];
}
