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
 * - **GitHub** is installed, not pasted (`githubApp.js`): `github_start` names its `about.md` and answers GitHub's
 *   install address with a state signed for this workspace, this owner and that source; `github_finish` brings back
 *   that state with GitHub's one-time code and installation id, and is refused unless the state is this owner's own,
 *   for this workspace, and fresh; `github_repos` lists the installation's repositories, or sets the ones it reads.
 */

import { json } from "../../http/responses.js";
import { hasScope, SCOPE_WRITE } from "../../session.js";
import { normalizePath } from "../../notes/paths.js";
import { frontMatterFields } from "../sync/about.js";
import { callDataSync } from "../sync/object.js";
import { appNamed } from "./apps.js";
import { githubAppOf, installState, installUrl, readInstallState } from "./githubApp.js";

const MAX_KEY = 512;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
export const CONNECT_OPS = Object.freeze(["connect", "disconnect", "github_start", "github_finish", "github_repos"]);
const only = (body, keys) => !Object.keys(body).some((key) => !keys.includes(key));
const aboutOf = (value) => (typeof value === "string" && value.length <= 1024 && !value.includes("\0") ? normalizePath(value) : null);

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
  if (op === "github_start") {
    const about = only(body, ["workspaceId", "op", "about"]) ? aboutOf(body.about) : null;
    return about ? { workspaceId, op, about } : null;
  }
  if (op === "github_finish") {
    if (!only(body, ["workspaceId", "op", "state", "code", "installation"])) return null;
    const { state, code, installation } = body;
    if (typeof state !== "string" || state.length > 600 || typeof code !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(code)) return null;
    if (typeof installation !== "string" || !/^[0-9]{1,15}$/.test(installation)) return null;
    return { workspaceId, op, state, code, installation };
  }
  if (op === "github_repos") {
    if (!only(body, ["workspaceId", "op", "set"])) return null;
    if (body.set === undefined) return { workspaceId, op };
    if (!Array.isArray(body.set) || body.set.length === 0 || body.set.length > 10 || body.set.some((name) => typeof name !== "string" || !REPO.test(name))) return null;
    return { workspaceId, op, set: [...new Set(body.set)] };
  }
  return null;
}

const ownerOnly = () => json({ error: "forbidden", message: "Only a workspace's owners can connect or disconnect an app." }, 403);
export const mayConnect = (session) => hasScope(session, SCOPE_WRITE) && session.role === "owner";

/** `readSource(path)` answers the found `about.md` row with its body, or null when this owner can't see one there. */
export async function handleConnect({ asked, session, stub, readSource, env, now = Date.now() }) {
  if (!mayConnect(session)) return ownerOnly();
  if (asked.op === "github_finish") return await finishGithub({ asked, session, stub, env, now });
  if (asked.op === "github_repos") return await githubRepos({ asked, session, stub });
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
  if (asked.op === "github_start") return await startGithub({ app, row, session, env, now });
  // GitHub is installed through its own page, never with a pasted key.
  if (app === "github") return json({ error: "not_an_app_source", message: "GitHub is connected by installing Context's GitHub App." }, 400);
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

const noGithubApp = () => json({ error: "not_available", message: "This deployment has no GitHub App set up." }, 501);

/** The install address, its state signed for this workspace, this owner and this source. */
async function startGithub({ app, row, session, env, now }) {
  if (app !== "github") return json({ error: "not_an_app_source", message: "This source's about.md doesn't say source: github." }, 400);
  const github = githubAppOf(env);
  if (github === null) return noGithubApp();
  const state = await installState({ secret: env?.GATEWAY_SECRET, workspaceId: session.workspaceId, userId: session.actorUserId, noteId: row.noteId, nowMs: now });
  return json({ about: row.path, app, url: installUrl(github, state) });
}

/** The owner back from GitHub: their own state, for this workspace, still fresh; then the object checks the rest. */
async function finishGithub({ asked, session, stub, env, now }) {
  if (githubAppOf(env) === null) return noGithubApp();
  const state = await readInstallState({ secret: env?.GATEWAY_SECRET, state: asked.state, nowMs: now });
  if (state === null) return json({ error: "refused", message: "This GitHub link has expired. Connect GitHub again from the data page." }, 400);
  if (state.workspaceId !== session.workspaceId || state.userId !== session.actorUserId) {
    return json({ error: "forbidden", message: "This GitHub link was started by someone else, or for another workspace." }, 403);
  }
  const answered = await callDataSync(stub, "connect", {
    workspaceId: session.workspaceId,
    noteId: state.noteId,
    armedBy: session.actorUserId,
    app: "github",
    key: asked.code,
    installation: asked.installation,
  });
  const said = typeof answered.body?.said === "string" ? answered.body.said : null;
  if (answered.body?.error === "refused") return json({ error: "refused", message: said ?? "GitHub didn't confirm the installation." }, 400);
  if (answered.status !== 200 || answered.body?.error) {
    return json({ error: answered.body?.error ?? "unavailable", ...(said ? { message: said } : {}) }, answered.body?.error === "too_many" ? 409 : 503);
  }
  return json({ app: "github", armed: answered.body.armed === true, last: answered.body.last ?? null });
}

/** The installation's repositories and the ones read, or the owner's pick of them. */
async function githubRepos({ asked, session, stub }) {
  const answered = await callDataSync(stub, "repos", { workspaceId: session.workspaceId, ...(asked.set ? { set: asked.set } : {}) });
  const said = typeof answered.body?.said === "string" ? answered.body.said : null;
  if (answered.body?.error === "not_connected") return json({ error: "not_connected", message: said ?? "GitHub isn't connected." }, 409);
  if (answered.body?.error === "bad_call") return json({ error: "invalid_request", ...(said ? { message: said } : {}) }, 400);
  if (answered.status !== 200 || answered.body?.error || !Array.isArray(answered.body?.repos)) return json({ error: "unavailable", ...(said ? { message: said } : {}) }, 503);
  return json({ app: "github", repos: answered.body.repos, picked: answered.body.picked ?? null });
}
