/**
 * A TEST CHAT'S PAGES AND PICTURES, SERVED TO ITS OWNER ONLY (Dev2, 2026-11-16: "we should be generating pages that are
 * working but just are short lived and disappear with the sandbox"; decision
 * `docs/decisions/texting-assistant/lab-sandbox.md`).
 *
 * `GET /tex-lab/sandbox/page/<sandboxId>/<id>`, with the caller's own grant as the bearer, and the route's `page` op
 * (`{ sandboxId, id }`, the same answer as JSON, for `tex_dev`). A page is a `.page.md` a test turn wrote
 * (`sandboxTools.js`), read from the test chat at the moment it is asked, so a later turn's edit shows; a picture is one
 * Tex sent there. Both live in the test chat's own object and go with it: Reset, or a day unused, and the address
 * answers 404.
 *
 * Who may open one: the test chat's owner, never anyone holding the link. The object is named from the caller's own
 * user id as the control plane answers it (`object.js` `sandboxName`), so anyone else's request reaches a different,
 * empty object and is answered exactly as an address that never existed. The id (128 random bits) is unguessable as
 * well, but it is not what lets anyone in: a page is made from the person's own notes, and a link that leaked would
 * show them to whoever had it. What is served can never run anything on the gateway's origin: Markdown as plain text,
 * or an HTML view with every character escaped, under a CSP that allows no script and sandboxes the document; a
 * picture only as PNG, JPEG, GIF or WebP.
 */

import { createControlPlane } from "../controlPlane.js";
import { bearerToken } from "../session.js";
import { callSandbox, sandboxStub } from "./object.js";
import { PAGE_PREFIX } from "./sandboxTools.js";

const SANDBOX_ID = /^[0-9a-f]{16}$/;
const ASSET_ID = /^[0-9a-f]{32}$/;
const PICTURES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const HEADERS = {
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex, nofollow",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
};

export { PAGE_PREFIX };

const missing = () => Response.json({ error: "not_found", message: "There is no such page in your test chats (Reset or a day unused deletes them)." }, { status: 404, headers: HEADERS });
const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** One page or picture of the caller's own test chat: `{ kind, title, type, text? , bytes? }`, or null. */
export async function sandboxAsset(env, userId, sandboxId, id) {
  if (!SANDBOX_ID.test(String(sandboxId)) || !ASSET_ID.test(String(id))) return null;
  const stub = sandboxStub(env, userId, sandboxId);
  if (stub === null) return null;
  // Asked first, making nothing: an address nobody opened gets no tables and no alarm (`object.js` `exists`).
  if (!(await callSandbox(stub, "exists", {})).exists) return null;
  const state = await callSandbox(stub, "state", {});
  if (!state?.meta?.chat) return null;
  const asset = (await callSandbox(stub, "asset.get", { id })).found;
  if (!asset) return null;
  if (asset.kind === "page") {
    let ref = null;
    try {
      ref = JSON.parse(asset.ref ?? "null");
    } catch {
      ref = null;
    }
    const note = ref && typeof ref.path === "string" ? (await callSandbox(stub, "note.get", { ctx: ref.ctx ?? "", path: ref.path })).found : null;
    if (!note || note.gone || note.body === null) return null;
    return { kind: "page", title: asset.title, type: "text/markdown", text: [note.body, ...(note.adds ?? [])].join("\n") };
  }
  if (asset.kind === "picture" && PICTURES.has(asset.type)) return { kind: "picture", title: asset.title, type: asset.type, base64: asset.body };
  return null;
}

/** `GET /tex-lab/sandbox/page/<sandboxId>/<id>[?as=html]`: the caller's own test chat's page or picture. */
export async function handleLabSandboxPage(request, env, path) {
  if (request.method !== "GET") return new Response(null, { status: 405, headers: HEADERS });
  if (!env?.LAB_SANDBOX) return missing();
  const token = bearerToken(request);
  if (!token) return Response.json({ error: "sign_in" }, { status: 401, headers: HEADERS });
  const [sandboxId, id, ...rest] = String(path).slice(PAGE_PREFIX.length).split("/");
  if (rest.length > 0 || !SANDBOX_ID.test(sandboxId ?? "") || !ASSET_ID.test(id ?? "")) return missing();
  const who = await createControlPlane(env).labSandbox(token, "who").catch(() => null);
  if (who === null) return Response.json({ error: "unavailable" }, { status: 503, headers: HEADERS });
  if (who.status === "refused" || typeof who.userId !== "string") return Response.json({ error: "forbidden" }, { status: 403, headers: HEADERS });
  const asset = await sandboxAsset(env, who.userId, sandboxId, id).catch(() => null);
  if (asset === null) return missing();
  if (asset.kind === "picture") return new Response(Uint8Array.from(atob(asset.base64), (c) => c.charCodeAt(0)), { headers: { ...HEADERS, "content-type": asset.type } });
  if (new URL(request.url).searchParams.get("as") === "html") {
    const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(asset.title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:720px;margin:24px auto;padding:0 16px}pre{white-space:pre-wrap}</style><p><small>A page in your Lab test chat. It goes when the test chat is reset or a day unused.</small></p><pre>${escape(asset.text)}</pre>`;
    return new Response(html, { headers: { ...HEADERS, "content-type": "text/html; charset=utf-8" } });
  }
  return new Response(asset.text, { headers: { ...HEADERS, "content-type": "text/markdown; charset=utf-8" } });
}
