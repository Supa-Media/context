/**
 * Does Tex's image model answer through our AI Gateway?
 *
 * `make_picture` (apps/mcp/src/agent/pictureMaker.js) answers "the image
 * model could not make that right now" for any failed call, by design: no
 * error body reaches the model. This asks the same endpoint for one small
 * picture of a fixed, made-up subject and prints the status and the
 * provider's error message, so a failure can be read without the Worker's
 * logs. Nothing of anyone's is sent; the token is never printed.
 *
 * **This job's log is public, because this repository is.** The provider
 * writes that error message, not us, and prose quotes identifiers — Google's
 * quota errors name the consumer as `project_number:…`, and its permission
 * errors name a `projects/…` path. So it is bounded before it is printed
 * (`safeProviderMessage`), the way the forward sync bounds its own catch-all
 * detail (`safeErrorDetail`, apps/convex/functions/lib/filesFns/
 * forwardSyncSupport.ts). What is left is the sentence saying what went
 * wrong, which is the whole reason to print it.
 *
 * Needs AI_GATEWAY_ACCOUNT_ID, AI_GATEWAY_ID and AI_GATEWAY_TOKEN.
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MAX_MESSAGE_CHARS = 400;

/**
 * A provider's error message with everything identifier-shaped cut out:
 * anything it quotes, an address, a web address, anything path-shaped, a long
 * run of digits, a long run of hex. A quote only counts where one opens — an
 * apostrophe inside a word is not one, and the 403 that sent us looking here
 * ("Method doesn't allow unregistered callers") is the whole diagnosis.
 */
export function safeProviderMessage(message) {
  return String(message ?? "")
    .replace(/(^|[\s(])(["'`])[\s\S]*?\2(?=[\s).,;:]|$)/g, "$1…")
    .replace(/\b[\w.+-]+@[\w.-]+\b/g, "…")
    .replace(/\bhttps?:\/\/\S+/gi, "…")
    .replace(/\S*[\\/]\S*/g, "…")
    .replace(/\b\d{5,}\b/g, "…")
    .replace(/\b[0-9a-f]{16,}\b/gi, "…")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MESSAGE_CHARS);
}

async function probe() {
  const { AI_GATEWAY_ACCOUNT_ID: account, AI_GATEWAY_ID: gateway, AI_GATEWAY_TOKEN: token } = process.env;
  const model = process.env.IMAGE_MODEL || "gemini-2.5-flash-image";
  if (!account || !gateway || !token) throw new Error("AI_GATEWAY_ACCOUNT_ID, AI_GATEWAY_ID and AI_GATEWAY_TOKEN are required");
  if (!/^gemini-[a-z0-9.-]{1,60}$/.test(model)) throw new Error("IMAGE_MODEL must be a Gemini model id");

  const started = Date.now();
  const response = await fetch(`https://gateway.ai.cloudflare.com/v1/${account}/${gateway}/google-ai-studio/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-aig-authorization": `Bearer ${token}`, "cf-aig-collect-log": "false" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "A small red paper boat on a blue table, studio photo." }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "1:1" } },
    }),
  });
  const body = await response.json().catch(() => null);
  const parts = body?.candidates?.[0]?.content?.parts ?? [];
  const picture = parts.find((part) => (part.inlineData ?? part.inline_data)?.data);
  const message = safeProviderMessage(body?.error?.message ?? body?.errors?.[0]?.message ?? body?.[0]?.error?.message);
  console.log(`model: ${model}`);
  console.log(`status: ${response.status} in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`picture: ${picture ? `yes, ${(picture.inlineData ?? picture.inline_data).data.length} base64 characters` : "no"}`);
  if (body?.usageMetadata) console.log(`tokens: ${body.usageMetadata.promptTokenCount ?? 0} in, ${body.usageMetadata.candidatesTokenCount ?? 0} out`);
  if (!picture) console.log(`finish: ${body?.candidates?.[0]?.finishReason ?? body?.promptFeedback?.blockReason ?? "none"}`);
  if (message) console.log(`error: ${message}`);
  if (!picture) process.exitCode = 1;
}

const invoked = process.argv[1] && realpathSync(process.argv[1]);
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  await probe();
}
