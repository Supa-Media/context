/**
 * The built-in model: the only model a turn runs on, for a texting or routine
 * grant on a Premium workspace ("Premium, capped", decided by the owner,
 * 2026-10-06; people's own keys were deleted on 2026-10-10).
 *
 * This file only makes the call. Whether a turn may make it is the control
 * plane's (`apps/convex/functions/builtinModel.ts`), through the same switches
 * and meter as every other paid inference feature, and it is asked before the
 * first round. A self-hosted gateway with neither an `AI` binding nor an AI
 * gateway has no built-in model, and every turn is refused as `no_provider`.
 *
 * ## The model is ours to pick, never the caller's
 *
 * It is our bill, so `/agent` takes no `model` from a request: otherwise a
 * caller could point a capped cheap turn at the most expensive model on the
 * account. The default can be changed per deployment with
 * `AGENT_BUILTIN_MODEL`, which is how the brain is swapped without a code
 * change.
 */

import { ProviderError, openAiMessages, openAiTools, readChatCompletion, parseArguments } from "./providers.js";
import { aiGatewayConfig, gatewayMetadata, isGatewayModel, requestViaGateway } from "./aiGateway.js";

/** The provider name a built-in turn carries through the loop and the response. */
export const BUILTIN_PROVIDER = "builtin";

/** GLM-4.7 Flash: tool calls, a long window, $0.06/$0.40 per million tokens. */
export const DEFAULT_BUILTIN_MODEL = "@cf/zai-org/glm-4.7-flash";

/**
 * Claude Haiku 5.5 through our AI gateway (`aiGateway.js`): the default once a
 * deployment has a gateway, because the owner found GLM too weak for texting
 * (2026-10-08) and Haiku costs about the same per question with caching on.
 */
export const DEFAULT_GATEWAY_MODEL = "anthropic/claude-haiku-5-5";

/**
 * Other providers' models from Cloudflare's model catalog (`openai/gpt-…`,
 * `google/gemini-…`), and the gateway's dynamic routes (`dynamic/<route>`,
 * which pick among models by rules, budgets and percentages set in the
 * Cloudflare dashboard). Both run on the Workers AI binding through our AI
 * gateway and are paid by Unified Billing, so no provider key exists anywhere
 * in this deployment. Claude stays on its own road (`aiGateway.js`), which
 * spends the plan's credit first.
 */
const CATALOG_MODEL =
  /^(?:(?:openai|google|xai|groq|mistral|deepseek|cerebras|perplexity)\/[a-z0-9][\w.:-]{0,80}|dynamic\/[a-z0-9][a-z0-9-]{0,63})$/;

export function isCatalogModel(model) {
  return typeof model === "string" && CATALOG_MODEL.test(model);
}

/** Any model a built-in turn or a production file may name. */
export function isBuiltinModelName(model) {
  return (typeof model === "string" && /^@cf\/[\w./-]{1,120}$/.test(model)) || isGatewayModel(model) || isCatalogModel(model);
}

/** How much of the model's answer one round may produce. */
const MAX_OUTPUT_TOKENS = 2048;

/** How long one round may take before it is abandoned. */
const ROUND_TIMEOUT_MS = 60_000;

/**
 * The model this deployment's built-in turns use: `AGENT_BUILTIN_MODEL` when
 * it names one this deployment can call, else Haiku when there is a gateway,
 * else GLM on Workers AI. A gateway or catalog model named on a deployment
 * without a gateway falls back rather than failing every turn.
 */
export function builtinModel(env) {
  const configured = env?.AGENT_BUILTIN_MODEL;
  const gateway = aiGatewayConfig(env) !== null;
  if (typeof configured === "string" && configured.startsWith("@cf/") && configured.length <= 128) return configured;
  if (gateway && isGatewayModel(configured)) return configured;
  if (gateway && isCatalogModel(configured) && typeof env?.AI?.run === "function") return configured;
  return gateway ? DEFAULT_GATEWAY_MODEL : DEFAULT_BUILTIN_MODEL;
}

