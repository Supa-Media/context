/**
 * `POST /files/folder-notes`: a folder page's notes, each with its front matter, first heading and first paragraph,
 * answered by the workspace's object (its rows and its facts) with no control plane on the way.
 *
 * Owner, 2026-11-24, of the Areas page: "it takes like 3 seconds to load", and then, "we should just be able to talk
 * directly to cloudflare". The app asked the control plane's `folderNotes`, which reached this same object several
 * times over (its home, its rows, a ticket, its facts) before answering, about half a second to two seconds a page.
 * Here the listing is one object call and the facts one call per hundred notes, all in the gateway's own account.
 *
 * The answer is the shape `folderNotes` answers (`FolderNotesResult`, `apps/convex/functions/lib/filesFns/folderNotes.ts`):
 * every visible Markdown note in the folder (directly, or beneath it with `subfolders`), its props as the JSON the
 * facts keep, a sealed note left out, a note whose facts the object could not read listed as `missing`. What this
 * route does not serve answers 409 `not_object`, and the app asks the control plane as before: a workspace whose
 * notes are not in its object yet, one behind on a change, a reader the object cannot judge.
 *
 * Who may see each note is judged twice, as the agent tools' listing judges it: by the object, which lists only what
 * the reader may see (`workspaceStore/manifest.js`), and here again with `canSee` over the rules the session reads, so
 * neither alone decides. Facts are asked only for notes that passed both. A folder the reader cannot see answers as an
 * empty one.
 */

import { canSee, isPlumbing } from "../privacy/engine.js";
import { json } from "../http/responses.js";
import { hasScope, SCOPE_READ } from "../session.js";
import { normalizePath } from "../notes/paths.js";
import { loadPrivacyState } from "../privacy/state.js";
import { objectReader } from "../store/objectLookup.js";

export const FOLDER_NOTES_PATH = "/files/folder-notes";

/** Notes one answer carries at most, as the control plane's page (`FOLDER_PAGE_ROWS`). */
export const FOLDER_PAGE_NOTES = 2_000;
/** Paths one facts ask names (`workspaceStore/facts.js` `PROPS_ASK_PATHS`). */
const PROPS_PER_ASK = 100;
/** Facts asks in flight at once. */
const PROPS_CONCURRENCY = 8;

const MAX_BODY_BYTES = 4 * 1024;
const MAX_PATH = 1024;
const FIELDS = new Set(["folder", "subfolders", "cursor"]);

const notServed = () => json({ error: "not_object" }, 409);

async function readBody(request) {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return null;
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) return null;
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    return body !== null && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/** `""` for the workspace's root, a normalized folder path, or `null` for one this route does not take. */
function folderOf(raw) {
  if (raw === "") return "";
  if (typeof raw !== "string" || raw.length > MAX_PATH || raw.includes("\0")) return null;
  const folder = normalizePath(raw);
  if (!folder || isPlumbing(folder) || folder.split("/").some((segment) => segment.startsWith("."))) return null;
  return folder;
}

function inFolder(path, prefix, subfolders) {
  if (!path.startsWith(prefix) || !path.endsWith(".md")) return false;
  const rest = path.slice(prefix.length);
  if (rest.split("/").some((segment) => segment.startsWith("."))) return false;
  return subfolders || !rest.includes("/");
}

/** Run `work` over `items` with at most `limit` in flight, answers in order. */
async function inBatches(items, limit, work) {
  const answers = [];
  for (let at = 0; at < items.length; at += limit) answers.push(...(await Promise.all(items.slice(at, at + limit).map(work))));
  return answers;
}

/** Serves one folder page for `session` on `store`, the request's own store (`objectReading` names its object). */
export async function handleFolderNotes(request, store, session) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!hasScope(session, SCOPE_READ)) return json({ error: "forbidden" }, 403);
  const body = await readBody(request);
  if (body === null || Object.keys(body).some((key) => !FIELDS.has(key))) return json({ error: "invalid_request" }, 400);
  const folder = folderOf(body.folder);
  if (folder === null) return json({ error: "invalid_path" }, 400);
  if (body.subfolders !== undefined && typeof body.subfolders !== "boolean") return json({ error: "invalid_request" }, 400);
  const cursor = body.cursor === undefined || body.cursor === null ? null : body.cursor;
  if (cursor !== null && (typeof cursor !== "string" || cursor.length > MAX_PATH || cursor.includes("\0"))) return json({ error: "invalid_request" }, 400);
  const subfolders = body.subfolders === true;

  const reader = objectReader(store?.objectReading ?? {});
  if (reader === null || typeof reader.client.rows?.manifest !== "function" || typeof reader.client.facts !== "function") return notServed();
  const { client, judged, settledBehind } = reader;

  const [privacy, listing] = await Promise.all([
    loadPrivacyState(store),
    client.rows.manifest({ folder, ...(cursor === null ? {} : { cursor }), ...judged }).catch(() => null),
  ]);
  if (privacy.error) return json({ error: "unavailable" }, 503);
  if (listing === null) return json({ error: "unavailable" }, 503);
  if (settledBehind(listing)) return notServed();
  if (listing?.served !== true || !Array.isArray(listing.entries)) return notServed();
  const { rules, overrides } = privacy;
  const names = session.grantedGroups;

  const prefix = folder === "" ? "" : `${folder}/`;
  const page = listing.entries.slice(0, FOLDER_PAGE_NOTES);
  const more = listing.entries.length > FOLDER_PAGE_NOTES || typeof listing.cursor === "string";
  const next = !more ? null : listing.entries.length > FOLDER_PAGE_NOTES ? page[page.length - 1].path : listing.cursor;
  const visible = page.filter(
    (entry) =>
      entry && typeof entry.path === "string" && inFolder(entry.path, prefix, subfolders) && canSee(entry.path, session.scope, rules, overrides, names),
  );

  const paths = visible.map((entry) => entry.path);
  const asks = [];
  for (let at = 0; at < paths.length; at += PROPS_PER_ASK) asks.push(paths.slice(at, at + PROPS_PER_ASK));
  let answers;
  try {
    answers = await inBatches(asks, PROPS_CONCURRENCY, (batch) => client.facts({ ask: "props", paths: batch, ...judged }));
  } catch {
    return json({ error: "unavailable" }, 503);
  }
  const props = new Map();
  for (const answer of answers) {
    if (settledBehind(answer)) return notServed();
    if (answer?.served !== true || !Array.isArray(answer.props)) return notServed();
    for (const row of answer.props) if (row && typeof row.path === "string") props.set(row.path, row);
  }

  const notes = [];
  const missing = [];
  for (const entry of visible) {
    const row = props.get(entry.path);
    // Sealed: its front matter is sealed too, so it is left out, as the control plane leaves it out.
    if (row?.sealed === true) continue;
    if (row === undefined || typeof row.props !== "string") {
      missing.push(entry.path);
      continue;
    }
    notes.push({
      path: entry.path,
      ...(Number.isFinite(entry.updatedAt) ? { updatedAt: entry.updatedAt } : {}),
      ...(Number.isFinite(entry.size) ? { size: entry.size } : {}),
      props: row.props,
    });
  }
  return json({ kind: "folderNotes", available: true, notes, cursor: next, missing, fill: false });
}
