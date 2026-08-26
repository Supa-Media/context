/**
 * S3Store — a ContextStore over any S3-compatible endpoint.
 *
 * Works against Cloudflare R2's S3 API, AWS S3, Backblaze B2, and Wasabi.
 * Zero dependencies: `fetch` plus Web Crypto, because this runs on the Workers
 * runtime where Node APIs and aws-sdk do not exist.
 *
 * Keys are the customer's own keys. The optional `rootPrefix` is applied here
 * and nowhere else — callers above this file never see it.
 *
 * `capabilities.conditionalWrite` is declared true because `If-Match` is sent,
 * but B2 and Wasabi accept that header and ignore it. Always confirm with
 * `probeStore()` before relying on conflict detection.
 */

import {
  applyRootPrefix,
  normalizeEtag,
  normalizeRootPrefix,
  stripListResult,
} from "./index.js";

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";
/** Bodies are small markdown notes; hashing them keeps signatures strict. */
const UNSIGNED_HEADERS = new Set(["authorization", "content-length", "user-agent"]);

export class S3Store {
  /**
   * @param {{
   *   endpoint: string,
   *   region: string,
   *   bucket: string,
   *   accessKeyId: string,
   *   secretAccessKey: string,
   *   rootPrefix?: string,
   *   forcePathStyle?: boolean,
   *   fetchImpl?: typeof fetch,
   *   now?: () => Date,
   * }} config
   */
  constructor(config) {
    const { endpoint, region, bucket, accessKeyId, secretAccessKey } = config || {};
    if (!endpoint) throw new Error("S3Store requires an endpoint");
    if (!bucket) throw new Error("S3Store requires a bucket");
    if (!accessKeyId || !secretAccessKey) throw new Error("S3Store requires credentials");

    this.endpoint = new URL(endpoint);
    this.region = region || "auto";
    this.bucket = bucket;
    this.accessKeyId = accessKeyId;
    // Held in memory for the life of one request only; never logged, never
    // written to the bucket, never placed in a URL.
    this.secretAccessKey = secretAccessKey;
    this.rootPrefix = normalizeRootPrefix(config.rootPrefix);
    this.forcePathStyle =
      config.forcePathStyle ?? !this.endpoint.hostname.startsWith(`${bucket}.`);
    this.fetchImpl = config.fetchImpl || ((...args) => globalThis.fetch(...args));
    this.now = config.now || (() => new Date());
    this.capabilities = { conditionalWrite: true };
  }

  /** Backend URL for a caller key, honouring rootPrefix and addressing style. */
  urlFor(key, query = {}) {
    const url = new URL(this.endpoint.toString());
    const basePath = url.pathname.replace(/\/+$/, "");
    const segments = [];
    if (this.forcePathStyle) segments.push(this.bucket);
    const objectKey = applyRootPrefix(this.rootPrefix, key);
    if (objectKey) segments.push(...objectKey.split("/"));
    url.pathname = `${basePath}/${segments.map(encodeRfc3986).join("/")}`;
    // Built by hand, not with URLSearchParams: that would encode a space as
    // "+", which S3 reads as a literal plus and SigV4 would sign differently.
    url.search = buildCanonicalQuery(
      Object.entries(query)
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .map(([name, value]) => [name, String(value)])
    );
    return url;
  }

  async send(method, url, { headers = {}, body } = {}) {
    const bytes = body === undefined ? new Uint8Array(0) : toBytes(body);
    const signedHeaders = await signRequest({
      method,
      url,
      headers,
      body: bytes,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      region: this.region,
      date: this.now(),
    });
    return this.fetchImpl(url.toString(), {
      method,
      headers: signedHeaders,
      body: method === "GET" || method === "HEAD" ? undefined : bytes,
    });
  }

  async get(key) {
    const response = await this.send("GET", this.urlFor(key));
    if (response.status === 404) return null;
    if (!response.ok) throw await s3Error("GET", key, response);
    // Buffer once: callers may ask for text or bytes, and a Response body can
    // only be consumed a single time.
    const buffer = await response.arrayBuffer();
    return {
      etag: normalizeEtag(response.headers.get("etag") || ""),
      text: async () => new TextDecoder().decode(buffer),
      arrayBuffer: async () => buffer,
    };
  }

  async put(key, value, options = {}) {
    const headers = { "content-type": "text/markdown; charset=utf-8" };
    const expected = options?.onlyIf?.etagMatches;
    if (expected) headers["if-match"] = `"${normalizeEtag(expected)}"`;
    const response = await this.send("PUT", this.urlFor(key), { headers, body: value });
    // 412 is the documented precondition failure. 404 happens when a
    // conditional write targets an object that no longer exists — also a
    // failed precondition, and R2 returns null for it.
    if (expected && (response.status === 412 || response.status === 404)) return null;
    if (!response.ok) throw await s3Error("PUT", key, response);
    return { etag: normalizeEtag(response.headers.get("etag") || "") };
  }

  async delete(key) {
    const response = await this.send("DELETE", this.urlFor(key));
    if (response.status === 404 || response.status === 204 || response.ok) return;
    throw await s3Error("DELETE", key, response);
  }

