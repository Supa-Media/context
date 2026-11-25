/**
 * `POST /files/data-sync`: the app arming a "Fetch from a URL" source, and asking how its last runs went
 * (`docs/decisions/data-and-metrics.md`, "The sync object"). Under `/files/`, a first segment no workspace can be
 * called, so the address is never read as a workspace's name; the app addresses it as `/@<slug>/files/data-sync`.
 *
 * Body: `{workspaceId, op: "arm", about}` or `{workspaceId, op: "status", about: [paths]}`, where `about` is a
 * source's `about.md` path; or the same with `metric` in its place, a right-now metric's note in the Data folder's
 * `metrics/`, whose hourly reading the sync keeps (`snap.js`). Unknown keys are refused, and so is a body naming both.
 *
 * Who may do what, all checked here before the sync object hears of it:
 * - **The Context app only** (`context_console`), as `/files/write` is: an AI client or Tex writes a source's
 *   `about.md` like any note, and arming it is a person's step in the app (`capabilities.js` says so).
 * - **The session's own workspace only**: the body names it, and a session for any other is refused before
 *   anything is read, so a call addressed to one workspace can never arm another's object.
 * - **Arm: an owner or editor with write**, as the decisions say editors make url sources. A member, a guest
 *   or a read-only connection gets 403 and nothing is asked of any object.
 * - **The source as this person reads it**: its `about.md` must be a note they can read, in a source folder of the
 *   folder doing the Data job (by job, never by name), saying `source: url` with a public https address. What they
 *   cannot read answers exactly as what is not there.
 * - **Status**: the last run of each source whose `about.md` the reader can read; the others are left out.
 *
 * Without the `DATA_SYNC` binding (self-hosting on the free tier) the route answers 501.
 */

import { json } from "../../http/responses.js";
import { hasScope, SCOPE_WRITE } from "../../session.js";
import { normalizePath } from "../../notes/paths.js";
import { objectReader } from "../../store/objectLookup.js";
import { publicHttps } from "../fetch/url.js";
import { frontMatterFields, urlSourceOf } from "./about.js";
import { callDataSync, dataSyncStub } from "./object.js";
import { sourceFolderOf } from "./run.js";
import { keptSheetOf } from "./snap.js";
import { parseFormula } from "../formula/index.js";

export const DATA_SYNC_PATH = "/files/data-sync";

/** The console's client (`CONSOLE_CLIENT_ID` in `apps/convex/functions/agentGrant.ts`). */
const CONSOLE_CLIENT_ID = "context_console";
const MAX_BODY_BYTES = 16 * 1024;
const MAX_STATUS = 50;
const NOT_FOUND = { error: "not_found", message: "That source isn't here." };

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

function parse(body) {
  if (Object.keys(body).some((key) => !["workspaceId", "op", "about", "metric"].includes(key))) return null;
  if (("about" in body) === ("metric" in body)) return null;
  const kind = "metric" in body ? "metric" : "url";
  const { workspaceId, op } = body;
  const about = kind === "metric" ? body.metric : body.about;
  if (typeof workspaceId !== "string" || workspaceId === "" || workspaceId.length > 128) return null;
  const pathOf = (value) => (typeof value === "string" && value.length <= 1024 && !value.includes("\0") ? normalizePath(value) : null);
  if (op === "arm") {
    const path = pathOf(about);
    return path ? { workspaceId, op, kind, about: path } : null;
  }
  if (op === "status") {
    if (!Array.isArray(about) || about.length === 0 || about.length > MAX_STATUS) return null;
    const paths = about.map(pathOf);
    return paths.every(Boolean) ? { workspaceId, op, kind, about: [...new Set(paths)] } : null;
  }
  return null;
}

/**
 * The reader's Data folder and the found rows (with the one note's text when `withBody`), as the object judges them:
 * `about.md`s in source folders, or metric notes directly in `metrics/`.
 */
async function readSources(reader, paths, { withBody = false, kind = "url" } = {}) {
  const { client, judged, settledBehind } = reader;
  const [looked, jobs] = await Promise.all([
    client.rows.lookup({ paths, ...judged, ...(withBody && paths.length === 1 ? { withBody: true } : {}) }),
    client.facts({ ask: "jobs", ...judged }),
  ]);
  if (settledBehind(looked) || settledBehind(jobs)) return null;
  const dataFolder = jobs?.served === true ? (jobs.jobs?.data ?? null) : null;
  const placed = kind === "metric" ? (path) => keptSheetOf(path, dataFolder) !== null : (path) => sourceFolderOf(path, dataFolder) !== null;
  const rows = (looked?.rows ?? []).filter((row) => row?.found === true && row.kind === "file" && placed(row.path) && typeof row.noteId === "string");
  return { rows, dataFolder };
}

