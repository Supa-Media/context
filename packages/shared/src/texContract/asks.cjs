/**
 * Held asks, as both sides name them: the gateway keeps them (`apps/mcp/src/tools/approvals.js`) and settles them
 * (`apps/mcp/src/tools/texAsks.js`); Tex reads and answers them only through the `tex_asks` action
 * (`packages/tex/gateway/asks.js`).
 */

/** The Context-side action Tex settles, arms and disarms its held asks with. Never advertised, never a model's. */
const TEX_ASKS_TOOL = "tex_asks";
/** A texted ask listens for a yes at most this long (`approvals.js` `TEXTING_TTL_MS`). */
const TEXTING_TTL_MS = 12 * 60 * 60 * 1000;
/** A texted listing that reaches every chat (`approvals.js` `listPending`): what only the sweeping disarms ask for. */
const EVERY_CHAT = Symbol.for("context.asks.every_chat");
/** A card's payment ask (`apps/mcp/src/vault/pay.js`). */
const VAULT_PAY = "vault_pay";

module.exports = { TEX_ASKS_TOOL, TEXTING_TTL_MS, EVERY_CHAT, VAULT_PAY };
