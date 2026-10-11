/**
 * The model wire formats, behind one shape, and the one error a model call
 * throws.
 *
 * This used to also spend a person's own Anthropic or OpenAI key, fetched for
 * one request from the control plane. Those keys were deleted and are no
 * longer used (decided by the owner, 2026-10-10): every turn runs on the
 * built-in model (`builtin.js`, `aiGateway.js`), and what is left here is the
 * translation both of those use.
 *
 * ## One shape, two wire formats
 *
 * The loop in `turn.js` must not know which wire format answered, so both are
 * normalized to:
 *
 *     { text, toolCalls: [{ id, name, args }], stop }
 *
 * and `messages` is this module's own format — `{ role, text }` for ordinary
 * turns, `{ role: "tool", id, name, text }` for a tool's answer — translated on
 * the way out: Anthropic's Messages shape for the AI gateway, the
 * chat-completions shape for Workers AI. A caller never builds an Anthropic
 * `content` block or an OpenAI `tool_calls` entry.
 */

export class ProviderError extends Error {
  /**
   * @param {string} reason a short phrase written for an operator's log, never
   *   for the caller and never carrying the key or the customer's question
   * @param {number|null} status the HTTP status, where there was one
   */
  constructor(reason, status = null) {
    super(`model provider: ${reason}`);
    this.name = "ProviderError";
    this.reason = reason;
    this.status = status;
  }
}

/* -------------------------------------------------------------------------- */
/* Anthropic                                                                  */
/* -------------------------------------------------------------------------- */

export function anthropicMessages(messages) {
  /*
    Tool answers are a *user* turn on this API, and consecutive tool answers
    must ride in one turn's content array — sending them as separate messages
    is accepted by the API and then quietly confuses the model about how many
    times it called. So they are grouped here rather than at the call site.
  */
  const out = [];
  for (const message of messages) {
    if (message.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: message.id,
        content: message.text,
        ...(message.isError ? { is_error: true } : {}),
      };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content) && last.pendingTools) {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block], pendingTools: true });
      }
      continue;
    }
    if (message.role === "assistant") {
      const content = [];
      if (message.text) content.push({ type: "text", text: message.text });
      for (const call of message.toolCalls || []) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.args });
      }
      if (content.length > 0) out.push({ role: "assistant", content });
      continue;
    }
    out.push({ role: "user", content: [{ type: "text", text: message.text }] });
  }
  // `pendingTools` is this function's own bookkeeping and is not part of the
  // API's shape; a stray key here is a 400 from Anthropic, not a silent ignore.
  return out.map(({ pendingTools, ...message }) => message);
}

/* -------------------------------------------------------------------------- */
/* OpenAI                                                                     */
/* -------------------------------------------------------------------------- */

export function openAiMessages(system, messages) {
  const out = system ? [{ role: "system", content: system }] : [];
  for (const message of messages) {
    if (message.role === "tool") {
      out.push({ role: "tool", tool_call_id: message.id, content: message.text });
      continue;
    }
    if (message.role === "assistant") {
      out.push({
        role: "assistant",
        content: message.text || null,
        ...((message.toolCalls || []).length > 0
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
              })),
            }
          : {}),
      });
      continue;
    }
    out.push({ role: "user", content: message.text });
  }
  return out;
}

/** Tool definitions in the chat-completions shape, also what Workers AI takes. */
export function openAiTools(tools) {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema || { type: "object" },
    },
  }));
}

/** Read one chat-completions answer into this module's shape. */
export function readChatCompletion(parsed) {
  const message = parsed?.choices?.[0]?.message ?? {};
  const toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : [])
    .filter((call) => typeof call?.function?.name === "string")
    .map((call) => ({
      id: String(call.id ?? ""),
      name: call.function.name,
      /*
        Arguments arrive as a JSON *string* on this API, and a model that
        produces a malformed one is a fact about the model rather than an error
        worth failing the turn over — the loop hands `{}` to the tool, the tool
        refuses it on its own terms, and the model reads why and tries again.
      */
      args: parseArguments(call.function.arguments),
    }));

  return {
    text: typeof message.content === "string" ? message.content : "",
    toolCalls,
    stop: parsed?.choices?.[0]?.finish_reason ?? null,
  };
}

export function parseArguments(raw) {
  // Workers AI hands some models' arguments over already parsed.
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
