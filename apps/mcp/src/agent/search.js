/**
 * WEB SEARCH: one interface, swappable providers, like the computer.
 *
 * Decided by the owner, 2026-10-07: the texting assistant searches the web on
 * its own, the way Instinct does, with no asking first and with queries it
 * writes itself. Brave Search is the first provider (the owner's pick):
 *
 *     searcher.search(query) → [{ title, url, description }]
 *
 * `AGENT_SEARCH` picks the provider (default `brave`); a provider with no key
 * is no searcher at all, so a gateway without `BRAVE_SEARCH_API_KEY` (a
 * self-hosted one, or ours before the key is set) offers no search tool.
 *
 * What a query can carry, and why that is accepted, is in
 * `docs/decisions/texting-assistant.md` ("The agent searches the web on its
 * own"). In short: a query goes to the search provider, never to a page's
 * author, and the addresses it returns were in the provider's index before the
 * turn began, so opening one cannot carry what the agent read.
 */

/** Searches one question may run. */
export const MAX_SEARCHES_PER_TURN = 3;

/** Results one search returns to the model. */
export const RESULTS_PER_SEARCH = 6;

/** Brave refuses longer queries; anything past this is not a search. */
export const MAX_QUERY_CHARS = 300;

const SEARCH_TIMEOUT_MS = 6_000;
const MAX_DESCRIPTION_CHARS = 400;

const PROVIDERS = {
  brave: braveSearcher,
};

/**
 * The search this deployment gives the agent, or null when it has none.
 *
 * @param {object} env the Worker environment
 * @param {{fetchImpl?: typeof fetch}} [options]
 */
export function searcherFor(env, { fetchImpl = globalThis.fetch } = {}) {
  const name = typeof env?.AGENT_SEARCH === "string" && env.AGENT_SEARCH ? env.AGENT_SEARCH : "brave";
  const make = Object.prototype.hasOwnProperty.call(PROVIDERS, name) ? PROVIDERS[name] : null;
  return make ? make(env, fetchImpl) : null;
}

function braveSearcher(env, fetchImpl) {
  const key = env?.BRAVE_SEARCH_API_KEY;
  if (typeof key !== "string" || key.trim() === "" || typeof fetchImpl !== "function") return null;
  return {
    provider: "brave",
    async search(query) {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(RESULTS_PER_SEARCH));
      url.searchParams.set("safesearch", "moderate");
      // The key goes in a header, never in the address: addresses are logged.
      const response = await fetchImpl(url.toString(), {
        headers: { accept: "application/json", "x-subscription-token": key.trim() },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`search refused (${response.status})`);
      const body = await response.json().catch(() => null);
      const results = Array.isArray(body?.web?.results) ? body.web.results : [];
      return results
        .map((result) => ({
          title: plain(result?.title),
          url: typeof result?.url === "string" ? result.url : "",
          description: plain(result?.description).slice(0, MAX_DESCRIPTION_CHARS),
        }))
        .filter((result) => result.url !== "")
        .slice(0, RESULTS_PER_SEARCH);
    },
  };
}

/** Brave marks matched words with <strong>; the model gets the words. */
function plain(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]{0,40}>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

/** A query the model wrote, tidied, or null when it is no query. */
export function cleanQuery(raw) {
  if (typeof raw !== "string") return null;
  const query = raw.replace(/\s+/g, " ").trim();
  if (query.length === 0 || query.length > MAX_QUERY_CHARS) return null;
  return query;
}
