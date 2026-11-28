/**
 * A person's own Tex hub address (`hubLinks.js`) and the handle it is built from (`ownHandle`, `http/texComputer.js`):
 * the handle is read off the grant, never off the request.
 */

const { appOriginOf } = require("./noteAppLink.cjs");

/**
 * The handle a person's own page lives at: the slug of the personal workspace
 * they own, or null. Never somebody else's personal workspace they are a
 * member of, which also has kind "personal".
 */
function ownHandle(session) {
  const own = (session?.workspaces || []).find((w) => w?.kind === "personal" && w?.role === "owner");
  return typeof own?.slug === "string" && own.slug ? own.slug : null;
}

const HANDLE = /^[a-z0-9-]{2,32}$/;

/** `<origin>/tex/@<handle>`, or null without an https origin or a handle. */
function personHubUrl(env, session) {
  const origin = appOriginOf(env);
  const handle = String(ownHandle(session) ?? "").toLowerCase();
  return origin !== null && HANDLE.test(handle) ? `${origin}/tex/@${handle}` : null;
}

module.exports = { ownHandle, personHubUrl };
