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
 * Neither is the customer's key. A person's own connected account never comes
 * here (`providers.js` spends it directly), and nothing in this file can be
 * pointed elsewhere by a caller: the address is built from two configured ids
 * that are checked against a strict shape, never from a request.
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
 * As in `providers.js`: what a provider sends back on an error can quote the
 * request, so no body text ever reaches an error, a log line or the caller.
 * The one thing read from an error body is whether it says the credit balance
 * is too low, and that is reduced to a boolean before anything else happens.
 *
 * Self-hosting: with none of this configured there is no gateway, and the
 * built-in model is the Workers AI one as before (`builtin.js`).
 */

import { ProviderError, anthropicMessages } from "./providers.js";

/** The Anthropic API version this build is written against. */
const ANTHROPIC_VERSION = "2023-06-01";

/** How much of the model's answer one round may produce. */
const MAX_OUTPUT_TOKENS = 2048;

/** How long one round may take before it is abandoned. */
const ROUND_TIMEOUT_MS = 60_000;

/** The largest answer this worker will read, as in `providers.js`. */
const RESPONSE_BYTE_CAP = 2_000_000;

/**
 * Once the plan's credit has run out, how long calls skip it before trying it
 * again. It refills monthly, so retrying it on every round would only double
 * every call's latency until then.
 */
const CREDIT_REST_MS = 15 * 60_000;

/** Statuses after which a call with the credit key is retried without it. */
const RETRY_WITHOUT_KEY = new Set([400, 401, 402, 403]);

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
    url: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/anthropic/v1/messages`,
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
function metadataHeader(metadata) {
  const entries = Object.entries(metadata || {})
    .filter(([key, value]) => /^[a-z]{1,32}$/.test(key) && typeof value === "string" && /^[\w.:-]{1,128}$/.test(value))
    .slice(0, 5);
  return entries.length > 0 ? { "cf-aig-metadata": JSON.stringify(Object.fromEntries(entries)) } : {};
}

/**
 * The request body, with prompt caching on the parts every round repeats: the
 * tool list, the system prompt, and the conversation so far. A turn is several
 * rounds over a growing transcript, so each round reads the previous one's
 * prefix from cache at a tenth of the price.
 */
export function gatewayBody({ model, system, messages, tools }) {
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
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: wire,
    ...(system ? { system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] } : {}),
    ...(toolList.length > 0 ? { tools: toolList } : {}),
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

async function send(config, body, { withKey, metadata }, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROUND_TIMEOUT_MS);
  try {
    return await fetchImpl(config.url, {
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
  } catch {
    // The caught error can quote the request, headers included.
    throw new ProviderError("gateway request failed");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One round through the gateway, in the shape `requestCompletion` returns,
 * plus token counts and who paid: `"credit"` (the plan) or `"cloudflare"`.
 *
 * @param {{model: string, system: string, messages: Array, tools: Array}} call
 * @param {{url: string, token: string, creditKey: ?string}} config
 * @param {{metadata?: object, fetchImpl?: Function, now?: () => number}} [options]
 */
export async function requestViaGateway(call, config, options = {}) {
  if (!config) throw new ProviderError("gateway not configured");
  if (!isGatewayModel(call.model)) throw new ProviderError("model not allowed");
  const fetchImpl = options.fetchImpl || ((...args) => globalThis.fetch(...args));
  const now = options.now || Date.now;
  const body = gatewayBody(call);

  let paidBy = "cloudflare";
  let response;
  if (config.creditKey && now() >= creditRestingUntil) {
    response = await send(config, body, { withKey: true, metadata: options.metadata }, fetchImpl);
    if (response?.status === 200) {
      paidBy = "credit";
    } else if (RETRY_WITHOUT_KEY.has(response?.status)) {
      const text = await readCapped(response);
      // A spent credit rests until it is worth asking again. Any other refusal
      // of the key (revoked, wrong organization) is retried without it once,
      // so a broken key costs a slower answer rather than no answer.
      if (saysCreditSpent(text) || response.status === 402) creditRestingUntil = now() + CREDIT_REST_MS;
      response = null;
    } else {
      throw new ProviderError(`status ${response?.status ?? "none"}`, response?.status ?? null);
    }
  }
  if (!response) {
    response = await send(config, body, { withKey: false, metadata: options.metadata }, fetchImpl);
  }
  if (!response || response.status !== 200) {
    throw new ProviderError(`status ${response?.status ?? "none"}`, response?.status ?? null);
  }

  const text = await readCapped(response);
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
    stop: parsed.stop_reason ?? null,
    usage: {
      input: count(usage.input_tokens),
      output: count(usage.output_tokens),
      cacheRead: count(usage.cache_read_input_tokens),
      cacheWrite: count(usage.cache_creation_input_tokens),
    },
    paidBy,
  };
}
