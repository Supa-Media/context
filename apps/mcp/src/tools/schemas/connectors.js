/**
 * Connected apps (`tools/connectors.js`, `docs/decisions/connectors.md`):
 * `connect_app` gives the link where the person connects one, `slack_api`
 * calls Slack through the one they connected, and `app_read` / `app_change`
 * call an app connected through its own MCP server (`tools/apps.js`).
 */

const APP_CALL = {
  app: { type: "string", description: "An app id from app_read with no app, e.g. linear." },
  tool: { type: "string", description: "One of the tools app_read lists for the app." },
  arguments: { type: "object", description: "The tool's own arguments, as app_read lists them." },
};

import { SLACK_HELD_METHODS } from "../connectors.js";

export function connectorToolDefinitions() {
  return [
    {
      name: "connect_app",
      title: "Link to connect an app",
      description:
        "Get the link where the person connects an app to their own account through the app's own approval screen, so you use its API " +
        "instead of signing in with a browser; app_read with no app lists the apps. It acts as the person, and connects for one person only, " +
        "never for a shared workspace or a group chat. Never open the app's sign-in page in a browser for this.",
      inputSchema: {
        type: "object",
        properties: {
          app: { type: "string", description: "Which app, e.g. slack or linear." },
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
        "conversations.replies {channel, ts}, search.messages {query}, users.list {match}, users.info {user}, " +
        "users.lookupByEmail {email}, chat.getPermalink, team.info. Changes: reactions.add {channel, timestamp, name}, conversations.open {users}. " +
        "users.list and conversations.list read every page in one call and come back short: active people and open channels only " +
        "(include_inactive \"true\" for all); to find someone, pass match with their name or email, e.g. {match: \"segun\"}. " +
        "users.lookupByEmail finds only the email they use in that Slack. " +
        "To DM someone, chat.postMessage takes their user id or that email as channel and posts in the DM with them. " +
        "Any channel argument may be \"#name\". conversations.history and conversations.replies come back short, with each author named; " +
        "reply in a thread with chat.postMessage {channel, thread_ts, text}. " +
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
                ["channel", "A channel, DM or group id, e.g. C0123; for a post, also a person's user id or Slack email, to DM them."],
                ["text", "The message's words."],
                ["thread_ts", "Reply in this thread."],
                ["ts", "A message's ts."],
                ["timestamp", "The message a reaction is on."],
                ["name", "A reaction's emoji name, e.g. eyes."],
                ["query", "What search.messages looks for, in Slack's search syntax."],
                ["match", "users.list or conversations.list: keep only entries whose name or email holds every word of this."],
                ["include_inactive", "users.list or conversations.list: \"true\" to include deactivated people, bots and archived channels."],
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
          limit: { type: "integer", minimum: 1, maximum: 200, description: "How many to list, for a method that pages (users.list and conversations.list: how many to return, default 150)." },
          team: { type: "string", description: "Which Slack, by name, when more than one is connected." },
        },
        required: ["method"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    {
      name: "app_read",
      title: "Read through a connected app",
      description:
        "With no app: every app Context connects (Linear, Notion, Jira, Planning Center…) and whether the person connected it; " +
        "anything not listed needs the browser. With app: its tools, each marked read or change. With app and tool: run one read " +
        "through the person's own connection. A change goes through app_change.",
      inputSchema: { type: "object", properties: APP_CALL, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    {
      name: "app_change",
      title: "Change through a connected app",
      description: "Run one tool app_read marks change, through the person's own connection. It waits for their yes to exactly this call.",
      inputSchema: { type: "object", properties: APP_CALL, required: ["app", "tool"], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
  ];
}
