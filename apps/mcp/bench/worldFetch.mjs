/**
 * The bench world's network (moved out of `world.mjs`, 2026-11-18): model calls are the only traffic that leaves the
 * world, and web searches when the run has a search key and no scripted web. Production searches the real web, so a
 * run does too (decided 2026-10-09; until 2026-10-11 the world refused the call, so every search_web in a result had
 * failed). Everything else goes to a stand-in or is refused.
 */

import { CONTROL_PLANE_ORIGIN } from "../test/controlPlaneStub.mjs";
import { CLOUDFLARE_API_BASE } from "../test/searchProjection/fixtures.mjs";

const BRAVE_SEARCH = "https://api.search.brave.com/";

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/**
 * Puts the world's fetch in place of `globalThis.fetch` and answers the function that puts the old one back.
 * `modelCalls` keeps the model calls (`modelLog.mjs`), `web` is the scripted web (`sites.mjs`), `sim` the simulated
 * world (`simWorld.mjs`), `stand` the stand-ins, `s3Endpoint` the buckets' address, and `local` whether a local search
 * database or meaning index answers Cloudflare's API.
 */
export function interceptFetch({ modelCalls, web, sim, models, stand, s3Endpoint, local }) {
  const below = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://gateway.ai.cloudflare.com/")) return modelCalls.fetch(url, init);
    if (url.startsWith(BRAVE_SEARCH)) {
      if (web || sim) {
        const q = new URL(url).searchParams.get("q") ?? "";
        let results = web ? web.search(q) : [];
        if (results.length === 0 && sim) results = await sim.search(q);
        return json({ web: { results } });
      }
      if (typeof models.searchKey === "string" && models.searchKey) return below(input, init);
      // A socketed run (`modelSocket.mjs`) offers web search and finds nothing, the same live and replayed.
      if (models.offlineWeb === true) return json({ web: { results: [] } });
    }
    if (url.startsWith(CONTROL_PLANE_ORIGIN)) return stand.controlPlane(url, input, init, below);
    if (url.startsWith(s3Endpoint)) return below(input, init);
    if (local && url.startsWith(CLOUDFLARE_API_BASE)) return below(input, init);
    stand.noStandIn(url);
    throw new Error("a benchmark turn tried to reach the network outside the model");
  };
  return () => {
    globalThis.fetch = below;
  };
}
