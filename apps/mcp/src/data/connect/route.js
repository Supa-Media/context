/**
 * `POST /files/data-sync` ops `connect` and `disconnect`: an owner connecting an app (Cloudflare) with a
 * read-only key, or forgetting it (`docs/decisions/data-and-metrics.md`). The shared route (`sync/route.js`) has
 * already checked the Context app is calling, for its own session's workspace, and found the workspace's objects.
 *
 * - **Owners only**, with write: an editor, a member or a read-only connection gets 403 before any object hears.
 * - **Connect** names the source's `about.md`, read as this owner: it must be in a source folder of the folder doing
 *   the Data job and say `source:` an app Context connects. The key goes to the workspace's sync object,
 *   which checks it with the app and keeps it sealed; this route never logs, keeps or answers it.
 * - **Disconnect** names the app.
 */

import { json } from "../../http/responses.js";
import { hasScope, SCOPE_WRITE } from "../../session.js";
import { normalizePath } from "../../notes/paths.js";
import { frontMatterFields } from "../sync/about.js";
import { callDataSync } from "../sync/object.js";
import { appNamed } from "./apps.js";

const MAX_KEY = 512;

/** The connect or disconnect body, or null. Keys beyond these are refused. */
export function parseConnect(body) {
  const { workspaceId, op } = body;
  if (typeof workspaceId !== "string" || workspaceId === "" || workspaceId.length > 128) return null;
  if (op === "connect") {
    if (Object.keys(body).some((key) => !["workspaceId", "op", "about", "key", "account"].includes(key))) return null;
    const about = typeof body.about === "string" && body.about.length <= 1024 && !body.about.includes("\0") ? normalizePath(body.about) : null;
    const key = typeof body.key === "string" ? body.key.trim() : "";
    if (!about || key === "" || key.length > MAX_KEY) return null;
    if (body.account !== undefined && (typeof body.account !== "string" || body.account.length > 64)) return null;
    const account = typeof body.account === "string" && body.account.trim() !== "" ? body.account.trim() : undefined;
    return { workspaceId, op, about, key, ...(account ? { account } : {}) };
  }
  if (op === "disconnect") {
    if (Object.keys(body).some((key) => !["workspaceId", "op", "app"].includes(key))) return null;
    const app = appNamed(body.app);
    return app === null ? null : { workspaceId, op, app };
  }
  return null;
}

const ownerOnly = () => json({ error: "forbidden", message: "Only a workspace's owners can connect or disconnect an app." }, 403);
export const mayConnect = (session) => hasScope(session, SCOPE_WRITE) && session.role === "owner";

/** `readSource(path)` answers the found `about.md` row with its body, or null when this owner can't see one there. */
export async function handleConnect({ asked, session, stub, readSource }) {
  if (!mayConnect(session)) return ownerOnly();
  if (asked.op === "disconnect") {
    const answered = await callDataSync(stub, "disconnect", { workspaceId: session.workspaceId, app: asked.app });
    if (answered.status !== 200 || answered.body?.error) return json({ error: "unavailable" }, 503);
    return json({ app: asked.app, disconnected: answered.body.disconnected === true });
  }
  let row;
  try {
    row = await readSource(asked.about);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
  if (row === undefined) return json({ error: "unavailable" }, 503);
  if (row === null) return json({ error: "not_found", message: "That source isn't here." }, 404);
  const text = row.body?.text;
  if (typeof text !== "string") return json({ error: "unavailable" }, 503);
  const app = appNamed(frontMatterFields(text).source);
  if (app === null) return json({ error: "not_an_app_source", message: "This source's about.md doesn't name an app Context connects." }, 400);
  const answered = await callDataSync(stub, "connect", {
    workspaceId: session.workspaceId,
    noteId: row.noteId,
    armedBy: session.actorUserId,
    app,
    key: asked.key,
    ...(asked.account ? { account: asked.account } : {}),
  });
  const said = typeof answered.body?.said === "string" ? answered.body.said : null;
  if (answered.body?.error === "refused") return json({ error: "refused", message: said ?? "The app refused that key." }, 400);
  if (answered.status !== 200 || answered.body?.error) {
    return json({ error: answered.body?.error ?? "unavailable", ...(said ? { message: said } : {}) }, answered.body?.error === "too_many" ? 409 : 503);
  }
  return json({ about: row.path, app, armed: answered.body.armed === true, last: answered.body.last ?? null });
}
