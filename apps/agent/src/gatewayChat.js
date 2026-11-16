/**
 * What the gateway's TexChat (`apps/mcp/src/texChat.js`) runs of this Worker's chat code: the chat object, the move's
 * copy, and the line reached over this Worker's RPC. A JavaScript door with its own declarations
 * (`gatewayChat.d.ts`), so a program that type-checks the gateway's JavaScript (the desktop app's tests read the
 * gateway's tool list) reads those and not this Worker's TypeScript, which only this Worker's own config checks.
 * Wrangler's bundler, and the gateway's tests (`apps/mcp/test/tsHook.mjs`), follow it into the TypeScript.
 */
export { SenderInbox } from "./chatObject";
export { arrive } from "./inboxMove";
export { remoteLine, remoteGroupLine } from "./remoteLine";
// A Lab test chat's object starts as the real chat's is once Tex answered in it: set up for the people it was texted in front of.
export { setChatBound } from "./groupChat";
