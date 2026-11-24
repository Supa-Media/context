/**
 * What the gateway's Lab test chats (`apps/mcp/src/labSandbox/inbound.js`) run of this Worker's inbound code, so a test
 * picture, quoted reply or tapback is turned into its ledger event and its `/agent` body by the same code a real one
 * is: what kind of part it is (`events.ts` `kindOf`), a tapback's line and whether it is answered (`reactions.ts`,
 * `thumbs.ts`), and the pictures as the gateway takes them (`attachments.ts` `prepareAttachments`).
 *
 * A JavaScript door with its own declarations (`gatewayInbound.d.ts`), as `gatewayChat.js` is: Wrangler's bundler and
 * the gateway's tests (`apps/mcp/test/tsHook.mjs`) follow it into the TypeScript.
 */
export { kindOf } from "./events";
export { answers, EMOJI, reactionLine, tapbackText } from "./reactions";
export { holdsAsAnswer, onMachineAsk } from "./thumbs";
export { prepareAttachments } from "./attachments";
export { filesFor, MAX_GROUP_FILES } from "./groupInbox";
export { PICTURE_LINE } from "./groupLines";
export { MAX_QUOTED_TEXT } from "./sendblue";
export { EFFECT_NAMES, richWords } from "./photonRich";
