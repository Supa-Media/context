/**
 * What `executePluginRequest` does with a request it has authorised: RPC
 * answers, storage operations, and network requests brokered through the
 * egress Worker. The authorisation and every call into the deployment stay in
 * `functions/obsidianPlugins.ts`.
 *
 * Split out of `functions/obsidianPlugins.ts`, which keeps every registered
 * plugin function; this module registers none.
 */

import { extractFields } from "../../../../mcp/src/search/indexer.js";
import { MAX_NETWORK_REDIRECTS, MAX_NETWORK_RESPONSE_BYTES, NETWORK_REQUEST_TIMEOUT_MS } from "./limits";
import { pluginEgressConfiguration, pluginError } from "./access";
import type {
  EgressWireResponse,
  PluginRpcResponse,
  RpcOperation,
  RuntimeStorageOperation,
} from "./shapes";

export function rpcSuccess(requestId: string, result: unknown): PluginRpcResponse {
  return { version: 1, requestId, ok: true, result };
}

export function rpcFailure(requestId: string, code: string, message: string): PluginRpcResponse {
  return {
    version: 1,
    requestId,
    ok: false as const,
    error: { code, message },
  };
}

/**
 * The answer to `metadata.get`, and nothing else.
 *
 * **`metadata:read` is offered to a person as the lesser of two rows**, beside
 * `vault:read`, and the words on the approval screen are the contract: "Read
 * links and tags — frontmatter, headings, tags and the links between notes"
 * against "Read your notes — open the Markdown of any note in this context
 * that you can see". Somebody who grants the first while declining the second
 * has said this plugin may not read their notes.
 *
 * This used to spread `extractFields` whole. That function exists for the
 * search indexer, where every field including `body` goes into a shard inside
 * the customer's own bucket, and `body` there is the entire note minus its
 * frontmatter and heading lines. Spread into an RPC response it handed the
 * Markdown to the one grant that had been explicitly refused it — the
 * operation resolves to a full `read`, so the text was always fetched; what
 * was missing was the narrowing on the way out.
 *
 * So the fields are **listed** rather than spread. A shared helper's return
 * shape is not a promise to its callers, and a field added to it for the
 * indexer's sake must not become a field this route discloses; naming them
 * makes that a decision somebody takes here rather than one that arrives.
 * `files.test.ts` pins the exact key set for the same reason.
 */
export function metadataResponse(path: string, etag: string | undefined, text: string) {
  const fields = extractFields(path, text);
  return {
    path,
    etag,
    title: fields.title,
    headings: fields.headings,
    tags: fields.tags,
    links: fields.links,
  };
}

export function toStorageOperation(pluginId: string, operation: RpcOperation): RuntimeStorageOperation {
  switch (operation.kind) {
    case "vault.list":
      return { kind: "list", path: operation.prefix! };
    case "vault.read":
    case "metadata.get":
      return { kind: "read", path: operation.path! };
    case "vault.create":
      return { kind: "write", path: operation.path!, text: operation.text! };
    case "vault.modify":
      return {
        kind: "write",
        path: operation.path!,
        text: operation.text!,
        expectedEtag: operation.expectedEtag!,
      };
    case "vault.rename":
      return {
        kind: "pluginRename",
        from: operation.from!,
        to: operation.to!,
        expectedEtag: operation.expectedEtag!,
      };
    case "vault.delete":
      return {
        kind: "pluginDelete",
        path: operation.path!,
        expectedEtag: operation.expectedEtag!,
      };
    case "settings.load":
      return { kind: "pluginSettingsRead", pluginId };
    case "settings.save":
      return {
        kind: "pluginSettingsWrite",
        pluginId,
        json: operation.json!,
        expectedEtag: operation.expectedEtag!,
      };
    default:
      throw pluginError("INVALID_OPERATION", "Unsupported plugin operation");
  }
}