  async list({ prefix, delimiter, cursor, limit } = {}) {
    const url = this.urlFor("", {
      "list-type": "2",
      prefix: applyRootPrefix(this.rootPrefix, prefix || ""),
      delimiter,
      "continuation-token": cursor,
      "max-keys": limit,
    });
    const response = await this.send("GET", url);
    if (!response.ok) throw await s3Error("LIST", prefix || "", response);
    return stripListResult(this.rootPrefix, parseListObjectsV2(await response.text()));
  }
}

async function s3Error(operation, key, response) {
  let detail = "";
  try {
    const body = await response.text();
    detail = readTag(body, "Message") || readTag(body, "Code") || "";
  } catch {
    detail = "";
  }
  // Never include the URL: a presigned or credentialed URL must not reach logs.
  return new Error(
    `S3 ${operation} ${key} failed with ${response.status}${detail ? `: ${detail}` : ""}`
  );
}

/* ------------------------------ XML parsing ------------------------------ */

/**
 * ListObjectsV2 responses are small and rigidly shaped, so a tag reader beats
 * pulling in an XML library this worker is not allowed to have.
 */
export function parseListObjectsV2(xml) {
  const objects = [];
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = match[1];
    const key = decodeXmlText(readTag(block, "Key"));
    if (key === null) continue;
    objects.push({
      key,
      size: Number(readTag(block, "Size") || 0),
      uploaded: new Date(readTag(block, "LastModified") || 0),
      etag: normalizeEtag(decodeXmlText(readTag(block, "ETag")) || ""),
    });
  }
  const delimitedPrefixes = [];
  for (const match of xml.matchAll(/<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g)) {
    const prefix = decodeXmlText(readTag(match[1], "Prefix"));
    if (prefix !== null) delimitedPrefixes.push(prefix);
  }
  const truncated = (readTag(xml, "IsTruncated") || "").trim() === "true";
  const cursor = decodeXmlText(readTag(xml, "NextContinuationToken")) || undefined;
  return { objects, delimitedPrefixes, truncated, cursor };
}

function readTag(xml, name) {
  const match = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return match ? match[1] : null;
}

function decodeXmlText(value) {
  if (value === null || value === undefined) return null;
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

/* ---------------------------- AWS Signature V4 ---------------------------- */

/**
 * Sign a request with SigV4 and return the headers to send.
 *
 * `host` is signed but not returned: the runtime sets it from the URL and
 * treats it as a forbidden header. Every other header we send is signed, so a
 * proxy cannot strip `If-Match` without invalidating the signature.
 */
export async function signRequest({
  method,
  url,
  headers = {},
  body = new Uint8Array(0),
  accessKeyId,
  secretAccessKey,
  region,
  date = new Date(),
  service = SERVICE,
}) {
  const amzDate = toAmzDate(date);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(body);

  const canonicalHeaders = new Map();
  canonicalHeaders.set("host", url.host);
  canonicalHeaders.set("x-amz-content-sha256", payloadHash);
  canonicalHeaders.set("x-amz-date", amzDate);
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (UNSIGNED_HEADERS.has(lower)) continue;
    canonicalHeaders.set(lower, String(value).trim().replace(/\s+/g, " "));
  }

  const sortedNames = [...canonicalHeaders.keys()].sort();
  const canonicalHeaderBlock = sortedNames
    .map((name) => `${name}:${canonicalHeaders.get(name)}\n`)
    .join("");
  const signedHeaderList = sortedNames.join(";");

  const canonicalQuery = buildCanonicalQuery(decodeQuery(url.search));

  const canonicalRequest = [
    method,
    url.pathname || "/",
    canonicalQuery,
    canonicalHeaderBlock,
    signedHeaderList,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    await sha256Hex(new TextEncoder().encode(canonicalRequest)),
  ].join("\n");

  const key = await deriveSigningKey(secretAccessKey, dateStamp, region, service);
  const signature = toHex(await hmac(key, stringToSign));

  const out = {
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    Authorization:
      `${ALGORITHM} Credential=${accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaderList}, Signature=${signature}`,
  };
  for (const [name, value] of Object.entries(headers)) {
    if (!UNSIGNED_HEADERS.has(name.toLowerCase())) out[name] = String(value);
  }
  return out;
}

/** Exported so a known-answer test can pin the HMAC chain. */
export async function deriveSigningKey(secretAccessKey, dateStamp, region, service) {
  const kDate = await hmac(new TextEncoder().encode(`AWS4${secretAccessKey}`), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

async function hmac(keyBytes, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    typeof data === "string" ? new TextEncoder().encode(data) : data
  );
  return new Uint8Array(signature);
}

async function sha256Hex(bytes) {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

function toHex(bytes) {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function toAmzDate(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Sorted, RFC 3986 encoded `a=1&b=2`. Both the URL and the signature use it. */
function buildCanonicalQuery(pairs) {
  return pairs
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

/** Decode `?a=1&b=2` without URLSearchParams' form-encoding "+" rule. */
function decodeQuery(search) {
  const query = search.startsWith("?") ? search.slice(1) : search;
  if (!query) return [];
  return query.split("&").map((pair) => {
    const index = pair.indexOf("=");
    const name = index < 0 ? pair : pair.slice(0, index);
    const value = index < 0 ? "" : pair.slice(index + 1);
    return [decodeURIComponent(name), decodeURIComponent(value)];
  });
}

/** RFC 3986 encoding — encodeURIComponent leaves !'()* alone, SigV4 does not. */
export function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function toBytes(value) {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new TextEncoder().encode(String(value));
}
