/**
 * `/tex/computer` — the person's own look at, and hands on, the browser Tex
 * drives for them, for the Context app's page at `context.lc/tex/<handle>`.
 *
 *  - `POST /tex/computer`        `{ handle }` → `{ running: false }` or
 *    `{ running: true, url, title, width, height, scale?, frame }` (a base64
 *    JPEG; `scale` is its pixels per CSS pixel)
 *  - `POST /tex/computer/input`  `{ handle, action }` → the same, after it
 *  - `POST /tex/computer/stop`   `{ handle }` → `{ closed: true }`
 *
 * **Who may.** The browser is found in `infra/site-shots` by the person's tag,
 * `browserOwner(env, userId)`: an HMAC of their user id under this gateway's
 * secret. So the tag is made here, from the user the bearer token resolves to,
 * and never from anything in the request. That alone means a caller can only
 * ever reach their own browser. On top of it:
 *
 *  - **The Context app's own client only** (`context_console`), as for
 *    `/approvals`. An MCP client holding the person's grant must not see the
 *    pages they are signed in to, or type into them: that would be a model
 *    driving the browser the person took over precisely so that it would not.
 *  - **The handle must be the caller's own**, the slug of the personal
 *    workspace they own. The page is addressed by handle; a signed-in person
 *    opening somebody else's address is told "not yours" by the gateway too,
 *    rather than shown their own browser under another name.
 *
 * **What is never kept or logged.** Frames, addresses, titles and the words a
 * person types pass through and are not written anywhere; the log line names
 * the route, the action's kind, the outcome, the workspace and the grant.
 */

import { browserOwner } from "../agent/browserProviders.js";
import { createControlPlane } from "../controlPlane.js";
import { forbiddenResponse, unauthorizedResponse } from "../oauth.js";
import { bearerToken, resolveSession, SessionRefusal } from "../session.js";
import { json } from "./responses.js";

/** The console's client (`CONSOLE_CLIENT_ID` in `apps/convex/functions/agentGrant.ts`). */
const CONSOLE_CLIENT_ID = "context_console";

export const TEX_COMPUTER_PATHS = new Set(["/tex/computer", "/tex/computer/input", "/tex/computer/stop"]);

/** The most one request may carry: a frame request is tiny, typing is capped at 1,000 characters. */
const MAX_BODY_BYTES = 8_192;

const ACTION_KINDS = new Set(["tap", "move", "type", "key", "scroll", "back"]);

/** The largest frame scale passed on: a JPEG at more than device pixels is not a frame this Worker takes. */
const MAX_SCALE = 4;

/** The named fields of `raw` that are present, and nothing else. */
function pick(raw, names) {
  const out = {};
  for (const name of names) if (raw[name] !== undefined) out[name] = raw[name];
  return out;
}

/**
 * The handle a person's own page lives at: the slug of the personal workspace
 * they own, or null. Never somebody else's personal workspace they are a
 * member of, which also has kind "personal".
 */
export function ownHandle(session) {
  const own = (session?.workspaces || []).find((w) => w?.kind === "personal" && w?.role === "owner");
  return typeof own?.slug === "string" && own.slug ? own.slug : null;
}

/**
 * The page Tex texts when the person must take over, or null when this
 * deployment has no https app origin or the person has no handle.
 */
export function texViewerUrl(env, session) {
  const handle = ownHandle(session);
  const origin = typeof env?.APP_ORIGIN === "string" ? env.APP_ORIGIN : "";
  if (handle === null || !/^https:\/\/[^/]+$/.test(origin.replace(/\/$/, ""))) return null;
  return `${origin.replace(/\/$/, "")}/tex/${handle}`;
}

/** The action, rebuilt from named fields only. The screenshot Worker bounds every value. */
function actionFrom(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || !ACTION_KINDS.has(raw.kind)) return null;
  switch (raw.kind) {
    case "tap":
      return { kind: "tap", x: raw.x, y: raw.y, ...pick(raw, ["button"]) };
    case "move":
      return { kind: "move", x: raw.x, y: raw.y };
    case "type":
      return { kind: "type", text: raw.text };
    case "key":
      return { kind: "key", name: raw.name };
    case "scroll":
      return { kind: "scroll", ...pick(raw, ["x", "y", "dx", "dy"]) };
    default:
      return { kind: "back" };
  }
}

