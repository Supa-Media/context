import http from "node:http";
import { pathToFileURL } from "node:url";

import { EgressError, pinnedRequest } from "./request.mjs";

const MAX_REQUEST_BYTES = 3 * 1024 * 1024;

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

async function body(request) {
  const chunks = [];
  let total = 0;
  for await (const raw of request) {
    const chunk = Buffer.from(raw);
    total += chunk.length;
    if (total > MAX_REQUEST_BYTES) throw new EgressError("INVALID_REQUEST", "Request is too large");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
    throw new EgressError("INVALID_REQUEST", "Request must be JSON");
  }
}

export function createServer(run = pinnedRequest) {
  return http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/ready") {
        return json(response, 200, { ok: true });
      }
      if (request.method === "GET" && request.url === "/health") {
        const probe = await run({ url: "https://example.com/", method: "HEAD", headers: [] });
        return json(response, 200, { ok: true, dns: true, tls: true, pinned: true, upstreamStatus: probe.status });
      }
      if (request.method !== "POST" || request.url !== "/request") {
        return json(response, 404, { ok: false });
      }
      const result = await run(await body(request));
      return json(response, 200, { ok: true, ...result });
    } catch (error) {
      const code = error instanceof EgressError ? error.code : "NETWORK_EGRESS_UNAVAILABLE";
      const message = error instanceof EgressError ? error.message : "The egress service is unavailable";
      const status = code === "NETWORK_PRIVATE_ADDRESS_DENIED" ? 403
        : code === "NETWORK_RESPONSE_TOO_LARGE" || code === "INVALID_REQUEST" ? 413 : 502;
      return json(response, status, { ok: false, error: { code, message } });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createServer().listen(8080, "0.0.0.0");
}