/** Whether this deployment can run built-in turns at all: Workers AI, or a gateway. */
export function hasBuiltinModel(env) {
  return typeof env?.AI?.run === "function" || aiGatewayConfig(env) !== null;
}

/**
 * Whether this deployment can call `model` as a built-in turn: a `@cf/` model
 * needs the Workers AI binding, an `anthropic/` one needs the gateway, and a
 * catalog model or dynamic route needs both. Anything else is `false`, so a
 * named model this build cannot reach falls back.
 */
export function canRunBuiltin(model, env) {
  if (typeof model !== "string") return false;
  if (model.startsWith("@cf/")) return typeof env?.AI?.run === "function";
  if (isCatalogModel(model)) return typeof env?.AI?.run === "function" && aiGatewayConfig(env) !== null;
  return isGatewayModel(model) && aiGatewayConfig(env) !== null;
}

function count(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * One round on Workers AI, in the shape `providers.js` describes, plus the
 * model's own token counts for the meter.
 *
 * Reads the chat-completions shape, and the older Workers AI one
 * (`{ response, tool_calls }`) that some models still answer in. Errors are a
 * phrase only: what Workers AI throws can quote the request, which carries the
 * person's notes.
 *
 * @param {{model: string, system: string, messages: Array, tools: Array}} call
 * @param {{run: Function}} ai the Workers AI binding
 * @param {{gateway?: object, metadata?: object, fetchImpl?: Function}} [options]
 *   for a gateway model: the gateway (`aiGatewayConfig`) and the labels its
 *   cost is filed under
 */
export async function requestBuiltin({ model, system, messages, tools }, ai, options = {}) {
  if (isGatewayModel(model)) {
    return await requestViaGateway({ model, system, messages, tools }, options.gateway ?? null, options);
  }
  if (typeof ai?.run !== "function") throw new ProviderError("built-in model not configured");
  const catalog = isCatalogModel(model);
  if (catalog && typeof options.gateway?.gatewayId !== "string") throw new ProviderError("gateway not configured");
  // A catalog model goes through our gateway, unlogged, with the same labels
  // the AI costs tab files Claude's calls under.
  const metadata = catalog ? gatewayMetadata(options.metadata) : null;
  const runOptions = catalog
    ? { gateway: { id: options.gateway.gatewayId, collectLog: false, ...(metadata ? { metadata } : {}) } }
    : undefined;
  let timer;
  let raw;
  try {
    raw = await Promise.race([
      ai.run(
        model,
        {
          messages: openAiMessages(system, messages),
          ...(tools.length > 0 ? { tools: openAiTools(tools) } : {}),
          max_tokens: MAX_OUTPUT_TOKENS,
        },
        ...(runOptions ? [runOptions] : []),
      ),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), ROUND_TIMEOUT_MS);
      }),
    ]);
  } catch {
    throw new ProviderError("built-in model failed");
  } finally {
    clearTimeout(timer);
  }
  if (!raw || typeof raw !== "object") throw new ProviderError("built-in model answered nothing");

  const usage = raw.usage && typeof raw.usage === "object" ? raw.usage : {};
  // OpenAI-shaped providers count cached prompt tokens inside `prompt_tokens`;
  // they are split out so the meter prices them at the cache rate.
  const cached = Math.min(count(usage.prompt_tokens_details?.cached_tokens), count(usage.prompt_tokens));
  const counted = {
    input: count(usage.prompt_tokens) - cached,
    output: count(usage.completion_tokens),
    ...(cached > 0 ? { cacheRead: cached } : {}),
  };

  if (Array.isArray(raw.choices)) return { ...readChatCompletion(raw), usage: counted };

  const toolCalls = (Array.isArray(raw.tool_calls) ? raw.tool_calls : [])
    .filter((call) => typeof call?.name === "string")
    .map((call, index) => ({
      id: String(call.id ?? `call_${index}`),
      name: call.name,
      args: parseArguments(call.arguments),
    }));
  return {
    text: typeof raw.response === "string" ? raw.response : "",
    toolCalls,
    stop: null,
    usage: counted,
  };
}
