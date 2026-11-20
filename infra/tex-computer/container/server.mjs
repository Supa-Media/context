/**
 * Tex's computer, inside the container: a small HTTP server its Durable Object (`../src/index.ts`) talks to on port
 * 8080. Nothing else reaches it: the container has no internet and no public address. It runs commands and reads and
 * writes files, all inside the work folder (`files.mjs`), as the unprivileged user the image runs as.
 */
import { createServer } from "node:http";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { realWorkPath, WORK } from "./files.mjs";
import { MAX_COMMAND_CHARS, runCommand } from "./run.mjs";

export const MAX_READ_BYTES = 512 * 1024;
export const MAX_WRITE_CHARS = 1024 * 1024;
export const MAX_LIST = 500;

const ENV = { HOME: WORK, PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", TERM: "dumb" };

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

async function body(req, max) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw Object.assign(new Error("too large"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("not JSON"), { status: 400 });
  }
}

const refuse = (status, error) => ({ status, value: { ok: false, error } });

/** The answer to one request: `{ status, value }`. Exported for the tests. */
export async function handle(op, input) {
  if (op === "run") {
    const command = typeof input.command === "string" ? input.command : "";
    if (command.trim() === "" || command.length > MAX_COMMAND_CHARS) return refuse(400, `a command of 1 to ${MAX_COMMAND_CHARS} characters`);
    const cwd = await realWorkPath(typeof input.cwd === "string" ? input.cwd : "");
    if (cwd === null) return refuse(400, "cwd must be inside the work folder");
    await mkdir(cwd, { recursive: true });
    const ran = await runCommand(command, { cwd, timeoutMs: input.timeoutMs, env: ENV });
    return { status: 200, value: { ok: ran.started && ran.exitCode === 0, ...ran } };
  }
  if (op === "read") {
    const path = await realWorkPath(input.path);
    if (path === null) return refuse(400, "path must be inside the work folder");
    const info = await stat(path).catch(() => null);
    if (info === null) return refuse(404, "no such file");
    if (!info.isFile()) return refuse(400, "not a file");
    if (info.size > MAX_READ_BYTES) return refuse(413, `the file is ${info.size} bytes; read at most ${MAX_READ_BYTES}, or run a command that prints part of it`);
    const bytes = await readFile(path);
    if (bytes.includes(0)) return { status: 200, value: { ok: true, binary: true, bytes: info.size } };
    return { status: 200, value: { ok: true, text: bytes.toString("utf8"), bytes: info.size } };
  }
  if (op === "write") {
    const path = await realWorkPath(input.path);
    if (path === null || typeof input.path !== "string" || input.path.trim() === "") return refuse(400, "path must name a file inside the work folder");
    const content = typeof input.content === "string" ? input.content : null;
    if (content === null || content.length > MAX_WRITE_CHARS) return refuse(400, `content of at most ${MAX_WRITE_CHARS} characters`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
    return { status: 200, value: { ok: true, bytes: Buffer.byteLength(content) } };
  }
  if (op === "list") {
    const path = await realWorkPath(typeof input.path === "string" ? input.path : "");
    if (path === null) return refuse(400, "path must be inside the work folder");
    const entries = await readdir(path, { withFileTypes: true }).catch(() => null);
    if (entries === null) return refuse(404, "no such folder");
    const shown = await Promise.all(
      entries.slice(0, MAX_LIST).map(async (entry) => {
        const size = entry.isFile() ? (await stat(`${path}/${entry.name}`).catch(() => null))?.size ?? null : null;
        return { name: entry.name, type: entry.isDirectory() ? "folder" : entry.isFile() ? "file" : "other", ...(size !== null ? { bytes: size } : {}) };
      }),
    );
    return { status: 200, value: { ok: true, folder: relative(WORK, path) || ".", entries: shown, more: Math.max(0, entries.length - MAX_LIST) } };
  }
  return refuse(404, "unknown operation");
}

export function serve(port = 8080) {
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true });
      const op = req.method === "POST" ? /^\/(run|read|write|list)$/.exec(req.url ?? "")?.[1] : undefined;
      if (!op) return json(res, 404, { ok: false, error: "not found" });
      const input = await body(req, MAX_WRITE_CHARS * 2);
      const { status, value } = await handle(op, input);
      json(res, status, value);
    } catch (error) {
      json(res, error?.status ?? 500, { ok: false, error: error?.status ? error.message : "the computer failed" });
    }
  });
  server.listen(port);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) serve(Number(process.env.PORT ?? 8080));
