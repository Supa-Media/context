/**
 * ONE ROAD FOR THE MODELS WE PAY FOR: CLOUDFLARE'S AI GATEWAY.
 *
 * Decided by the owner, 2026-10-08: every model call on our bill goes through
 * one gateway, and the free API credit that comes with the owner's Claude plan
 * is spent before anything that costs money. So a Claude call here is made
 * twice at most:
 *
 * 1. With `ANTHROPIC_CREDIT_KEY` — the key of the Claude Console organization
 *    that holds the plan's monthly credit.
 * 2. Without it, when Anthropic says that credit is used up (or the key is
 *    gone). AI Gateway then serves the call on Cloudflare's Unified Billing,
 *    paid from the credit balance on our Cloudflare account. Credential
 *    precedence is the gateway's documented order: a key on the request wins,
 *    and no key means Unified Billing.
 *
 * Neither is the customer's key: people's own keys were deleted (the owner,
 * 2026-10-10). Nothing in this file can be pointed elsewhere by a caller: the
 * address is built from two configured ids that are checked against a strict
 * shape, never from a request.
 *
 * ## Notes never stay in Cloudflare's logs
 *
 * A turn's messages carry the person's notes. AI Gateway keeps a copy of every
 * request and response in its log unless told not to, and that log is an
 * account of ours — which would make it a place customer content lives outside
 * their bucket. So every call says `cf-aig-collect-log: false`. Spend is
 * counted from the token counts the answer carries, in our own meter, not read
 * back from the gateway's log.
 *
 * ## Errors are phrases
 *
 * What a provider sends back on an error can quote the request, so no body
 * text ever reaches an error, a log line or the caller.
 * The one thing read from an error body is whether it says the credit balance
 * is too low, and that is reduced to a boolean before anything else happens.
 *
 * Self-hosting: with none of this configured there is no gateway, and the
 * built-in model is the Workers AI one as before (`builtin.js`).
 */

import { ProviderError, anthropicMessages } from "./providers.js";

/** The Anthropic API version this build is written against. */
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * How much one round may produce: the models' own ceiling (128K output on
 * every Claude 5.5 model). `max_tokens` caps the thinking *and* the answer
 * together, and tokens are billed as used, not as allowed, so a lower cap
 * only cuts a round off mid-thought. The owner, 2026-10-14: "I see no reason
 * why we are capping it less than the allowed 128K". The round's deadline
 * (`ROUND_TIMEOUT_MS`) is what bounds a runaway round, and a cut-off one is
 * marked in the turn log (`cut`, `turn.js`).
 */
const MAX_OUTPUT_TOKENS = 128_000;

/** The most a caller may ask for with `maxTokens`: the same ceiling. */
const MAX_CALLER_OUTPUT_TOKENS = MAX_OUTPUT_TOKENS;

/** How hard a model thinks (`output_config.effort`), when a setup says (`production.js`). */
export const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** The answer blocks a later round hands back unchanged: thinking, and what it led to. */
const REPLAYED_BLOCKS = new Set(["thinking", "redacted_thinking", "text", "tool_use"]);

/** How long one round may take before it is abandoned. */
const ROUND_TIMEOUT_MS = 60_000;

/** The largest answer this worker will read. */
const RESPONSE_BYTE_CAP = 2_000_000;

/**
 * Once the plan's credit has run out, how long calls skip it before trying it
 * again. It refills monthly, so retrying it on every round would only double
 * every call's latency until then.
 */
const CREDIT_REST_MS = 15 * 60_000;

/**
 * Statuses that mean the key itself was refused, after which a call is retried
 * once without it. A 400 is not one of them unless it says the credit is
 * spent: an ordinary bad request would only fail twice.
 */
const RETRY_WITHOUT_KEY = new Set([401, 403]);

/**
 * Statuses that mean the provider was busy rather than wrong (rate limited,
 * unavailable, overloaded), after which the same call is sent once more after
 * a short wait. Decided by the owner (2026-10-09): a benchmark run lost 29 of
 * 708 answers to these in one evening, and the person texting gets the same.
 * A 500 is not one of them: it says the request itself broke, and would only
 * fail twice. A timed-out call is not retried either: it has already cost the
 * round its whole deadline.
 */