export async function brokerNetworkRequest(operation: RpcOperation, allowedHosts: string[]) {
  let url = operation.url!;
  for (let redirects = 0; redirects <= MAX_NETWORK_REDIRECTS; redirects += 1) {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (!allowedHosts.includes(host) || parsed.protocol !== "https:" || (parsed.port && parsed.port !== "443")) {
      throw pluginError("NETWORK_HOST_DENIED", "Plugin was not granted this exact HTTPS host");
    }
    const response = await fetchThroughPluginEgress({
      url,
      method: operation.method!,
      headers: operation.headers ?? [],
      body: operation.body,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirects === MAX_NETWORK_REDIRECTS) {
        throw pluginError("NETWORK_REDIRECT_DENIED", "Network redirect could not be followed safely");
      }
      if (operation.method !== "GET" && operation.method !== "HEAD") {
        throw pluginError("NETWORK_REDIRECT_DENIED", "Redirects are not allowed for mutating requests");
      }
      url = new URL(location, url).toString();
      continue;
    }
    const body = await boundedResponseBody(response);
    const headers: Array<{ name: string; value: string }> = [];
    response.headers.forEach((value, name) => {
      if (name.toLowerCase() !== "set-cookie" && headers.length < 64) headers.push({ name, value });
    });
    return { status: response.status, headers, bodyBase64: encodeBase64(body) };
  }
  throw pluginError("NETWORK_REDIRECT_DENIED", "Too many network redirects");
}

export function decodeBase64(value: string): ArrayBuffer {
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    throw pluginError("NETWORK_EGRESS_UNAVAILABLE", "The egress service returned an invalid response");
  }
  if (decoded.length > MAX_NETWORK_RESPONSE_BYTES) {
    throw pluginError("NETWORK_RESPONSE_TOO_LARGE", "Network response exceeds 2 MB");
  }
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes.buffer;
}

export function encodeBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export async function fetchThroughPluginEgress(input: {
  url: string;
  method: string;
  headers: Array<{ name: string; value: string }>;
  body?: string;
}): Promise<Response> {
  const config = pluginEgressConfiguration();
  if (config === null) {
    throw pluginError("NETWORK_EGRESS_UNAVAILABLE", "The public-only egress service is not configured");
  }
  let response: Response;
  try {
    response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
      redirect: "error",
      signal: AbortSignal.timeout(NETWORK_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw pluginError("NETWORK_EGRESS_UNAVAILABLE", "The public-only egress service is unavailable");
  }

  let wire: EgressWireResponse;
  try {
    wire = await response.json() as EgressWireResponse;
  } catch {
    throw pluginError("NETWORK_EGRESS_UNAVAILABLE", "The egress service returned an invalid response");
  }
  if (!response.ok || wire.ok !== true) {
    const code = wire.error?.code;
    if (code === "NETWORK_PRIVATE_ADDRESS_DENIED") {
      throw pluginError(code, "The approved host resolved to a non-public address");
    }
    if (code === "NETWORK_RESPONSE_TOO_LARGE") {
      throw pluginError(code, "Network response exceeds 2 MB");
    }
    throw pluginError("NETWORK_EGRESS_UNAVAILABLE", "The public-only egress service is unavailable");
  }
  if (!Number.isInteger(wire.status) || (wire.status as number) < 100 || (wire.status as number) > 599 ||
    !Array.isArray(wire.headers) || typeof wire.bodyBase64 !== "string") {
    throw pluginError("NETWORK_EGRESS_UNAVAILABLE", "The egress service returned an invalid response");
  }
  const headers = new Headers();
  try {
    for (const row of wire.headers.slice(0, 64)) {
      if (!row || typeof row !== "object") continue;
      const { name, value } = row as { name?: unknown; value?: unknown };
      if (typeof name === "string" && typeof value === "string") headers.append(name, value);
    }
  } catch {
    throw pluginError("NETWORK_EGRESS_UNAVAILABLE", "The egress service returned an invalid response");
  }
  const body = decodeBase64(wire.bodyBase64);
  return new Response([204, 205, 304].includes(wire.status as number) ? null : body, {
    status: wire.status as number,
    headers,
  });
}

export async function boundedResponseBody(response: Response): Promise<ArrayBuffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_NETWORK_RESPONSE_BYTES) {
    throw pluginError("NETWORK_RESPONSE_TOO_LARGE", "Network response exceeds 2 MB");
  }
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_NETWORK_RESPONSE_BYTES) {
      await reader.cancel();
      throw pluginError("NETWORK_RESPONSE_TOO_LARGE", "Network response exceeds 2 MB");
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined.buffer;
}
