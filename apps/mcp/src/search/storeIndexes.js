/**
 * The two search indexes a request's store may carry, attached in one place.
 *
 * `store.searchIndex` is fast search's D1 projection; `store.meaningIndex` is
 * search by meaning's Vectorize index (with the Workers AI binding beside it).
 * Both descriptors come off `/gateway/binding` as siblings of the binding and
 * both carry a token, so both are **non-enumerable**: a store is spread,
 * shape-logged and handed to helpers, and one `{...store}` must not put a
 * write token in a log line. `null` for absent, partial or malformed, which is
 * the ordinary case and means "off here". See `session.js` for why the
 * descriptors are read off the response and never out of the binding.
 */

import { readSearchIndexBinding } from "./d1/client.js";
import { attachMeaningIndex } from "./meaning/store.js";

export function attachSearchIndexes(store, { searchIndex, meaningIndex }, ai) {
  Object.defineProperty(store, "searchIndex", {
    value: readSearchIndexBinding({ searchIndex }),
    enumerable: false,
    writable: false,
    configurable: true,
  });
  attachMeaningIndex(store, meaningIndex, ai);
  return store;
}
