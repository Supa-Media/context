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

/** A sentence that sends Tex to its own browser. */
const USES_THE_BROWSER = /\byour browser\b|\bbrowser call\b|\bbrowse (?:download|step)\b/i;
/** ", or open the site in your browser and sign in": one road of several, named inside a sentence. */
const BROWSER_CLAUSE = /,\s*or\s[^.;]*\byour browser\b[^.;]*(?=[.;])/gi;

/**
 * Written guidance as this turn can follow it: with no browser (`reach.browser === false`), the clauses and sentences
 * that send Tex to its browser are left out, so a notice never asks for what the turn cannot call. Everything else is
 * kept as written. A notice is written once, for a turn with every tool; its reach is applied here, from the same fact
 * the tool list gives (`hasBrowser`).
 */
export function forReach(text, reach = {}) {
  if (typeof text !== "string" || reach.browser !== false) return text;
  return text
    .replace(BROWSER_CLAUSE, "")
    .split(/(?<=[.!?])\s+(?=[A-Z"(])/)
    .filter((sentence) => !USES_THE_BROWSER.test(sentence))
    .join(" ");
}
