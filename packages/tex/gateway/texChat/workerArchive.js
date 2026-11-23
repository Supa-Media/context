/**
 * A sealed copy of a texting Worker chat box that no name Tex knows leads to (part C of the runtime simplification, Dev2
 * approved https://claude.ai/artifact/AcEGnAtBKWqeTAcXa1vveX; Dev2 2026-11-23: archive the leftovers before the
 * Worker's SenderInbox class is deleted). The Worker's census found boxes holding data that can't be moved by name; each
 * is copied here whole, into a `TexChat` object of its own, `archive:<worker object id>`, before the class goes.
 *
 * Nothing reads an archive back: no request answers its values, and the gateway never opens it as a chat. It answers
 * only when it was kept and how many keys. Durable Object storage is encrypted at rest. Putting one back is a staff
 * step of its own, from this object, if a person ever asks for what was in it.
 */

/** An archive object's name: the Worker object's id, 64 hex. */
const ARCHIVE_NAME = /^archive:[0-9a-f]{64}$/;
/** The path an archive object answers. */
export const ARCHIVE_PATH = "/worker-archive";
/** The texting Worker's door to keep an archive, on `TexTexts`. */
export const TEXTS_ARCHIVE_PATH = "/texts/worker-archive";
/** Set once an archive is kept: when, and how many keys. An archive is written once and never replaced. */
const KEPT_KEY = "__archive_kept";
/** Each archived key, under this prefix, with its value as the Worker held it. */
const ENTRY_PREFIX = "a:";
/** At most this many keys one archive keeps; a box holding more is refused whole, never cut short. */
export const ARCHIVE_KEYS = 2000;
/** At most this many characters of JSON one archive takes. */
const ARCHIVE_CHARS = 16 * 1024 * 1024;
const OBJECT_ID = /^[0-9a-f]{64}$/;

export function archiveName(workerId) {
  return `archive:${workerId}`;
}

/** Whether this object's name (from the caller's `x-inbox-name`) is an archive's. */
export function isArchiveName(name) {
  return typeof name === "string" && ARCHIVE_NAME.test(name);
}

/** The entries of an archive body, or null: `[[key, value], ...]`, each key a non-empty string, at most `ARCHIVE_KEYS`. */
function entriesOf(body) {
  const entries = body?.entries;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > ARCHIVE_KEYS) return null;
  const keys = new Set();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || entry[0] === "" || entry[0].length > 512 || keys.has(entry[0])) return null;
    keys.add(entry[0]);
  }
  return entries;
}

/**
 * One call to an archive object. POST `{ entries }` keeps the box once (a second POST answers `already`, the first copy
 * kept); GET answers whether it is kept and how many keys, never a value.
 */
export async function serveArchive(request, storage) {
  if (request.method === "GET") {
    const kept = await storage.get(KEPT_KEY);
    return kept === undefined ? Response.json({ kept: false }, { status: 404 }) : Response.json({ kept: true, at: kept.at, keys: kept.keys });
  }
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const text = await request.text().catch(() => "");
  if (text.length > ARCHIVE_CHARS) return Response.json({ error: "too_large" }, { status: 413 });
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  const entries = entriesOf(body);
  if (entries === null) return new Response(null, { status: 400 });
  const kept = await storage.get(KEPT_KEY);
  if (kept !== undefined) return Response.json({ kept: true, already: true, keys: kept.keys });
  for (let at = 0; at < entries.length; at += 128) {
    await storage.put(Object.fromEntries(entries.slice(at, at + 128).map(([key, value]) => [`${ENTRY_PREFIX}${key}`, value])));
  }
  const record = { at: Date.now(), keys: entries.length };
  await storage.put(KEPT_KEY, record);
  return Response.json({ kept: true, keys: record.keys });
}

/** The texting Worker's door (`TexTexts` `/texts/worker-archive`): POST `{ id, entries }`, kept in `archive:<id>`. */
export async function archiveForTexts(request, env) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (env?.TEX_CHAT === undefined) return Response.json({ error: "no_chat_home" }, { status: 501 });
  const text = await request.text().catch(() => "");
  if (text.length > ARCHIVE_CHARS) return Response.json({ error: "too_large" }, { status: 413 });
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (typeof body?.id !== "string" || !OBJECT_ID.test(body.id) || entriesOf(body) === null) return new Response(null, { status: 400 });
  const { objectByName } = await import("../../../../apps/mcp/src/objectPlace.js");
  const name = archiveName(body.id);
  const answer = await objectByName(env.TEX_CHAT, name).fetch(`https://chat${ARCHIVE_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-inbox-name": name },
    body: JSON.stringify({ entries: body.entries }),
  });
  console.log(JSON.stringify({ event: "tex_worker_archive", status: answer.status }));
  return answer;
}
