/** The Google Chat tools. See `tools/googleChat.js`, `tools/googleChatGate.js` and `tools/googleChatRead.js`. */
import { CHAT_QUOTATION, MAX_CHAT_READ } from "../googleChatRead.js";

export function googleChatToolDefinitions() {
  return [
    {
      name: "google_chat",
      title: "Send a Google Chat message",
      description:
        "Send one Google Chat message as the person, through their own connected Google account: a direct message to a " +
        "person by their work email (to), or a post in a space by its name in Chat (space). It waits for their 👍 to the exact " +
        "message and place, which they are shown right after your answer; call it, don't ask for their OK yourself. " +
        "action spaces (no other args) lists the spaces they are in, with names, to find the right one. " +
        "Only when the person asked for this message. At most 10 an hour and 40 a day. Use this before the browser for Google Chat.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["send", "spaces"], description: "send (the default) or spaces, to list their spaces." },
          to: { type: "string", description: "send: a person's work email, for a direct message with them." },
          space: { type: "string", description: "send: a space's name as Chat shows it, or its spaces/… id from action spaces." },
          text: { type: "string", description: "send: the message's words, exactly as they go." },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    {
      name: "read_google_chat",
      title: "Read a Google Chat conversation",
      description:
        "Read one Google Chat conversation live from the person's own connected Google account: a space by its spaces/… id " +
        "(google_chat action spaces lists them), or the direct message with one person by their work email (to). The newest " +
        `messages, both sides, oldest first. ${CHAT_QUOTATION}`,
      inputSchema: {
        type: "object",
        properties: {
          space: { type: "string", description: "A space's spaces/… id." },
          to: { type: "string", description: "The other person's work email, for your direct message with them." },
          limit: { type: "integer", minimum: 1, maximum: MAX_CHAT_READ, description: "Default 20" },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
  ];
}
