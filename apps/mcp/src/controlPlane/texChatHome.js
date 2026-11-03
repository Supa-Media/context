/**
 * Whether a group chat's home is in the workspace an access token reads (the control plane's
 * `lib/gatewayRoutes/texChatHome.ts`), asked before a person's store opens that chat's Durable Object
 * (`store/texRouting.js`, `homeChat`). Only `{ home: true }` is a yes; anything else, a failure included, is no.
 */
export function createTexChatHomeMethods({ post }) {
  return {
    async texChatHome(accessToken, workspaceId, chat) {
      try {
        const parsed = await post("/gateway/tex/chat-home", { accessToken, workspaceId, chat });
        return parsed?.home === true;
      } catch {
        return false;
      }
    },
  };
}
