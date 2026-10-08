/**
 * The built-in model: a cheap open model on Workers AI, for a texting grant on
 * a Premium workspace that connected no model account of its own ("Premium,
 * capped", decided by the owner, 2026-10-06).
 *
 * This file only makes the call. Whether a turn may make it is the control
 * plane's (`apps/convex/functions/builtinModel.ts`), through the same switches
 * and meter as every other paid inference feature, and it is asked before the
 * first round. A self-hosted gateway with no `AI` binding has no built-in model,
 * and the turn is refused exactly as "no account connected".
 *
 * ## The model is ours to pick, never the caller's
 *
 * `/agent` takes a `model` for a person's own key, because it is their bill.
 * Here it is ours, so a named model is ignored: otherwise a caller could point
 * a capped cheap turn at the most expensive model on the account. The default
 * can be changed per deployment with `AGENT_BUILTIN_MODEL`, which is how the
 * brain is swapped without a code change.
 */

import { ProviderError, openAiMessages, openAiTools, readChatCompletion, parseArguments } from "./providers.js";
import { aiGatewayConfig, isGatewayModel, requestViaGateway } from "./aiGateway.js";

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

/** How much of the model's answer one round may produce. */
const MAX_OUTPUT_TOKENS = 2048;

/** How long one round may take before it is abandoned. */
const ROUND_TIMEOUT_MS = 60_000;

/**
 * The model this deployment's built-in turns use: `AGENT_BUILTIN_MODEL` when
 * it names one this deployment can call, else Haiku when there is a gateway,
 * else GLM on Workers AI. A gateway model named on a deployment without a
 * gateway falls back rather than failing every turn.
 */
export function builtinModel(env) {
  const configured = env?.AGENT_BUILTIN_MODEL;
  const gateway = aiGatewayConfig(env) !== null;
  if (typeof configured === "string" && configured.startsWith("@cf/") && configured.length <= 128) return configured;
  if (gateway && isGatewayModel(configured)) return configured;
  return gateway ? DEFAULT_GATEWAY_MODEL : DEFAULT_BUILTIN_MODEL;
}

/** Whether this deployment can run built-in turns at all. */
export function hasBuiltinModel(env) {
  return typeof env?.AI?.run === "function";
}

function count(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * One round on Workers AI, in the same shape as `requestCompletion`, plus the
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
  let timer;
  let raw;
  try {
    raw = await Promise.race([
      ai.run(model, {
        messages: openAiMessages(system, messages),
        ...(tools.length > 0 ? { tools: openAiTools(tools) } : {}),
        max_tokens: MAX_OUTPUT_TOKENS,
      }),
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
  const counted = { input: count(usage.prompt_tokens), output: count(usage.completion_tokens) };

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
