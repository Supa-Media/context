/**
 * The container's HTTP surface. Dependency-free: the runtime (which imports
 * the SDK) is passed in, so the routes are testable without installing it.
 *
 *   GET  /ready                 process is up
 *   GET  /health                frontiers and queue depth, last four digits only
 *   GET  /logs?after=id         the container's log records since `id` (see log.mjs)
 *   POST /start                 {checkpoints} mint tokens and start listeners
 *   GET  /next?wait=ms          the oldest unacked event, or 204
 *   POST /ack                   {id} the object stored the event
 *   POST /<op>                  the ops in validate.mjs (send/text, edit, ...)
 *   GET  /attachment/<guid>     the attachment's bytes, streamed
 */
import http from "node:http";
import { describeError, RequestError } from "./errors.mjs";
import { opFor, parseAttachmentQuery, parseGuid, parseLine } from "./validate.mjs";

const MAX_BODY_BYTES = 40 * 1024 * 1024;
const MAX_WAIT_MS = 25000;
const ID = /^[A-Za-z0-9]{1,16}:[0-9]{1,15}$/;

function send(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new RequestError(413, "body_too_large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError(400, "invalid_json");
  }
}

function parseCheckpoints(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new RequestError(400, "invalid_checkpoints");
  const out = {};
  for (const [line, seq] of Object.entries(value)) {
    parseLine(line);
    if (!Number.isSafeInteger(seq) || seq < 0) throw new RequestError(400, "invalid_checkpoints");
    out[line] = seq;
  }
  return out;
}

function waitMs(raw) {
  const value = Number(raw ?? 0);
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(value, MAX_WAIT_MS);
}

export function createApp({ runtime, log = () => {}, ring, now = Date.now }) {
  async function handle(req, res, url) {
    const path = url.pathname;
    if (req.method === "GET" && path === "/ready") return send(res, 200, { ok: true });
    if (req.method === "GET" && path === "/health") return send(res, 200, runtime.health());
    if (req.method === "GET" && path === "/logs") {
      return send(res, 200, ring ? ring.after(Number(url.searchParams.get("after") ?? 0)) : { boot: "", next: 0, records: [] });
    }

    if (req.method === "POST" && path === "/start") {
      const body = await readJson(req);
      await runtime.start(parseCheckpoints(body.checkpoints));
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET" && path === "/next") {
      const item = await runtime.nextEvent(waitMs(url.searchParams.get("wait")));
      if (!item) {
        res.writeHead(204);
        return res.end();
      }
      return send(res, 200, item);
    }

    if (req.method === "POST" && path === "/ack") {
      const body = await readJson(req);
      if (typeof body.id !== "string" || !ID.test(body.id)) throw new RequestError(400, "invalid_id");
      const result = runtime.ack(body.id);
      if (!result) return send(res, 404, { ok: false, status: 404, error: "unknown_event" });
      return send(res, 200, { ok: true, line: result.line, frontier: result.frontier });
    }

    if (req.method === "GET" && path.startsWith("/attachment/")) {
      const guid = parseGuid(decodeURIComponent(path.slice("/attachment/".length)), "guid");
      const line = parseAttachmentQuery(url.searchParams.get("line") ?? undefined);
      const opened = await runtime.openAttachment(guid, line);
      res.writeHead(200, { "content-type": opened.info.mimeType || "application/octet-stream" });
      for await (const chunk of opened.chunks) res.write(chunk);
      return res.end();
    }

    const name = path.slice(1);
    const spec = opFor(name);
    if (spec && req.method === spec.method) {
      const started = now();
      const body = await readJson(req);
      const args = spec.parse(body);
      const result = await runtime.execute(name, args);
      log({ event: "op", op: name, line: args.line, ok: true, status: 200, ms: now() - started });
      return send(res, 200, result);
    }

    return send(res, 404, { ok: false, status: 404, error: "not_found" });
  }

  return http.createServer(async (req, res) => {
    const started = now();
    const url = new URL(req.url ?? "/", "http://container");
    try {
      await handle(req, res, url);
    } catch (error) {
      const { status, body } = describeError(error);
      if (res.headersSent) {
        res.destroy();
      } else {
        send(res, status, body);
      }
      const op = url.pathname.startsWith("/attachment/") ? "attachment" : url.pathname.slice(1, 40);
      log({ event: "op", op, ok: false, status, error: body.error, ms: now() - started });
    }
  });
}
