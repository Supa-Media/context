/**
 * The bytes every credential here is minted from, and the three response
 * shapes every endpoint answers with.
 */

/* ------------------------------ small helpers ----------------------------- */

export function randomToken(bytes = 32) {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders,
    },
  });
}

/**
 * Discovery documents are public, identical for every caller, and change only
 * on deploy — the one thing here worth letting a client cache.
 */
export function metadataResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/** RFC 6749 §5.2 / RFC 7591 §3.2.2 error body. Always 400 unless stated. */
export function oauthError(error, description, status = 400, extraHeaders = {}) {
  return jsonResponse({ error, error_description: description }, status, extraHeaders);
}