/** `(request, store, session, path, env)`, an app route (`http/appRoutes.js`). */
export async function handleDataSync(request, store, session, _path, env) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (session?.actorClientId !== CONSOLE_CLIENT_ID) {
    return json({ error: "forbidden", error_description: "Only the Context app arms a source; write its about.md with any client, then press Sync now on its page." }, 403);
  }
  const body = await readBody(request);
  if (body === null) return json({ error: "invalid_request" }, 400);
  const asked = parse(body);
  if (asked === null) return json({ error: "invalid_request" }, 400);
  // Checked before anything is read: a call filed under one workspace never reaches another's object.
  if (asked.workspaceId !== session.workspaceId) return json({ error: "wrong_workspace" }, 409);
  if (asked.op === "arm" && (!hasScope(session, SCOPE_WRITE) || (session.role !== "owner" && session.role !== "editor"))) {
    return json({ error: "forbidden", message: "Only a workspace's owners and editors can sync a source." }, 403);
  }
  const stub = dataSyncStub(env, session.workspaceId);
  if (stub === null) return json({ error: "not_available", message: "This deployment doesn't sync sources." }, 501);
  const reading = store?.objectReading ?? null;
  const reader = reading === null ? null : objectReader(reading);
  if (reader === null) return json({ error: "not_object", message: "This workspace's notes haven't moved to their new home yet, so it can't sync from a URL." }, 409);

  if (asked.op === "status") {
    let found;
    try {
      found = await readSources(reader, asked.about, { kind: asked.kind });
    } catch {
      return json({ error: "unavailable" }, 503);
    }
    if (found === null) return json({ error: "unavailable" }, 503);
    if (found.rows.length === 0) return json({ sources: [] });
    const answered = await callDataSync(stub, "status", { workspaceId: session.workspaceId, noteIds: found.rows.map((row) => row.noteId) });
    if (answered.status !== 200 || !Array.isArray(answered.body?.sources)) return json({ error: "unavailable" }, 503);
    const pathOf = new Map(found.rows.map((row) => [row.noteId, row.path]));
    const named = asked.kind === "metric" ? "metric" : "about";
    return json({ sources: answered.body.sources.map((source) => ({ [named]: pathOf.get(source.noteId), armed: source.armed === true, last: source.last ?? null })) });
  }

  let found;
  try {
    found = await readSources(reader, [asked.about], { withBody: true, kind: asked.kind });
  } catch {
    return json({ error: "unavailable" }, 503);
  }
  if (found === null) return json({ error: "unavailable" }, 503);
  const row = found.rows[0];
  if (!row) return json(NOT_FOUND, 404);
  const text = row.body?.text;
  if (typeof text !== "string") return json({ error: "unavailable" }, 503);
  if (asked.kind === "metric") return await armMetric(stub, session, row, text);
  const settings = urlSourceOf(text);
  if (!settings.ok) return json({ error: "not_a_url_source", message: `This source can't sync: ${settings.said}.` }, 400);
  if (publicHttps(settings.url) === null) return json({ error: "refused", message: "The address must be https on a public name, with no port, login or IP address." }, 400);
  const answered = await callDataSync(stub, "arm", { workspaceId: session.workspaceId, noteId: row.noteId, armedBy: session.actorUserId });
  if (answered.status !== 200 || answered.body?.error) {
    const said = typeof answered.body?.said === "string" ? answered.body.said : null;
    return json({ error: answered.body?.error ?? "unavailable", ...(said ? { message: said } : {}) }, answered.body?.error === "too_many" ? 409 : 503);
  }
  return json({ about: row.path, armed: answered.body.armed === true, last: answered.body.last ?? null });
}

/** Arming a right-now metric: its formula must parse here; whether it reads only sheets without dates is the run's to say. */
async function armMetric(stub, session, row, text) {
  const parsed = parseFormula(frontMatterFields(text).formula ?? "");
  if (!parsed.ok) return json({ error: "not_a_metric", message: `This metric can't be kept: its formula can't be read (${parsed.error.message}).` }, 400);
  const answered = await callDataSync(stub, "arm", { workspaceId: session.workspaceId, noteId: row.noteId, armedBy: session.actorUserId, kind: "metric" });
  if (answered.status !== 200 || answered.body?.error) {
    const said = typeof answered.body?.said === "string" ? answered.body.said : null;
    return json({ error: answered.body?.error ?? "unavailable", ...(said ? { message: said } : {}) }, answered.body?.error === "too_many" ? 409 : 503);
  }
  return json({ metric: row.path, armed: answered.body.armed === true, last: answered.body.last ?? null });
}
