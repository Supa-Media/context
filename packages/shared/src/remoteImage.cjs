/**
 * Fetching an image from somebody else's server, safely, and telling what it is.
 *
 * Two callers, one rule, which is why this is shared rather than written twice:
 *
 *  - the gateway, when an agent attaches an image by `url` to `write_note`
 *    (`apps/mcp/src/notes/uploadedImages.js`), fetches it once and stores it;
 *  - the control plane's image proxy (`readRemoteImage` in
 *    `apps/convex/functions/lib/filesFns/images.ts`), which fetches a remote
 *    image a note names so the reader's own browser never contacts its host.
 *
 * Plain CommonJS with no dependencies, like `storageLayout.cjs`, so the
 * dependency-free gateway and Convex both import it. `fetch` is passed in so a
 * test can serve the network.
 */

/** The most one fetched image may be: the app's paste ceiling and `read_image`'s inline one. */
const MAX_REMOTE_IMAGE_BYTES = 5_000_000;

/** How many redirects a URL may take before it is refused. */
const MAX_REMOTE_IMAGE_REDIRECTS = 3;

/** How long one fetch may take, so a slow host cannot hold a request open. */
const REMOTE_IMAGE_TIMEOUT_MS = 15_000;

const ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/heic,image/heif";

/**
 * What the bytes are, from their first few, or null.
 *
 * The type is always decided here and never by a caller's `data:` header or a
 * remote server's `content-type`, because what is returned is drawn by a client
 * that trusts it. SVG is not here and cannot be: it has no magic number, it is
 * text, and it is a script container — the reason the store and `read_image`
 * refuse it too.
 */
function sniffImageType(bytes) {
  const at = (i) => bytes[i];
  const ascii = (from, length) => String.fromCharCode(...bytes.subarray(from, from + length));
  if (bytes.length >= 8 && at(0) === 0x89 && ascii(1, 3) === "PNG" && at(4) === 0x0d && at(5) === 0x0a) {
    return { extension: "png", contentType: "image/png" };
  }
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) {
    return { extension: "jpg", contentType: "image/jpeg" };
  }
  if (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) {
    return { extension: "gif", contentType: "image/gif" };
  }
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    return { extension: "webp", contentType: "image/webp" };
  }
  if (bytes.length >= 12 && ascii(4, 4) === "ftyp") {
    const brand = ascii(8, 4);
    if (["heic", "heix", "heim", "heis", "hevc", "hevx"].includes(brand)) {
      return { extension: "heic", contentType: "image/heic" };
    }
    if (["mif1", "msf1"].includes(brand)) {
      return { extension: "heif", contentType: "image/heif" };
    }
  }
  return null;
}

/**
 * The one shape of URL either caller will fetch, as a `URL`, or null: https,
 * the default port, no userinfo, a name rather than an address.
 *
 * Plain http is refused because the bytes would cross the internet unsigned;
 * userinfo because a credential in a URL is one we would then have handled; a
 * port, an IP literal, `localhost` and `.internal` because what this is for is
 * an image on the web, which has a name, and those are how a caller aims at a
 * host beside us. Every redirect hop is put through this again.
 */
function fetchableImageUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (/^\d+(\.\d+){3}$/.test(host) || host.startsWith("[")) return null;
  if (!host.includes(".") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    return null;
  }
  return url;
}

async function readCapped(response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REMOTE_IMAGE_BYTES) return { tooLarge: true };
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    return buffer.byteLength > MAX_REMOTE_IMAGE_BYTES ? { tooLarge: true } : { bytes: buffer };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REMOTE_IMAGE_BYTES) {
      await reader.cancel().catch(() => {});
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes };
}

/**
 * Fetch one image. Resolves to `{ bytes, extension, contentType }`, or to
 * `{ error }` with a sentence naming what was wrong — never throws.
 *
 * No cookies, no credentials, no referrer: the request carries nothing about
 * who asked for it.
 */
async function fetchRemoteImage(value, fetchImpl) {
  let url = fetchableImageUrl(value);
  if (!url) {
    return { error: "url must be an https address on the default port, with no username or password" };
  }
  for (let hop = 0; hop <= MAX_REMOTE_IMAGE_REDIRECTS; hop += 1) {
    let response;
    try {
      response = await fetchImpl(url.toString(), {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        headers: { accept: ACCEPT },
        signal:
          typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
            ? AbortSignal.timeout(REMOTE_IMAGE_TIMEOUT_MS)
            : undefined,
      });
    } catch {
      return { error: `could not fetch ${url.hostname}` };
    }
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get("location");
      let resolved = null;
      try {
        resolved = next ? new URL(next, url).toString() : null;
      } catch {
        resolved = null;
      }
      url = resolved ? fetchableImageUrl(resolved) : null;
      if (!url) return { error: "the url redirected somewhere that is not a plain https address" };
      continue;
    }
    if (!response.ok) return { error: `fetching the url answered ${response.status}` };
    const read = await readCapped(response);
    if (read.tooLarge) return { error: `image is larger than ${MAX_REMOTE_IMAGE_BYTES} bytes` };
    if (read.bytes.byteLength === 0) return { error: "the image is empty" };
    const type = sniffImageType(read.bytes);
    if (!type) return { error: "not a PNG, JPEG, GIF, WebP or HEIC image (SVG is never served)" };
    return { bytes: read.bytes, ...type };
  }
  return { error: `the url redirected more than ${MAX_REMOTE_IMAGE_REDIRECTS} times` };
}

module.exports = {
  MAX_REMOTE_IMAGE_BYTES,
  MAX_REMOTE_IMAGE_REDIRECTS,
  sniffImageType,
  fetchableImageUrl,
  fetchRemoteImage,
};
