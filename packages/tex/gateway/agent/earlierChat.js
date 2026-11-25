/** `earlier_chat`: a group turn's read of everything kept of its chat. */

export const EARLIER_CHAT = "earlier_chat";

/** `earlier_chat` for one turn: everything kept of this chat, oldest first. Reading it marks nothing new: the turn is untrusted already. */
export function earlierChatTool(history) {
  return {
    tool: {
      name: EARLIER_CHAT,
      description:
        "Read everything kept of this group chat, oldest first: what people said, who tagged you and what you answered. " +
        "Use it when someone refers to something said before that isn't in front of you.",
      inputSchema: { type: "object", properties: {} },
    },
    call: async () => {
      if (history.length === 0) return { content: [{ type: "text", text: "Nothing earlier is kept for this chat." }] };
      const lines = history.map((turn) => (turn.role === "user" ? turn.text : `You: ${turn.text}`));
      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    },
  };
}
