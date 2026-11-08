/**
 * Does Tex's AI Gateway path take Anthropic's per-message effort beta?
 *
 * Sends four small Messages requests to claude-haiku-5-5 through the same
 * gateway URL and headers the bench uses (`claudeTransport`,
 * apps/mcp/bench/models.mjs): two with anthropic-version 2023-06-01, then two
 * with 2026-10-21 (the version the docs example uses,
 * https://platform.claude.com/docs/en/build-with-claude/effort, "Change effort
 * mid-conversation"). Each pair shares a cached system prefix, so the second
 * call of a pair should show a cache read. Every body ends with the
 * effort-only system message `advisorFirst.js` sends.
 *
 * Prints only status, the error type and a bounded error message
 * (`safeProviderMessage`), the usage numbers and whether the effort field was
 * accepted. No reply text is printed, and no secret.
 *
 * Needs AI_GATEWAY_ACCOUNT_ID, AI_GATEWAY_ID and AI_GATEWAY_TOKEN;
 * ANTHROPIC_CREDIT_KEY is sent when set (otherwise Unified Billing pays).
 * There is no retry without the key, so it is always four requests.
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { safeProviderMessage } from "./image-model-probe.mjs";

export const MODEL = "claude-haiku-5-5";
export const BETA = "mid-conversation-output-config-2026-07-01";
export const VERSIONS = ["2023-06-01", "2026-10-21"];

// lean: a fixed filler prefix, long enough for Haiku's minimum cacheable length.
const PREFIX = "This is a fixed cache probe prefix with no meaning. ".repeat(700);

export function probeBody() {
  return {
    model: MODEL,
    max_tokens: 16,
    system: [{ type: "text", text: PREFIX, cache_control: { type: "ephemeral" } }],
    messages: [
      { role: "user", content: "Reply with the word ok." },
      { role: "system", content: [], output_config: { effort: "low" } },
    ],
  };
}

/** One printable line for a response: never the reply's content. */
export function summaryLine(label, status, body) {
  const usage = body?.usage ?? {};
  const message = safeProviderMessage(body?.error?.message ?? body?.errors?.[0]?.message);
  const effort = status === 200 ? "yes" : /output_config|per-turn effort/i.test(message) ? "no" : "unknown";
  return [
    `${label}: status ${status}`,
    `effort accepted ${effort}`,
    `input ${usage.input_tokens ?? "-"}`,
    `cache_read ${usage.cache_read_input_tokens ?? "-"}`,
    `cache_creation ${usage.cache_creation_input_tokens ?? "-"}`,
    `output ${usage.output_tokens ?? "-"}`,
    ...(body?.error?.type ? [`error type ${body.error.type}`] : []),
    ...(message ? [`error ${message}`] : []),
  ].join(", ");
}

async function probe() {
  const { AI_GATEWAY_ACCOUNT_ID: account, AI_GATEWAY_ID: gateway, AI_GATEWAY_TOKEN: token, ANTHROPIC_CREDIT_KEY: key } = process.env;
  if (!account || !gateway || !token) throw new Error("AI_GATEWAY_ACCOUNT_ID, AI_GATEWAY_ID and AI_GATEWAY_TOKEN are required");
  const url = `https://gateway.ai.cloudflare.com/v1/${account}/${gateway}/anthropic/v1/messages`;
  let failed = false;
  for (const version of VERSIONS) {
    for (const call of [1, 2]) {
      const headers = {
        "content-type": "application/json",
        "anthropic-version": version,
        "anthropic-beta": BETA,
        "cf-aig-authorization": `Bearer ${token}`,
        "cf-aig-collect-log": "false",
        "cf-aig-metadata": JSON.stringify({ feature: "benchmark" }),
        ...(key ? { "x-api-key": key } : {}),
      };
      const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(probeBody()) });
      const body = await response.json().catch(() => null);
      console.log(summaryLine(`version ${version} call ${call}`, response.status, body));
      if (response.status !== 200) failed = true;
    }
  }
  if (failed) process.exitCode = 1;
}

const invoked = process.argv[1] && realpathSync(process.argv[1]);
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  await probe();
}
