import { promises as dns } from "node:dns";
import https from "node:https";
import { isIP } from "node:net";

import { isPublicAddress } from "./public-address.mjs";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_USER_AGENT = "Context.LC/1.0 (+https://context.lc)";

export class EgressError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EgressError";
    this.code = code;
  }
}

async function resolveAll(hostname) {
  const settle = async (promise) => {
    try { return await promise; } catch (error) {
      if (["ENODATA", "ENOTFOUND"].includes(error?.code)) return [];
      throw error;
    }
  };
  const [v4, v6] = await Promise.all([
    settle(dns.resolve4(hostname)),
    settle(dns.resolve6(hostname)),
  ]);
  return [...new Set([...v4, ...v6])];
}

function connectExact(options, body) {
  return new Promise((resolve, reject) => {
    const request = https.request({ ...options, timeout: REQUEST_TIMEOUT_MS }, resolve);
    request.once("timeout", () => request.destroy(new Error("request timed out")));
    request.once("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function safeHeaders(input, hostname) {
  /*
    Node's HTTPS client sends no User-Agent by default. Some public sites serve
    that anonymous shape a JavaScript client challenge instead of the document
    the plugin requested; YouVersion is one, so its official plugin receives a
    200 response that contains no verse and reports an unavailable preview.

    Identify this broker honestly when the plugin did not identify itself.
    Preserve an explicit plugin value: requestUrl accepts headers, and changing
    one here would make the egress path differ from the request the owner
    approved the plugin to make.
  */
  const headers = { host: hostname, "user-agent": DEFAULT_USER_AGENT };
  for (const row of input ?? []) {
    const name = String(row?.name ?? "").toLowerCase();
    if (!name || ["host", "connection", "proxy-authorization", "transfer-encoding"].includes(name)) continue;
    headers[name] = String(row.value ?? "");
  }
  return headers;
}

function responseHeaders(input) {
  const result = [];
  for (const [name, raw] of Object.entries(input)) {
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) if (value !== undefined && result.length < 64) {
      result.push({ name: name.toLowerCase(), value: String(value) });
    }
  }
  return result;
}

export function makePinnedRequest({ resolve = resolveAll, connect = connectExact } = {}) {
  return async function pinnedRequest(input) {
    let url;
    try { url = new URL(input?.url); } catch {
      throw new EgressError("NETWORK_PRIVATE_ADDRESS_DENIED", "Egress requires an HTTPS DNS hostname");
    }
    const literal = url.hostname.replace(/^\[|\]$/g, "");
    if (url.protocol !== "https:" || (url.port && url.port !== "443") || isIP(literal) !== 0) {
      throw new EgressError("NETWORK_PRIVATE_ADDRESS_DENIED", "Egress requires an HTTPS DNS hostname");
    }

    let addresses;
    try { addresses = await resolve(url.hostname); } catch {
      throw new EgressError("NETWORK_EGRESS_UNAVAILABLE", "The egress service could not resolve the host");
    }
    if (!Array.isArray(addresses) || addresses.length === 0) {
      throw new EgressError("NETWORK_EGRESS_UNAVAILABLE", "The egress service could not resolve the host");
    }
    if (addresses.some((address) => !isPublicAddress(address))) {
      throw new EgressError("NETWORK_PRIVATE_ADDRESS_DENIED", "The host resolved to a non-public address");
    }

    const address = addresses[0];
    let response;
    try {
      response = await connect({
        hostname: address,
        family: isIP(address),
        port: 443,
        servername: url.hostname,
        rejectUnauthorized: true,
        method: input.method,
        path: `${url.pathname}${url.search}`,
        headers: safeHeaders(input.headers, url.hostname),
      }, input.body);
    } catch {
      throw new EgressError("NETWORK_EGRESS_UNAVAILABLE", "The egress service could not reach the host");
    }

    const declared = Number(response.headers?.["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      throw new EgressError("NETWORK_RESPONSE_TOO_LARGE", "Network response exceeds 2 MB");
    }
    const chunks = [];
    let total = 0;
    for await (const raw of response) {
      const chunk = Buffer.from(raw);
      total += chunk.length;
      if (total > MAX_RESPONSE_BYTES) {
        response.destroy?.();
        throw new EgressError("NETWORK_RESPONSE_TOO_LARGE", "Network response exceeds 2 MB");
      }
      chunks.push(chunk);
    }
    return {
      status: response.statusCode ?? 502,
      headers: responseHeaders(response.headers ?? {}),
      bodyBase64: Buffer.concat(chunks).toString("base64"),
    };
  };
}

export const pinnedRequest = makePinnedRequest();
