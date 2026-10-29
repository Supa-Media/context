/**
 * `sign_out_browser`: "SIGN TEX OUT" OF EVERY SITE.
 *
 * Tex's browser keeps its sign-ins in a saved Browserbase profile and, sealed,
 * in the person's vault (`browserProfile.js`, `browserJar.js`; the owner,
 * 2026-10-29). This lets the browser go, releases the profile at Browserbase
 * and drops the jar, so the next browser starts signed out of everything. A
 * group chat's turn signs out the chat's browser, never a person's own.
 */

export const SIGN_OUT_BROWSER_TOOL = "sign_out_browser";

export const SIGN_OUT_BROWSER_DEFINITION = {
  name: SIGN_OUT_BROWSER_TOOL,
  description:
    "Sign your browser out of every site: deletes its saved profile and the sign-ins kept for it, so the next browser starts signed out. " +
    "Only when the person asks you to sign out of everything or forget your sign-ins; to sign out of one site, use that site's own sign-out with send action browse.",
  inputSchema: { type: "object", properties: {} },
  annotations: { destructiveHint: true, openWorldHint: true },
};

function text(value, isError = false) {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

export function signOutBrowserTool(computer) {
  return {
    definition: SIGN_OUT_BROWSER_DEFINITION,
    async call() {
      const { signedOut } = await computer.signOut();
      return signedOut
        ? text("Signed out: your browser's saved profile and kept sign-ins are deleted. The next browser starts signed out of every site.")
        : text("Not everything could be deleted just now; try sign_out_browser again in a minute.", true);
    },
  };
}
