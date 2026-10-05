// URL comparison key for the `urls/` posting family (arch 8.2, OPEN-6).
//
// Conservative and versioned. Only what the platform `URL` parser guarantees is
// normalized: scheme and host case, an explicit default port, the empty path.
// Path case, query order and the fragment are preserved. A URL that looks like
// it carries a secret returns null and is never grouped.
//
// Exclusion rule: userinfo present, or a parameter whose lowercased name is in
// SECRET_PARAMS, read from the query and from the fragment (an OAuth implicit
// response puts `#access_token=` there). `code` is left out on purpose: it is a
// common harmless parameter (`?code=python`, pagination, search) and excluding
// it would drop real shared references; an OAuth `code` is single use anyway. This is a heuristic, not a guarantee: a secret in the
// path or under an unlisted name is not recognized. Changing the list bumps
// URL_KEY_VERSION, which changes every referenceSetVersion on purpose.
export const URL_KEY_VERSION = 1;

const SECRET_PARAMS = new Set([
  "token", "access_token", "id_token", "refresh_token", "signature", "sig",
  "key", "api_key", "apikey", "password", "secret", "auth",
  "x-amz-signature", "x-amz-credential", "x-amz-security-token",
  "x-goog-signature", "x-goog-credential", "policy", "key-pair-id", "jwt",
]);

/** `{ key, version }` for an http(s) URL, or null when unparseable or excluded. */
export function urlKey(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  const fragment = url.hash.startsWith("#") ? url.hash.slice(1) : "";
  for (const params of [url.searchParams, new URLSearchParams(fragment)]) {
    for (const name of params.keys()) {
      if (SECRET_PARAMS.has(name.toLowerCase())) return null;
    }
  }
  return { key: url.href, version: URL_KEY_VERSION };
}
