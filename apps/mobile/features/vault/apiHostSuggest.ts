/**
 * Suggestions for "Only ever sent to" on the vault's save form: the API
 * websites whose address or name starts like what the person typed, the
 * hand-picked ones (`apiHostsTop.ts`) before the directory's
 * (`apiHosts.generated.ts`, about 800 more).
 *
 * A suggestion only fills the field. Whether a key may be pinned to it is
 * still decided where the key is saved (`apps/mcp/src/vault/proxy.js`).
 */

import { DIRECTORY_APIS } from "./apiHosts.generated";
import { TOP_APIS } from "./apiHostsTop";

export interface ApiSuggestion {
  host: string;
  name: string;
}

type Known = ApiSuggestion & { rank: number; words: string[] };

let known: Known[] | null = null;

const wordsOf = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Every API, parsed once on first use: top ones by hand-picked order, then the directory by address. */
function all(): Known[] {
  if (known !== null) return known;
  const list: Known[] = TOP_APIS.map(([host, name], rank) => ({ host, name, rank, words: wordsOf(name) }));
  const seen = new Set(list.map((api) => api.host));
  for (const line of DIRECTORY_APIS.split(/[;\n]/)) {
    const bar = line.indexOf("|");
    const host = line.slice(0, bar);
    if (bar <= 0 || seen.has(host)) continue;
    seen.add(host);
    const name = line.slice(bar + 1);
    list.push({ host, name, rank: TOP_APIS.length + host.length, words: wordsOf(name) });
  }
  known = list;
  return list;
}

/** How many APIs the form knows, for the hint under the field. */
export function knownApiCount(): number {
  return all().length;
}

/** What was typed, reduced to the start of an address: no scheme, path or port. */
function typedStart(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .split(/[/?#:]/)[0];
}

/**
 * How well an API matches `query`, lower is better, or null: its address
 * starts with it, then a part of the address does ("stripe" in
 * api.stripe.com), then a word of its name, then the address anywhere.
 */
function score(api: Known, query: string): number | null {
  if (api.host.startsWith(query)) return 0;
  if (api.host.includes(`.${query}`) || api.host.includes(`-${query}`)) return 1;
  if (!query.includes(".") && api.words.some((word) => word.startsWith(query))) return 2;
  if (query.length >= 3 && api.host.includes(query)) return 3;
  return null;
}

/** Up to `limit` APIs for what was typed; none once it is exactly one of them. */
export function suggestApiHosts(raw: string, limit = 5): ApiSuggestion[] {
  const query = typedStart(raw);
  if (query.length === 0) return [];
  const apis = all();
  if (apis.some((api) => api.host === query)) return [];
  const hits: { api: Known; score: number }[] = [];
  for (const api of apis) {
    const s = score(api, query);
    if (s !== null) hits.push({ api, score: s });
  }
  hits.sort((a, b) => a.score - b.score || a.api.rank - b.api.rank);
  return hits.slice(0, limit).map(({ api }) => ({ host: api.host, name: api.name }));
}

/**
 * The one API a key's name or "Fills on" site most likely means, for the
 * one-tap suggestion before anything is typed: "Stripe" and
 * dashboard.stripe.com both mean api.stripe.com. Only a hand-picked API whose
 * name starts with a word of the name, or whose address shares the site's
 * own name, is offered, so a vague name offers nothing rather than a guess.
 */
export function apiForName(name: string, site = ""): ApiSuggestion | null {
  const top = all().filter((api) => api.rank < TOP_APIS.length);
  const words = wordsOf(name).filter((word) => word.length >= 3);
  for (const first of [true, false]) {
    for (const word of words) {
      const hit = top.find((api) => (first ? api.words[0] === word : api.words.includes(word)));
      if (hit) return { host: hit.host, name: hit.name };
    }
  }
  const siteName = siteLabel(site);
  if (siteName !== null) {
    const hit = top.find((api) => api.host.split(".").includes(siteName));
    if (hit) return { host: hit.host, name: hit.name };
  }
  return null;
}

/** The site's own name in an address: "stripe" for dashboard.stripe.com. */
function siteLabel(site: string): string | null {
  const parts = typedStart(site).split(".").filter(Boolean);
  if (parts.length < 2) return null;
  const label = parts[parts.length - 2];
  return label.length >= 3 && !["com", "co", "org", "net"].includes(label) ? label : null;
}
