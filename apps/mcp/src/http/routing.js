/**
 * Routing helpers the entry's `route` uses: matching well-known discovery
 * paths, and attaching the link-call and gateway-job hooks to a request's
 * context. Moved verbatim out of `src/index.js`; `route` itself stays there,
 * where its order of checks can be read top to bottom.
 */

/**
 * The three link calls, attached to the store the way queued work is.
 *
 * They need the session's access token and the workspace it resolved to, and a
 * tool handler is given a store rather than a session — the same shape
 * `enqueueGatewayJob` already uses, and the reason it uses it: what a handler
 * may do is decided where the session is, not by a handler reaching for one.
 *
 * Absent where there is no control plane, which is the single-tenant
 * deployment and the test stub. `toolCreateLink` and its siblings refuse with
 * a sentence rather than throwing on `undefined`.
 */
export function attachLinkCalls(store, session, controlPlane, env) {
  if (!controlPlane) return;
  Object.defineProperty(store, "links", {
    value: {
      create: (request) =>
        controlPlane.createLink(session.accessToken, session.workspaceId, request),
      list: () => controlPlane.listLinks(session.accessToken, session.workspaceId),
      revoke: (shareId) =>
        controlPlane.revokeLink(session.accessToken, session.workspaceId, shareId),
    },
    enumerable: false,
    writable: false,
    configurable: true,
  });
  // A website's status, check or publish (`write_note` `site`), for this context.
  Object.defineProperty(store, "site", {
    value: (request) => controlPlane.site(session.accessToken, session.workspaceId, request),
    enumerable: false,
    writable: false,
    configurable: true,
  });
  // The browser that photographs a published page (`infra/site-shots`), when
  // this deployment binds one. It is only ever handed the address the control
  // plane built for this context, after it cleared the caller.
  if (typeof env?.SITE_SHOTS?.fetch === "function") {
    Object.defineProperty(store, "shootSite", {
      value: async (request) => {
        const response = await env.SITE_SHOTS.fetch("https://site-shots/shoot", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        });
        const body = await response.json().catch(() => null);
        if (!response.ok || !body || !Array.isArray(body.shots)) {
          return { error: typeof body?.error === "string" ? body.error : `the browser answered ${response.status}` };
        }
        return body;
      },
      enumerable: false,
      writable: false,
      configurable: true,
    });
  }
  // `report_problem`: filed as this connection's person, resolved from its own
  // token by the control plane. Not tied to a workspace, so the same call on
  // every store a request touches.
  Object.defineProperty(store, "reportProblem", {
    value: (message) => controlPlane.reportProblem(session.accessToken, message),
    enumerable: false,
    writable: false,
    configurable: true,
  });
}

export function attachGatewayJobQueue(store, session, controlPlane, env) {
  const queue = env?.GATEWAY_JOBS;
  if (!queue || typeof queue.send !== "function") return;
  Object.defineProperty(store, "enqueueGatewayJob", {
    value: async (job) => {
      const ticket = await controlPlane.createGatewayJob(session.accessToken, session.workspaceId, job);
      await queue.send({ ticket, kind: job.kind, moveId: job.moveId });
    },
    enumerable: false,
    writable: false,
    configurable: true,
  });
}

/* ----------------------------- auth & scoping ----------------------------- */

/**
 * Match the two discovery documents, with or without a resource path suffix.
 *
 * RFC 9728 §3 inserts the well-known segment between the host and the resource
 * path, so a resource at `/@seyi/mcp` publishes metadata at
 * `/.well-known/oauth-protected-resource/@seyi/mcp`. Clients probe the
 * path-suffixed form first and the bare form second, so both are served — and
 * the suffix is read for a slug rather than ignored.
 */
export function matchWellKnown(path) {
  const protectedResource = path.match(/^\/\.well-known\/oauth-protected-resource(\/.*)?$/);
  if (protectedResource) {
    // The suffix is the resource *path*, so it ends in "/mcp" — which is itself
    // a valid-looking slug. Trimming that first is what stops
    // `/.well-known/oauth-protected-resource/mcp` — the exact URL this worker's
    // own 401 challenge points at — from being read as a workspace called "mcp"
    // and answering with metadata for a resource nobody asked about.
    const suffix = (protectedResource[1] || "").replace(/\/mcp\/?$/, "");
    const named = suffix.match(/^\/@?([a-z0-9-]{2,32})$/);
    return { kind: "protected-resource", slug: named ? named[1] : null };
  }
  if (/^\/\.well-known\/oauth-authorization-server(\/.*)?$/.test(path)) {
    return { kind: "authorization-server", slug: null };
  }
  return null;
}
