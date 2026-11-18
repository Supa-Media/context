/**
 * WHAT THE BENCH COULD NOT STAND IN FOR, KEPT WITH THE ANSWER (Training run of 2026-11-18).
 *
 * A bench world plays everything outside the model: the control plane, the browser Worker, the web, Gmail, the
 * calendar. Where one of those stand-ins has no answer (a route the stub never learnt, a browser call the binding does
 * not take, a simulated service whose own model call failed, a fetch to a host the world has no stand-in for), the
 * tool Tex called fails for a reason production would never give it, and the judge then grades Tex on "I couldn't
 * make the picture". That is the bench's failure, not Tex's. Each one is recorded here as a short line, kept on the
 * conversation's record (`run.mjs`, the result's `Bench:` line), and a Front door unit test whose turn hit one is a
 * harness error row, never a miss (`setsFd.mjs`).
 *
 * Only what the bench itself failed to answer goes here. A page a scripted site does not have, a search that finds
 * nothing and a refusal the product itself gives (no calendar in a group chat) are the world's honest answers.
 */

/** One conversation's gaps: `add(line)` keeps each once, `list()` reads them in order. */
export function benchGaps() {
  const gaps = [];
  return {
    add(what) {
      const line = String(what ?? "").replace(/\s+/g, " ").replaceAll(" | ", " / ").trim().slice(0, 200);
      if (line !== "" && !gaps.includes(line)) gaps.push(line);
    },
    list: () => [...gaps],
  };
}

/**
 * Control-plane routes whose missing answer fails no tool, so their 404 is not a gap: reports sent behind the response
 * that nobody reads the answer of (`controlPlane/reporting.js`), the gateway's own bookkeeping of notes and rows, and
 * asks a turn carries on without (the texter's account identity: no bench person has an account, and a turn answers
 * without one as it does for any client that may not know; a chat's home and browser profile, each read with a
 * fallback). Any other route with no answer is one a tool was waiting on.
 */
export const FAILS_NO_TOOL = [
  "/gateway/search-timing",
  "/gateway/search-open",
  "/gateway/tool-failures",
  "/gateway/tex-review",
  "/gateway/routines",
  "/gateway/website",
  "/gateway/page-cover",
  "/gateway/agent/identity",
  "/gateway/texts/opened",
  "/gateway/tex/chat-home",
  "/gateway/browser-profile",
  "/gateway/note-ids/",
  "/gateway/objects/behind",
  "/gateway/rows/mirror",
  "/gateway/access/mirror",
  "/gateway/access/profiles",
];

/** Whether the control plane's stand-in having no answer for `path` is a gap in the bench (`FAILS_NO_TOOL`). */
export const isRouteGap = (path) => !FAILS_NO_TOOL.some((route) => (route.endsWith("/") ? path.startsWith(route) : path === route));

/**
 * Browser Worker calls no tool fails on: a finished browse's log and the release of its session
 * (`browserProviders.js`), which the bench keeps neither of and says yes to, and a photograph of a page for a card
 * (`visuals/hunt.js` shooterFor), which the bench cannot take: it answers with no shot, and the card goes without.
 */
const BEHIND_A_BROWSE = new Set(["/browse/log", "/browse/release", "/shoot"]);

/** `env.SITE_SHOTS` with every call the bench's browser Worker has no answer for (a 404) recorded as a gap. */
export function watchedBinding(binding, gaps) {
  return {
    async fetch(url, init) {
      if (BEHIND_A_BROWSE.has(new URL(url).pathname)) return new Response(JSON.stringify({ ok: true, shots: [] }), { status: 200, headers: { "content-type": "application/json" } });
      const response = await binding.fetch(url, init);
      if (response.status === 404) gaps.add(`the bench's browser Worker has no ${new URL(url).pathname}`);
      return response;
    },
  };
}