const RETRY_BUSY = new Set([429, 503, 529]);
const RETRY_WAIT_MS = 750;

const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const GATEWAY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A model this road can call, as `AGENT_BUILTIN_MODEL` or a production file names it. */
const GATEWAY_MODEL = /^anthropic\/claude-[a-z0-9.-]{1,64}$/;

export function isGatewayModel(model) {
  return typeof model === "string" && GATEWAY_MODEL.test(model);
}

/**
 * This deployment's gateway, or `null` when it has none. All three of the
 * account, the gateway and its token are required; the credit key is optional
 * (without it every call is Unified Billing).
 */
export function aiGatewayConfig(env) {
  const accountId = env?.AI_GATEWAY_ACCOUNT_ID;
  const gatewayId = env?.AI_GATEWAY_ID;
  const token = env?.AI_GATEWAY_TOKEN;
  if (typeof accountId !== "string" || !ACCOUNT_ID.test(accountId)) return null;
  if (typeof gatewayId !== "string" || !GATEWAY_ID.test(gatewayId)) return null;
  if (typeof token !== "string" || token.length < 20 || token.length > 512) return null;
  const creditKey = env?.ANTHROPIC_CREDIT_KEY;
  return {
    gatewayId,
    url: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/anthropic/v1/messages`,
    // The same gateway's other providers hang off this (`pictureMaker.js`: Google's image model).
    base: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}`,
    token,
    creditKey: typeof creditKey === "string" && creditKey.length >= 20 && creditKey.length <= 512 ? creditKey : null,
  };
}

/** Per isolate: until when the plan's credit is known to be used up. */
let creditRestingUntil = 0;

/** For tests: forget that the credit ran out. */
export function resetCreditState() {
  creditRestingUntil = 0;
}

function count(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Up to five labels the gateway files the call's cost under. Ids only, never
 * text: they are what the AI costs tab groups by.
 */
export function gatewayMetadata(metadata) {
  const entries = Object.entries(metadata || {})
    .filter(([key, value]) => /^[a-z]{1,32}$/.test(key) && typeof value === "string" && /^[\w.:-]{1,128}$/.test(value))
    .slice(0, 5);
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

export function metadataHeader(metadata) {
  const labels = gatewayMetadata(metadata);
  return labels ? { "cf-aig-metadata": JSON.stringify(labels) } : {};
}

/**
 * The request body, with prompt caching on the parts every round repeats: the
 * tool list, the system prompt, and the conversation so far. A turn is several
 * rounds over a growing transcript, so each round reads the previous one's
 * prefix from cache at a tenth of the price.
 */
/**
 * The models that think by default (every Claude 5 model), where asking for
 * the thinking in words changes only what comes back, never whether or how
 * hard it thinks. An older model that thinks only when asked is never sent it.
 */
const THINKS_BY_DEFAULT = /^anthropic\/claude-(?:haiku|sonnet|opus|fable|mythos)-5(?:-\d+)?$/;

/** `thinking.display`: "summarized" returns the thinking in words (`transcript.js`); the default leaves it empty. */
const DISPLAYS = new Set(["summarized"]);

export function gatewayBody({ model, system, messages, tools, maxTokens, toolChoice, effort, display }) {
  const toolList = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema || { type: "object" },
  }));
  if (toolList.length > 0) toolList[toolList.length - 1].cache_control = { type: "ephemeral" };
  const wire = anthropicMessages(messages);
  const last = wire[wire.length - 1];
  if (last && Array.isArray(last.content) && last.content.length > 0) {
    const blocks = [...last.content];
    blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: "ephemeral" } };
    wire[wire.length - 1] = { ...last, content: blocks };
  }
  return {
    model: model.slice("anthropic/".length),
    // A caller may ask for more room (a meeting summary is one long answer), never unbounded.
    max_tokens: Number.isInteger(maxTokens) && maxTokens > 0 ? Math.min(maxTokens, MAX_CALLER_OUTPUT_TOKENS) : MAX_OUTPUT_TOKENS,
    messages: wire,
    ...(system ? { system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] } : {}),
    ...(toolList.length > 0 ? { tools: toolList } : {}),
    // Only ever "call this one tool", and only a tool this request offers.
    ...(typeof toolChoice === "string" && toolList.some((tool) => tool.name === toolChoice)
      ? { tool_choice: { type: "tool", name: toolChoice } }
      : {}),
    ...(EFFORTS.has(effort) ? { output_config: { effort } } : {}),
    ...(DISPLAYS.has(display) && THINKS_BY_DEFAULT.test(model) ? { thinking: { type: "adaptive", display } } : {}),
  };
}

