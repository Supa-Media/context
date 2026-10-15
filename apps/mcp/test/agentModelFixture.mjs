/**
 * The built-in model as the agent tests drive it: Claude through our AI
 * gateway (`src/agent/aiGateway.js`), answering in Anthropic's Messages shape.
 *
 * Every turn runs on the built-in model since people's own keys were deleted
 * (decided by the owner, 2026-10-10), so a test that scripts a model scripts
 * this one: a deployment with a gateway, a workspace the control plane stub
 * lets spend it, and a fake answering at the gateway's address. All values are
 * fake and shaped like nothing real.
 */

/** A deployment's gateway. No credit key, so every round is one request. */
export const AI_GATEWAY_ENV = Object.freeze({
  AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  AI_GATEWAY_ID: "context-gw",
  AI_GATEWAY_TOKEN: "gateway-token-fixture-0000000000",
});

/** Where the gateway's requests go; a fake model claims this prefix. */
export const AI_GATEWAY_ORIGIN = "https://gateway.ai.cloudflare.com/";

/** The model a gateway deployment's turns run on, as it goes over the wire. */
export const GATEWAY_WIRE_MODEL = "claude-haiku-5-5";

/** What the control plane stub answers for a workspace that may spend it. */
export const BUILTIN_ALLOWED = Object.freeze({ allowed: true, remaining: 1000 });

/** The system prompt a gateway request carried, as one string. */
export function systemText(body) {
  const system = body?.system;
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return system.map((block) => block?.text ?? "").join("\n");
  return "";
}
