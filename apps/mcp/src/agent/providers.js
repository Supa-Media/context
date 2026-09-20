/**
 * The two model APIs this build knows how to spend, behind one shape.
 *
 * The customer connects their own Anthropic or OpenAI account; the control
 * plane hands the key over for the length of one request (`/gateway/provider`,
 * see `src/controlPlane.js`), and these functions are the only place in the
 * worker it is used. Zero npm dependencies, `fetch` and Web Crypto only, like
 * everything else here.
 *
 * ## One shape, two wire formats
 *
 * The loop in `turn.js` must not know which provider answered, or every future
 * provider is a third branch in the loop as well as a new adapter. So both are
 * normalized to:
 *
 *     request({ model, system, messages, tools, apiKey })
 *       → { text, toolCalls: [{ id, name, args }], stop }
 *
 * and `messages` is this module's own format — `{ role, text }` for ordinary
 * turns, `{ role: "tool", id, name, text }` for a tool's answer — translated on
 * the way out. A caller never builds an Anthropic `content` block or an OpenAI
 * `tool_calls` entry.
 *
 * ## What is deliberately not here
 *
 * **Streaming.** The first cut answers whole turns, because a turn that
 * finishes is worth more than a turn that renders prettily, and adding SSE
 * later changes this module and not its callers.
 *
 * **A base URL.** An OpenAI-compatible endpoint needs one, and taking it from
 * the customer is how somebody who can write to a *shared* workspace points the
 * gateway at a host of theirs and receives the owner's key — plus the ordinary
 * SSRF of a fetch aimed at a loopback address. `apps/convex/functions/providers.ts`
 * refuses to store one for exactly this reason; this is the fetch it was
 * refusing on behalf of. Both endpoints below are constants.
 */

/** Where each provider lives. Constants, never configuration — see the header. */
const ENDPOINTS = {
  anthropic: "https://api.anthropic.com/v1/messages",
  openai: "https://api.openai.com/v1/chat/completions",
};

/**
 * The default model per provider, and **the one thing in this file with a
 * shelf life.**
 *
 * Model names move faster than this repository does, so they are named once,
 * here, and overridable per deployment (`AGENT_ANTHROPIC_MODEL`,
 * `AGENT_OPENAI_MODEL` in the Worker's vars) without a code change. A
 * self-hoster whose account has different models available changes a var; they
 * do not fork the gateway.
 */
export const DEFAULT_MODELS = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5",
};

/** The Anthropic API version this build is written against. */
const ANTHROPIC_VERSION = "2023-06-01";

/** How long one model call may take before it is abandoned. */
const MODEL_TIMEOUT_MS = 60_000;

/**
 * The largest model response this worker will read.
 *
 * A cap rather than trust: the body is parsed into memory on a Worker with a
 * fixed budget, and a provider having a bad day must fail this request rather
 * than the isolate.
 */
const RESPONSE_BYTE_CAP = 2_000_000;

/** How much of the model's answer one turn may produce. */
const MAX_OUTPUT_TOKENS = 4096;

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

/**
 * Read a capped JSON body, or throw.
 *
 * Every failure here is a phrase and a status. **The response text is never
 * included**, because a provider's error body quotes the request that produced
 * it — which on these two APIs means the customer's question and, on some
 * error shapes, a fragment of the key.
 */
async function readJson(response) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > RESPONSE_BYTE_CAP) {
    throw new ProviderError("response too large", response.status);
  }
  let text;
  try {
    text = await response.text();
  } catch {
    throw new ProviderError("response unreadable", response.status);
  }
  if (text.length > RESPONSE_BYTE_CAP) {
    throw new ProviderError("response too large", response.status);
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed;
  } catch {
    throw new ProviderError("response not json", response.status);
  }
}

async function post(url, headers, body, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      // "manual", for the reason `controlPlane.js` gives: a redirect followed
      // is a credential replayed to a Location we did not choose. workerd does
      // not implement `redirect: "error"`, so this is the form that works.
      redirect: "manual",
    });
  } catch {
    // The caught error may quote the request — headers included, and one of
    // those headers is the key. Dropped on the floor rather than wrapped.
    throw new ProviderError("request failed");
  } finally {
    clearTimeout(timer);
  }

  if (!response || response.status !== 200) {
    throw new ProviderError(`status ${response?.status ?? "none"}`, response?.status ?? null);
  }
  return await readJson(response);
}

/* -------------------------------------------------------------------------- */
/* Anthropic                                                                  */
/* -------------------------------------------------------------------------- */

function anthropicMessages(messages) {
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

async function anthropicRequest({ model, system, messages, tools, apiKey }, fetchImpl) {
  const body = {
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: anthropicMessages(messages),
    ...(system ? { system } : {}),
    ...(tools.length > 0
      ? {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema || { type: "object" },
          })),
        }
      : {}),
  };

  const parsed = await post(
    ENDPOINTS.anthropic,
    {
      // The key appears here and nowhere else in this module.
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body,
    fetchImpl,
  );

  const blocks = Array.isArray(parsed.content) ? parsed.content : [];
  const text = blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
  const toolCalls = blocks
    .filter((block) => block?.type === "tool_use" && typeof block.name === "string")
    .map((block) => ({
      id: String(block.id ?? ""),
      name: block.name,
      args: block.input && typeof block.input === "object" ? block.input : {},
    }));

  return { text, toolCalls, stop: parsed.stop_reason ?? null };
}

/* -------------------------------------------------------------------------- */
/* OpenAI                                                                     */
/* -------------------------------------------------------------------------- */

function openAiMessages(system, messages) {
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

async function openAiRequest({ model, system, messages, tools, apiKey }, fetchImpl) {
  const body = {
    model,
    messages: openAiMessages(system, messages),
    ...(tools.length > 0
      ? {
          tools: tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema || { type: "object" },
            },
          })),
        }
      : {}),
  };

  const parsed = await post(
    ENDPOINTS.openai,
    // The key appears here and nowhere else in this module.
    { Authorization: `Bearer ${apiKey}` },
    body,
    fetchImpl,
  );

  const message = parsed.choices?.[0]?.message ?? {};
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
    stop: parsed.choices?.[0]?.finish_reason ?? null,
  };
}

function parseArguments(raw) {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/* -------------------------------------------------------------------------- */

const ADAPTERS = {
  anthropic: anthropicRequest,
  openai: openAiRequest,
};

/** The providers this build can spend. A closed set, mirroring the control plane's. */
export const AGENT_PROVIDERS = Object.freeze(Object.keys(ADAPTERS));

/**
 * One model call.
 *
 * @param {string} provider "anthropic" | "openai"
 * @param {{model: string, system: string, messages: Array, tools: Array, apiKey: string}} call
 * @param {{fetchImpl?: Function}} [options]
 */
export async function requestCompletion(provider, call, options = {}) {
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new ProviderError("unknown provider");
  const fetchImpl = options.fetchImpl || ((...args) => globalThis.fetch(...args));
  return await adapter(call, fetchImpl);
}

/** The model this deployment uses for a provider, unless the caller named one. */
export function modelFor(provider, env, requested) {
  if (typeof requested === "string" && requested.length > 0 && requested.length <= 128) {
    return requested;
  }
  const configured =
    provider === "anthropic" ? env?.AGENT_ANTHROPIC_MODEL : env?.AGENT_OPENAI_MODEL;
  return typeof configured === "string" && configured.length > 0
    ? configured
    : DEFAULT_MODELS[provider];
}
