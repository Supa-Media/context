/**
 * Whether a turn has a browser, read from the one place that decides it: the tools its web session offers
 * (`turnWeb.js`, which leaves out what a Lab test chat refuses). The group prompt's browser lines and the claim
 * checks' "try the browser" notices read this, so neither says there is a browser the turn cannot call
 * (Dev2, 2026-11-27: one part changed, the others kept telling the old story).
 */

/** The tools that drive a browser. */
export const BROWSER_TOOLS = Object.freeze(new Set(["browse", "fill_card", "fill_login"]));

/** True when this turn's web session offers a browser tool. */
export function hasBrowser(web) {
  return Array.isArray(web?.tools) && web.tools.some((tool) => BROWSER_TOOLS.has(tool?.name));
}
