/**
 * Cache headers for `/_expo/` as Workers Static Assets actually returns it.
 *
 * `route.ts` marks the prefix immutable, because the filename changes when
 * the bytes do. The Static Assets branch in `index.ts` returns before that
 * hint is read (#2850). The binding's own header is
 * `public, max-age=0, must-revalidate`, so a browser revalidates the entry
 * on every visit.
 *
 * The same binding answers a missing file with the shell at 200
 * (`not_found_handling: single-page-application`): an old entry, a `.map`,
 * an invented name. That body must not inherit a year-long immutable
 * header, or a browser keeps HTML under a script name until the name ages
 * out. A response whose type is HTML is a miss.
 *
 * A 304 that still names a non-HTML type gets the same header. Production
 * sends `Content-Type: text/javascript` on the entry's 304, and leaving
 * `max-age=0` there would keep revalidating a copy the browser already
 * holds. A 304 whose type is HTML is the shell standing in for a miss, and
 * it is a 404 for the same reason a 200 of HTML is.
 */

/** A year, and the browser must not revalidate while that year is running. */
export const EXPO_IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

/** Whether Static Assets answered with the shell rather than the file named. */
function isHtml(response: Response): boolean {
  const raw = response.headers.get("Content-Type");
  if (raw === null) return false;
  return raw.split(";", 1)[0]!.trim().toLowerCase() === "text/html";
}

/**
 * `response` from the assets binding for a `/_expo/` request.
 *
 * HTML becomes a 404 that must not be stored. A 200, and a 304 that still
 * names a non-HTML type, are immutable. Anything else (a 304 with no type,
 * an error that is not the shell) is returned as the binding sent it.
 */
export function withExpoAssetCache(response: Response): Response {
  if (isHtml(response)) {
    void response.body?.cancel();
    return new Response(null, {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  }
  const revalidatedAsset = response.status === 304 && response.headers.has("Content-Type");
  if (response.status !== 200 && !revalidatedAsset) return response;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", EXPO_IMMUTABLE_CACHE);
  if (response.status === 304) void response.body?.cancel();
  return new Response(response.status === 304 ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
