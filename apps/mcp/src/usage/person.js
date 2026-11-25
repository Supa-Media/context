/**
 * The Context usage source's person id (`docs/decisions/data-and-metrics.md`, "The Context usage source"): 16
 * lowercase hex of HMAC-SHA-256 over `usage-person:<account id>`, under a key derived (HKDF info
 * `context-usage-person-v1`) from the root the gateway's `SEARCH_QUALITY_KEY` object keeps. The control plane never
 * reaches that root (`search/qualityKeyObject.js`), so the rows it keeps and the sheets the usage run writes name
 * no account, and nobody who reads them can turn one back into a person. The same person has the same id on every
 * surface and every day, which is what lets a sheet count them once.
 *
 * Without the binding (self-hosting on the free tier) there is no key, and nothing is marked.
 */

import { fetchSearchQualityRoot } from "../search/qualityKeyObject.js";
import { deriveSearchQualityKey, searchMac } from "../search/quality.js";

export const USAGE_PERSON_INFO = "context-usage-person-v1";
const ACCOUNT = /^[A-Za-z0-9_|:.-]{1,128}$/;
const keyCache = new WeakMap();

/** The person key for a Worker env, derived once per env object; null with no binding or no root. */
export function usagePersonKeyOf(env) {
  if (env === null || typeof env !== "object" || !env.SEARCH_QUALITY_KEY) return Promise.resolve(null);
  if (!keyCache.has(env)) {
    const pending = fetchSearchQualityRoot(env).then((root) => {
      if (root === null) keyCache.delete(env);
      return deriveSearchQualityKey(root, USAGE_PERSON_INFO);
    });
    keyCache.set(env, pending);
  }
  return keyCache.get(env);
}

/** One account's person id under `key`, or null for anything that isn't an account id. */
export async function usagePersonId(key, userId) {
  if (!key || typeof userId !== "string" || !ACCOUNT.test(userId)) return null;
  return await searchMac(key, `usage-person:${userId}`);
}