async function readCapped(response) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > RESPONSE_BYTE_CAP) return null;
  try {
    const text = await response.text();
    return text.length > RESPONSE_BYTE_CAP ? null : text;
  } catch {
    return null;
  }
}

/** Whether an error body says the credit balance is spent. A boolean, nothing else. */
function saysCreditSpent(text) {
  if (typeof text !== "string") return false;
  try {
    const message = JSON.parse(text)?.error?.message;
    return typeof message === "string" && /credit balance/i.test(message);
  } catch {
    return false;
  }
}

/**
 * One POST, with the round's deadline covering the body as well as the
 * headers: a provider that trickles its answer must not hold the turn past
 * the timeout. Returns `{ status, text }`, the text capped and `null` when
 * unreadable.
 */
async function send(config, body, { withKey, metadata }, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROUND_TIMEOUT_MS);
  try {
    let response;
    try {
      response = await fetchImpl(config.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": ANTHROPIC_VERSION,
          "cf-aig-authorization": `Bearer ${config.token}`,
          "cf-aig-collect-log": "false",
          ...metadataHeader(metadata),
          // The plan's key appears here and nowhere else.
          ...(withKey ? { "x-api-key": config.creditKey } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: "manual",
      });
    } catch (error) {
      // The caught error can quote the request, headers included. A deadline
      // that ran out is named as such, so it is not retried.
      const timedOut = controller.signal.aborted || error?.name === "AbortError";
      throw new ProviderError(timedOut ? "gateway timed out" : "gateway request failed");
    }
    const status = response?.status ?? null;
    // The body's type rides along for `refusalDetail`: a refusal with no words still says who sent it.
    return { status, text: response ? await readCapped(response) : null, type: response?.headers?.get?.("content-type") ?? null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `send`, once more after `RETRY_WAIT_MS` when the first try found the
 * provider busy or never got through. `retried` is null when the first try
 * served, else `{ status }` of the try that was retried (null for a request
 * that never got a status), so the turn's trace can say so.
 */
async function sendWithRetry(config, body, options, fetchImpl, wait) {
  let first;
  try {
    first = await send(config, body, options, fetchImpl);
  } catch (error) {
    if (!(error instanceof ProviderError) || error.reason !== "gateway request failed") throw error;
    await wait(RETRY_WAIT_MS);
    return { ...(await send(config, body, options, fetchImpl)), retried: { status: null } };
  }
  if (!RETRY_BUSY.has(first.status)) return { ...first, retried: null };
  await wait(RETRY_WAIT_MS);
  return { ...(await send(config, body, options, fetchImpl)), retried: { status: first.status } };
}

/** Longest `providerDetail` kept: enough for Anthropic's sentence on what it refused. */
const DETAIL_CHARS = 300;

/**
 * Why the provider refused a request, in its own words, cut to
 * `DETAIL_CHARS`: Anthropic's `{ error: { type, message } }`, the AI
 * gateway's own `{ errors: [{ code, message }] }` (or `error` as that list),
 * else the start of whatever the body was; null for no body. These words can
 * quote the request, so `ProviderError.detail` keeps them off every log (see
 * there).
 */
export function providerDetail(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: the start of the body is all there is to go on.
  }
  const listed = [parsed?.errors, parsed?.error].find(Array.isArray);
  const said = listed
    ? listed.map((entry) => [entry?.code, entry?.message].filter((part) => part !== undefined && part !== null && part !== "").join(": ")).filter(Boolean).join("; ")
    : typeof parsed?.error?.message === "string"
      ? [parsed.error.type, parsed.error.message].filter((part) => typeof part === "string" && part).join(": ")
      : text;
  const line = said.replace(/\s+/g, " ").trim();
  if (!line) return null;
  return line.length > DETAIL_CHARS ? `${line.slice(0, DETAIL_CHARS - 1)}…` : line;
}

/** `providerDetail`, or what can be said of a refusal with no readable body. */
function refusalDetail(answer) {
  return providerDetail(answer.text) ?? `${answer.text === null ? "no body read" : "empty body"} (${answer.type ?? "no content-type"})`;
}

/**
 * One round through the gateway, in the shape `providers.js` describes,
 * plus token counts and who paid: `"credit"` (the plan) or `"cloudflare"`.
 *
 * @param {{model: string, system: string, messages: Array, tools: Array}} call
 * @param {{url: string, token: string, creditKey: ?string}} config
 * @param {{metadata?: object, fetchImpl?: Function, now?: () => number, wait?: (ms: number) => Promise<void>}} [options]
 */
export async function requestViaGateway(call, config, options = {}) {
  if (!config) throw new ProviderError("gateway not configured");
  if (!isGatewayModel(call.model)) throw new ProviderError("model not allowed");
  const fetchImpl = options.fetchImpl || ((...args) => globalThis.fetch(...args));
  const now = options.now || Date.now;
  const wait = options.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const body = gatewayBody(call);

  let paidBy = "cloudflare";
  let answer = null;
  if (config.creditKey && now() >= creditRestingUntil) {
    answer = await sendWithRetry(config, body, { withKey: true, metadata: options.metadata }, fetchImpl, wait);
    if (answer.status === 200) {
      paidBy = "credit";
    } else if (saysCreditSpent(answer.text) || answer.status === 402) {
      // The plan's credit is used up: rest it until it is worth asking again.
      creditRestingUntil = now() + CREDIT_REST_MS;
      answer = null;
    } else if (RETRY_WITHOUT_KEY.has(answer.status)) {
      // The key itself was refused (revoked, wrong organization): retried
      // without it, so a broken key costs a slower answer, never no answer.
      answer = null;
    } else {
      throw new ProviderError(`status ${answer.status ?? "none"}`, answer.status, refusalDetail(answer));
    }
  }
  if (!answer) {
    answer = await sendWithRetry(config, body, { withKey: false, metadata: options.metadata }, fetchImpl, wait);
  }
  if (answer.status !== 200) {
    throw new ProviderError(`status ${answer.status ?? "none"}`, answer.status, refusalDetail(answer));
  }

  const text = answer.text;
  if (text === null) throw new ProviderError("response too large", 200);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProviderError("response not json", 200);
  }
  if (!parsed || typeof parsed !== "object") throw new ProviderError("response not json", 200);

  const blocks = Array.isArray(parsed.content) ? parsed.content : [];
  const usage = parsed.usage && typeof parsed.usage === "object" ? parsed.usage : {};
  return {
    text: blocks
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join(""),
    toolCalls: blocks
      .filter((block) => block?.type === "tool_use" && typeof block.name === "string")
      .map((block) => ({
        id: String(block.id ?? ""),
        name: block.name,
        args: block.input && typeof block.input === "object" && !Array.isArray(block.input) ? block.input : {},
      })),
    // The round's own blocks, thinking first, when it thought: the next round
    // hands them back exactly as they came (`providers.js`), so the model keeps
    // its reasoning across tool calls instead of starting over each round.
    content: blocks.some((block) => block?.type === "thinking" || block?.type === "redacted_thinking")
      ? blocks.filter((block) => REPLAYED_BLOCKS.has(block?.type))
      : null,
    stop: parsed.stop_reason ?? null,
    usage: {
      input: count(usage.input_tokens),
      output: count(usage.output_tokens),
      cacheRead: count(usage.cache_read_input_tokens),
      cacheWrite: count(usage.cache_creation_input_tokens),
    },
    paidBy,
    retried: answer.retried ?? null,
  };
}