/** A frame, field by field: nothing the screenshot Worker adds later reaches the app unread. */
function frameFrom(body) {
  if (body?.running !== true) return { running: false };
  if (typeof body.frame !== "string" || typeof body.width !== "number" || typeof body.height !== "number") return null;
  return {
    running: true,
    url: typeof body.url === "string" ? body.url : "",
    title: typeof body.title === "string" ? body.title : "",
    width: body.width,
    height: body.height,
    ...(typeof body.scale === "number" && body.scale > 0 && body.scale <= MAX_SCALE ? { scale: body.scale } : {}),
    frame: body.frame,
  };
}

async function readBody(request) {
  const text = await request.text().catch(() => null);
  if (text === null || text.length > MAX_BODY_BYTES) return null;
  try {
    const body = JSON.parse(text);
    return body !== null && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

export async function handleTexComputer(request, env, { path, origin }) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const started = Date.now();
  let session;
  try {
    session = await resolveSession(bearerToken(request), null, createControlPlane(env));
  } catch (error) {
    if (!(error instanceof SessionRefusal)) throw error;
    return error.status === 403 ? forbiddenResponse(origin, null, error) : unauthorizedResponse(origin, null, error);
  }
  const log = (outcome, kind = null) =>
    console.log(
      JSON.stringify({
        event: "tex_computer",
        route: path,
        ...(kind ? { action: kind } : {}),
        outcome,
        workspace_id: session.workspaceId ?? null,
        grant_id: session.grantId ?? null,
        ms: Date.now() - started,
      }),
    );
  if (session.actorClientId !== CONSOLE_CLIENT_ID) {
    log("not_console");
    return json({ error: "forbidden", error_description: "Only the Context app can show this browser." }, 403);
  }
  const body = await readBody(request);
  if (body === null) return json({ error: "invalid_request", error_description: "Expected a JSON body." }, 400);
  const handle = typeof body.handle === "string" ? body.handle.replace(/^@/, "").toLowerCase() : "";
  const mine = ownHandle(session);
  if (mine === null || handle !== mine) {
    log("not_yours");
    return json({ error: "not_yours", error_description: "This page belongs to someone else." }, 403);
  }
  let action = null;
  if (path === "/tex/computer/input") {
    action = actionFrom(body.action);
    if (action === null) return json({ error: "invalid_request", error_description: "That action could not be read." }, 400);
  }
  const binding = env?.SITE_SHOTS;
  const owner = await browserOwner(env, session.actorUserId);
  if (typeof binding?.fetch !== "function" || owner === null) {
    log("unavailable");
    return path === "/tex/computer/stop" ? json({ closed: true }) : json({ running: false });
  }
  const [target, forwarded] =
    path === "/tex/computer/stop"
      ? ["/browse/close", { provider: "browserbase", owner }]
      : path === "/tex/computer/input"
        ? ["/view/input", { owner, action }]
        : ["/view/frame", { owner }];
  let response;
  try {
    response = await binding.fetch(`https://site-shots${target}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(forwarded),
    });
  } catch {
    log("unreachable", action?.kind);
    return json({ error: "unavailable", error_description: "The browser could not be reached." }, 502);
  }
  const answer = await response.json().catch(() => null);
  if (path === "/tex/computer/stop") {
    // A Worker without Browserbase has nothing to release: closed either way.
    log(response.ok || response.status === 501 ? "closed" : "failed");
    return response.ok || response.status === 501
      ? json({ closed: true })
      : json({ error: "unavailable", error_description: "The browser could not be stopped." }, 502);
  }
  if (response.status === 400) {
    log("refused", action?.kind);
    return json({ error: "invalid_request", error_description: "That action could not be read." }, 400);
  }
  const frame = response.ok ? frameFrom(answer) : null;
  if (frame === null) {
    log("failed", action?.kind);
    return json({ error: "unavailable", error_description: "The browser could not do that." }, 502);
  }
  log(frame.running ? "shown" : "not_running", action?.kind);
  return json(frame);
}
