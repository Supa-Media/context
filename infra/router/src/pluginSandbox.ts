/**
 * The plugin sandbox's page: `/drawing-assets/plugin-sandbox/index.html`.
 *
 * The console loads each Obsidian plugin into a `sandbox="allow-scripts"`
 * frame, whose origin is opaque. It used to be a `srcdoc` frame, which
 * inherits the console's Content Security Policy; the sandbox runs its
 * bootstrap and every plugin as inline script, so the console could never
 * enforce `script-src` without breaking plugins. Loaded by URL, the sandbox
 * page carries its own policy instead (`SANDBOX_POLICY`), and the frame's
 * sandbox flags, and so its trust boundary, are unchanged.
 *
 * The export's assets fall back to the console's own `index.html` for a
 * missing file, and the frame must only ever be handed the sandbox, so the
 * file is checked to be the sandbox page (`scripts/build-plugin-sandbox.mjs`)
 * before it is returned.
 *
 * The page is public and ungated: plugins a context already enabled run in
 * production whatever the experiment flag says. On its own it is inert (no
 * plugin code, no credential, an opaque origin that can reach nothing); the
 * threat model is `docs/decisions/plugins/message-checks-and-shim.md`, "The
 * sandbox is a page of its own, and is public on purpose", and the real-engine
 * proof is `apps/mobile/e2e/webkit/pluginSandboxPage.spec.ts`.
 */

import type { Env } from "./env";

export const PLUGIN_SANDBOX_PREFIX = "/drawing-assets/plugin-sandbox/";

/**
 * The sandbox page's own policy, the same one its meta tag enforces
 * (`pluginSandboxDocument` in `packages/obsidian-runtime/src/sandbox.js`).
 * Its `'unsafe-inline'` scripts run only in the opaque-origin frame, which
 * can load, connect to and frame nothing.
 */
export const SANDBOX_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src data:; media-src 'none'; font-src 'none'; child-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";

/** A marker only the sandbox page carries: the policy its meta tag sets. */
const MARKER = `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_POLICY}">`;

export function isPluginSandboxPath(pathname: string): boolean {
  return pathname.startsWith(PLUGIN_SANDBOX_PREFIX);
}

function plain(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export async function pluginSandboxResponse(request: Request, url: URL, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return plain(405, "Method not allowed\n");
  const name = url.pathname.slice(PLUGIN_SANDBOX_PREFIX.length);
  if (name !== "" && name !== "index.html") return plain(404, "Not found\n");
  if (!env.ASSETS) return plain(503, "The plugin sandbox is not available right now.\n");
  // The assets redirect `/x/index.html` to `/x/`; ask for the directory directly.
  const response = await env.ASSETS.fetch(new Request(`${url.origin}${PLUGIN_SANDBOX_PREFIX}`, { redirect: "manual" }));
  const body = response.ok ? await response.text() : "";
  if (!body.includes(MARKER)) return plain(503, "The plugin sandbox is not available right now.\n");
  return new Response(request.method === "HEAD" ? null : body, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "Content-Security-Policy": `${SANDBOX_POLICY}; frame-ancestors 'self'`,
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
