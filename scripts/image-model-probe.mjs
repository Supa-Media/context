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
 * Needs AI_GATEWAY_ACCOUNT_ID, AI_GATEWAY_ID and AI_GATEWAY_TOKEN.
 */

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
const message = String(body?.error?.message ?? body?.errors?.[0]?.message ?? body?.[0]?.error?.message ?? "").slice(0, 400);
console.log(`model: ${model}`);
console.log(`status: ${response.status} in ${Math.round((Date.now() - started) / 1000)}s`);
console.log(`picture: ${picture ? `yes, ${(picture.inlineData ?? picture.inline_data).data.length} base64 characters` : "no"}`);
if (body?.usageMetadata) console.log(`tokens: ${body.usageMetadata.promptTokenCount ?? 0} in, ${body.usageMetadata.candidatesTokenCount ?? 0} out`);
if (!picture) console.log(`finish: ${body?.candidates?.[0]?.finishReason ?? body?.promptFeedback?.blockReason ?? "none"}`);
if (message) console.log(`error: ${message}`);
if (!picture) process.exitCode = 1;
