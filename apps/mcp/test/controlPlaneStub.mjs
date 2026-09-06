/**
 * An in-memory control plane that speaks the exact HTTP contract documented in
 * `src/controlPlane.js`.
 *
 * It is deliberately a *server*, not a mock of the client. The worker builds a
 * real `createControlPlane()`, makes real `fetch` calls, and this answers them —
 * so the request and response shapes in the contract comment are executed on
 * every run rather than described. If the Convex side is built to a different
 * shape, these tests are the thing that was wrong.
 *
 * It also enforces the security rules the contract asks Convex to enforce,
 * because a stub that is more permissive than the real thing turns every
 * isolation test into a test of the stub's good manners:
 *
 *  - the gateway secret is checked on every call;
 *  - a binding is resolved **from the access token**, never from a workspace id
 *    the caller supplied;
 *  - `expectedWorkspaceId` selects only *within the set that token resolves
 *    to* — the contexts its person is a member of — and can otherwise only
 *    cause a refusal. An id outside the set reaches nothing, which is the whole
 *    of what stops a caller holding the gateway secret naming its way through
 *    the customer list;
 *  - a revoked or expired grant resolves to nothing, immediately;
 *  - refusals are byte-identical whether or not the workspace exists.
 *
 * Everything in here is obviously fake. This repository is public.
 */

const encoder = new TextEncoder();

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const CONTROL_PLANE_ORIGIN = "https://control-plane.test";
export const GATEWAY_SECRET = "test-gateway-secret-not-a-real-one";

export function createControlPlaneStub(options = {}) {
  const origin = options.origin || CONTROL_PLANE_ORIGIN;
  const secret = options.secret || GATEWAY_SECRET;

  /** workspaceId → binding descriptor (without workspaceId; added on the way out). */
  const bindings = new Map();
  /**
   * Knobs a test flips to model a control plane that is not this one — older
   * than a field, or misbehaving. Read at request time, never at setup.
   */
  const flags = {
    omitBindingWorkspaceId: false,
    /**
     * Serve this workspace's binding whatever was asked for — a control plane
     * that has resolved the wrong tenant. This is the only shape in which the
     * gateway's own identity check does any work, so a test of that check that
     * does not set it is testing nothing.
     */
    bindingWorkspaceId: null,
  };

  /** workspaceId → { slug } */
  const workspaces = new Map();
  /** grantId → grant */
  const grants = new Map();
  /** sha256(access token) → grantId */
  const accessTokens = new Map();
  /** sha256(refresh token) → grantId */
  const refreshTokens = new Map();
  /** sha256 of a *previous* refresh token → grantId, for reuse detection */
  const retiredRefreshTokens = new Map();
  /** clientId → registered client */
  const clients = new Map();
  /** code → authorization record */
  const codes = new Map();
  /** requestId → parked authorization request */
  const pendingAuthorizations = new Map();

  /** Every call the worker made, for assertions about what was sent. */
  const calls = [];

  let grantCounter = 0;

  function addWorkspace(workspaceId, slug, binding) {
    workspaces.set(workspaceId, { slug });
    bindings.set(workspaceId, binding);
  }

  /**
   * @param alsoMemberOf other contexts this grant's *person* belongs to, as
   *   `[{ workspaceId, role }]`. The real control plane reads these off
   *   `workspaceMembers` on every request; the stub is told them, because the
   *   contract this file executes is the HTTP one and not Convex's schema.
   */
  async function addGrant({
    accessToken,
    refreshToken,
    workspaceId,
    role = "owner",
    scopes = ["context:read", "context:write"],
    clientId = "mcp_test_client",
    userId = "user_test",
    alsoMemberOf = [],
    expiresAt,
  }) {
    const grantId = `grant_${++grantCounter}`;
    grants.set(grantId, {
      grantId,
      workspaceId,
      role,
      scopes,
      clientId,
      userId,
      alsoMemberOf,
      status: "active",
      expiresAt: expiresAt ?? Date.now() + 3_600_000,
    });
    accessTokens.set(await sha256Hex(accessToken), grantId);
    if (refreshToken) refreshTokens.set(await sha256Hex(refreshToken), grantId);
    return grantId;
  }

  function revoke(grantId) {
    const grant = grants.get(grantId);
    if (grant) grant.status = "revoked";
  }

  /** Resolve a presented access token exactly as Convex must: hash, then look up. */
  async function grantForAccessToken(token) {
    if (typeof token !== "string" || !token) return null;
    const grantId = accessTokens.get(await sha256Hex(token));
    if (!grantId) return null;
    const grant = grants.get(grantId);
    if (!grant || grant.status !== "active") return null;
    if (typeof grant.expiresAt === "number" && grant.expiresAt <= Date.now()) return null;
    return grant;
  }

  /**
   * The contexts a grant covers: its own first, then its person's other
   * memberships. The grant's own context is guaranteed present exactly as
   * `contextsForGrant` guarantees it, because the gateway refuses a default
   * that is not in the set.
   */
  function coveredContexts(grant) {
    const rows = [
      {
        workspaceId: grant.workspaceId,
        slug: workspaces.get(grant.workspaceId)?.slug ?? null,
        role: grant.role,
      },
    ];
    for (const membership of grant.alsoMemberOf || []) {
      if (membership.workspaceId === grant.workspaceId) continue;
      rows.push({
        workspaceId: membership.workspaceId,
        slug: workspaces.get(membership.workspaceId)?.slug ?? null,
        role: membership.role ?? "member",
      });
    }
    return rows;
  }

  function ok(body) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  async function handle(url, init = {}) {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const body = init.body ? JSON.parse(init.body) : {};
    const auth = init.headers?.Authorization || "";
    calls.push({ path, body, auth });

    // Proof #1: this caller is the gateway. Without it, nothing below runs.
    if (auth !== `Bearer ${secret}`) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }

    switch (path) {
      case "/gateway/session": {
        const grant = await grantForAccessToken(body.accessToken);
        if (!grant) return ok({ session: null });
        return ok({
          session: {
            grantId: grant.grantId,
            clientId: grant.clientId,
            actorUserId: grant.userId,
            scopes: grant.scopes,
            expiresAt: grant.expiresAt,
            defaultWorkspaceId: grant.workspaceId,
            workspaces: coveredContexts(grant),
          },
        });
      }

      case "/gateway/binding": {
        // Proof #2: a live user grant. The *set* of contexts comes from THAT,
        // never from the caller. `expectedWorkspaceId` picks one of them, and
        // an id outside the set reaches nothing.
        const grant = await grantForAccessToken(body.accessToken);
        if (!grant) return ok({ binding: null });
        const covered = coveredContexts(grant);
        const named =
          body.expectedWorkspaceId === null || body.expectedWorkspaceId === undefined
            ? covered.find((entry) => entry.workspaceId === grant.workspaceId)
            : covered.find((entry) => entry.workspaceId === body.expectedWorkspaceId);
        if (!named) {
          // Identical to "no such workspace". Distinguishing the two would make
          // this a customer-list oracle for anyone holding the gateway secret.
          return ok({ binding: null });
        }
        const served = flags.bindingWorkspaceId ?? named.workspaceId;
        const binding = bindings.get(served);
        if (!binding) return ok({ binding: null });
        // `omitBindingWorkspaceId` stands in for a control plane older than the
        // field, or one that stopped sending it. The gateway's identity check
        // must refuse that rather than skip itself — see `storeForSession`.
        /*
         * **The descriptor leaves as a SIBLING of the binding, never inside
         * it**, because that is what `apps/convex/http.ts` sends:
         *
         *     json({ binding: opened.binding, searchIndex: opened.searchIndex })
         *
         * This stub used to emit whatever shape the fixture handed it, and
         * every fixture nested `searchIndex` inside the binding — the
         * gateway's assumption, restated as a fact. The gateway then read
         * `binding.searchIndex`, a key the control plane has never sent, so
         * `store.searchIndex` was null on every production request and fast
         * search served nothing at all, while this suite was ALL PASS.
         *
         * A fixture may still be written the convenient way; the split happens
         * here, at the wire, so no test can assert the gateway's own guess
         * back to it. `undefined` when there is none, so `JSON.stringify`
         * drops the key exactly as the real route's comment promises.
         */
        const { searchIndex, ...storage } = binding;
        const envelope = (workspaceId) => ({
          binding: workspaceId === null ? { ...storage } : { workspaceId, ...storage },
          ...(searchIndex ? { searchIndex } : {}),
        });
        if (flags.omitBindingWorkspaceId) return ok(envelope(null));
        return ok(envelope(served));
      }

      case "/gateway/clients/register": {
        clients.set(body.clientId, {
          clientId: body.clientId,
          clientName: body.clientName,
          redirectUris: body.redirectUris,
          hashedClientSecret: body.hashedClientSecret,
          tokenEndpointAuthMethod: body.tokenEndpointAuthMethod,
        });
        return ok({ ok: true });
      }

      case "/gateway/clients/get":
        return ok({ client: clients.get(body.clientId) || null });

      case "/gateway/authorize/start": {
        const requestId = `req_${pendingAuthorizations.size + 1}`;
        pendingAuthorizations.set(requestId, body);
        return ok({
          requestId,
          consentUrl: `${origin}/authorize?request_id=${requestId}`,
        });
      }

      case "/gateway/codes/consume": {
        const record = codes.get(body.code);
        // Atomic single use: gone on read, so a replay — even a concurrent one
        // — sees exactly what a code that never existed sees.
        codes.delete(body.code);
        if (!record) return ok({ authorization: null });
        if (record.expiresAt <= Date.now()) return ok({ authorization: null });
        if (record.clientId !== body.clientId) return ok({ authorization: null });
        return ok({ authorization: record });
      }

      case "/gateway/grants/create": {
        const grantId = `grant_${++grantCounter}`;
        grants.set(grantId, {
          grantId,
          workspaceId: body.workspaceId,
          userId: body.userId,
          clientId: body.clientId,
          scopes: body.scopes,
          role: workspaces.get(body.workspaceId)?.role || "owner",
          status: "active",
          expiresAt: body.accessTokenExpiresAt,
        });
        accessTokens.set(body.hashedAccessToken, grantId);
        refreshTokens.set(body.hashedRefreshToken, grantId);
        return ok({ grantId });
      }

      case "/gateway/grants/rotate": {
        const presentedHash = await sha256Hex(body.refreshToken);
        const grantId = refreshTokens.get(presentedHash);
        if (!grantId) {
          // Reuse of an already-rotated refresh token: the token leaked, so the
          // grant dies rather than the request merely failing.
          const retired = retiredRefreshTokens.get(presentedHash);
          if (retired) revoke(retired);
          return ok({ grant: null });
        }
        const grant = grants.get(grantId);
        if (!grant || grant.status !== "active" || grant.clientId !== body.clientId) {
          return ok({ grant: null });
        }
        refreshTokens.delete(presentedHash);
        retiredRefreshTokens.set(presentedHash, grantId);
        refreshTokens.set(body.newHashedRefreshToken, grantId);
        for (const [hash, id] of [...accessTokens]) {
          if (id === grantId) accessTokens.delete(hash);
        }
        accessTokens.set(body.newHashedAccessToken, grantId);
        grant.expiresAt = body.accessTokenExpiresAt;
        if (Array.isArray(body.scopes) && body.scopes.length) grant.scopes = body.scopes;
        return ok({
          grant: {
            grantId,
            workspaceId: grant.workspaceId,
            userId: grant.userId,
            clientId: grant.clientId,
            scopes: grant.scopes,
          },
        });
      }

      case "/gateway/grants/revoke": {
        const hash = await sha256Hex(body.token);
        const grantId =
          body.tokenType === "access" ? accessTokens.get(hash) : refreshTokens.get(hash);
        if (!grantId) return ok({ revoked: false });
        const grant = grants.get(grantId);
        // A client may only revoke its own grant; revoking a sibling would
        // defeat the entire point of per-client grants.
        if (!grant || grant.clientId !== body.clientId) return ok({ revoked: false });
        revoke(grantId);
        return ok({ revoked: true });
      }

      case "/gateway/search-index/progress": {
        // The reference implementation of the projection's progress route: it
        // accepts counts, an optional `ready`, and an optional error code from
        // the gateway's own closed set, and answers. The control plane owns
        // the row; the gateway reports numbers and decides no policy. `calls`
        // already carries the body, so a test asserts what was reported by
        // reading that rather than by a second recording here.
        return ok({ ok: true });
      }

      case "/gateway/usage": {
        // The reference implementation of the counter route: it accepts a list
        // of {metric, workspaceId, count} and answers how many it applied.
        // `calls` already carries the body, so a test asserts what the gateway
        // reported by reading that rather than by a second recording here.
        const events = Array.isArray(body.events) ? body.events : [];
        return ok({ applied: events.length });
      }

      default:
        return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    }
  }

  /**
   * Replace `globalThis.fetch` with one that answers this control plane and
   * hands everything else to whatever was there before. Returns a restore
   * function.
   */
  function install() {
    const previous = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.startsWith(origin)) return handle(url, init);
      return previous ? previous(input, init) : new Response("", { status: 404 });
    };
    return () => {
      globalThis.fetch = previous;
    };
  }

  /** Park an authorization code, as the consent screen would after approval. */
  function issueCode(code, record) {
    codes.set(code, { expiresAt: Date.now() + 600_000, ...record });
  }

  return {
    origin,
    secret,
    handle,
    install,
    addWorkspace,
    addGrant,
    revoke,
    issueCode,
    grants,
    clients,
    codes,
    bindings,
    flags,
    accessTokens,
    refreshTokens,
    pendingAuthorizations,
    calls,
  };
}

/**
 * A tiny S3-compatible backend over an in-memory map.
 *
 * Enough of GetObject / PutObject / DeleteObject / ListObjectsV2 for `S3Store`
 * to drive a real workspace end to end, so the isolation tests exercise the
 * actual signing and URL-building path rather than a store stub. Every bucket
 * created here lives behind one endpoint host, which is the point: tenants on
 * the *same provider, same endpoint, adjacent bucket names* is the arrangement
 * a prefix-confusion bug would leak across.
 */
export function createS3Backend(endpointOrigin = "https://s3.example-object-storage.test") {
  /** bucket → Map(key → { body, etag }) */
  const buckets = new Map();
  let etagCounter = 0;

  function bucketFor(name) {
    if (!buckets.has(name)) buckets.set(name, new Map());
    return buckets.get(name);
  }

  async function handle(url, init = {}) {
    const parsed = new URL(url);
    const method = (init.method || "GET").toUpperCase();
    // Path-style addressing: /<bucket>/<key...>
    const segments = parsed.pathname.replace(/^\/+/, "").split("/");
    const bucketName = decodeURIComponent(segments.shift() || "");
    const key = segments.map(decodeURIComponent).join("/");
    const objects = bucketFor(bucketName);

    if (method === "GET" && parsed.searchParams.get("list-type") === "2") {
      const prefix = parsed.searchParams.get("prefix") || "";
      const delimiter = parsed.searchParams.get("delimiter") || "";
      const contents = [];
      const commonPrefixes = new Set();
      for (const [objectKey, value] of [...objects.entries()].sort()) {
        if (!objectKey.startsWith(prefix)) continue;
        if (delimiter) {
          const remainder = objectKey.slice(prefix.length);
          const slash = remainder.indexOf(delimiter);
          if (slash !== -1) {
            commonPrefixes.add(prefix + remainder.slice(0, slash + 1));
            continue;
          }
        }
        contents.push({ key: objectKey, size: value.body.length, etag: value.etag });
      }
      const xml =
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>` +
        `<Name>${bucketName}</Name><IsTruncated>false</IsTruncated>` +
        contents
          .map(
            (item) =>
              `<Contents><Key>${escapeXml(item.key)}</Key>` +
              `<LastModified>2026-08-01T10:00:00.000Z</LastModified>` +
              `<ETag>&quot;${item.etag}&quot;</ETag><Size>${item.size}</Size></Contents>`
          )
          .join("") +
        [...commonPrefixes]
          .map((p) => `<CommonPrefixes><Prefix>${escapeXml(p)}</Prefix></CommonPrefixes>`)
          .join("") +
        `</ListBucketResult>`;
      return new Response(xml, { status: 200 });
    }

    if (method === "GET") {
      const object = objects.get(key);
      if (!object) return new Response("", { status: 404 });
      return new Response(object.body, { status: 200, headers: { etag: `"${object.etag}"` } });
    }

    if (method === "PUT") {
      const ifMatch = init.headers?.["if-match"];
      if (ifMatch) {
        const expected = ifMatch.replace(/^"|"$/g, "");
        const current = objects.get(key);
        if (!current || current.etag !== expected) return new Response("", { status: 412 });
      }
      const body =
        typeof init.body === "string"
          ? init.body
          : new TextDecoder().decode(
              init.body instanceof Uint8Array ? init.body : new Uint8Array(init.body)
            );
      const etag = `s${++etagCounter}`;
      objects.set(key, { body, etag });
      return new Response("", { status: 200, headers: { etag: `"${etag}"` } });
    }

    if (method === "DELETE") {
      objects.delete(key);
      return new Response("", { status: 204 });
    }

    return new Response("", { status: 405 });
  }

  function install() {
    const previous = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.startsWith(endpointOrigin)) return handle(url, init);
      return previous ? previous(input, init) : new Response("", { status: 404 });
    };
    return () => {
      globalThis.fetch = previous;
    };
  }

  return { endpoint: endpointOrigin, buckets, bucketFor, handle, install };
}

function escapeXml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * A tiny Dropbox over in-memory maps, one per access token.
 *
 * Enough of `files/download`, `files/upload`, `files/delete_v2` and
 * `files/list_folder` for the real `DropboxStore` to drive a workspace end to
 * end. Two properties are modelled deliberately, because they are the two that
 * a Dropbox-shaped tenancy bug would hide behind:
 *
 *  - **The access token selects the account, and nothing else does.** There is
 *    no bucket name, no endpoint, and no per-tenant host: two Dropbox tenants
 *    reach the same two URLs, and the only thing between them is the bearer
 *    token the binding carried. An unknown token is a 401, exactly as Dropbox
 *    answers one.
 *  - **A missing path is a 409 with a tagged body, never a 404**, and a lost
 *    conditional write is a 409 tagged `conflict`. A stub that answered 404
 *    would let an adapter reading the status instead of the tag pass.
 */
export function dropboxTaggedError(summary, status = 409) {
  const segments = summary
    .split("/")
    .filter((part) => part && part !== "..." && part !== ".");
  let error = null;
  for (const segment of [...segments].reverse()) {
    error = error ? { ".tag": segment, [segment]: error } : { ".tag": segment };
  }
  // `UploadError.path` is the one variant that is NOT a plain nested union.
  // It carries `UploadWriteFailed`, a *struct* (`reason WriteError`,
  // `upload_session_id String`), and Stone flattens struct-valued variants —
  // so Dropbox sends `{".tag":"path", reason:{…}, upload_session_id:"…"}`
  // rather than nesting under `path`. Deriving the nested form everywhere
  // replaced one shape Dropbox does not send with another, at the one
  // endpoint where it matters most: the conditional-write conflict.
  if (segments[0] === "path" && segments[1] === "conflict" && error?.path) {
    error = {
      ".tag": "path",
      reason: error.path,
      upload_session_id: "FAKE-upload-session",
    };
  }
  return new Response(JSON.stringify({ error_summary: summary, error: error ?? {} }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function createDropboxBackend() {
  const API_ORIGIN = "https://api.dropboxapi.com";
  const CONTENT_ORIGIN = "https://content.dropboxapi.com";

  /** access token → Map(dropbox path → { body, rev }) */
  const accounts = new Map();
  let revCounter = 0;

  /** Register an account and return its file map, so a test can seed it. */
  function accountFor(accessToken) {
    if (!accounts.has(accessToken)) accounts.set(accessToken, new Map());
    return accounts.get(accessToken);
  }

  /**
   * A Dropbox error, with the tags Dropbox actually sends.
   *
   * `error` used to be `{}` — an error object with no tag in it, which is not
   * a shape Dropbox produces. It passed only because the adapter searched the
   * raw body for a substring, so the summary line alone was enough. A fake
   * built to the check rather than to the API stops being evidence the moment
   * the check changes, and it hid a real defect: an adapter reading tags
   * correctly saw *no* tag here and treated a missing file as a hard failure.
   *
   * The union is nested the way Dropbox nests it — `path/not_found` becomes
   * `{".tag":"path", path:{".tag":"not_found"}}` — so the summary and the tags
   * cannot drift apart.
   */
  const tagged = dropboxTaggedError;

  const notFound = () => tagged("path/not_found/...");
  const conflict = () => tagged("path/conflict/file/...");

  function json(body) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  function decodeBody(body) {
    if (typeof body === "string") return body;
    if (body instanceof Uint8Array) return new TextDecoder().decode(body);
    return new TextDecoder().decode(new Uint8Array(body));
  }

  async function handle(url, init = {}) {
    const path = new URL(url).pathname;
    const headers = init.headers || {};
    const token = String(headers.Authorization || "").replace(/^Bearer /, "");
    // Dropbox's own answer to a token it does not know. It is *not* a 409, so
    // an adapter that read absence off a status alone would surface an expired
    // token as an empty context.
    if (!accounts.has(token)) return tagged("invalid_access_token/", 401);
    const files = accounts.get(token);
    const arg = headers["Dropbox-API-Arg"] ? JSON.parse(headers["Dropbox-API-Arg"]) : null;
    const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : null;

    if (path === "/2/files/download") {
      const file = files.get(arg.path);
      if (!file) return notFound();
      return new Response(file.body, {
        status: 200,
        headers: { "Dropbox-API-Result": JSON.stringify({ rev: file.rev, size: file.body.length }) },
      });
    }

    if (path === "/2/files/upload") {
      const current = files.get(arg.path);
      if (arg.mode?.[".tag"] === "update" && current?.rev !== arg.mode.update) return conflict();
      const rev = `r${++revCounter}`;
      files.set(arg.path, { body: decodeBody(init.body), rev });
      return json({ rev, path_display: arg.path, size: files.get(arg.path).body.length });
    }

    if (path === "/2/files/delete_v2") {
      if (!files.has(body.path)) return notFound();
      files.delete(body.path);
      return json({ metadata: { path_display: body.path } });
    }

    if (path === "/2/files/list_folder") {
      const root = body.path === "" ? "/" : `${body.path}/`;
      const children = [...files.keys()].filter((key) => key.startsWith(root)).sort();
      if (body.path !== "" && children.length === 0) return notFound();
      const entries = [];
      const folders = new Set();
      for (const key of children) {
        const remainder = key.slice(root.length);
        const slash = remainder.indexOf("/");
        if (slash === -1) {
          entries.push({
            ".tag": "file",
            path_display: key,
            size: files.get(key).body.length,
            server_modified: "2026-08-01T10:00:00Z",
          });
          continue;
        }
        folders.add(root + remainder.slice(0, slash));
        if (body.recursive) {
          entries.push({
            ".tag": "file",
            path_display: key,
            size: files.get(key).body.length,
            server_modified: "2026-08-01T10:00:00Z",
          });
        }
      }
      for (const folder of folders) entries.push({ ".tag": "folder", path_display: folder });
      return json({ entries, has_more: false, cursor: "" });
    }

    return new Response(JSON.stringify({ error_summary: "unsupported/" }), { status: 400 });
  }

  function install() {
    const previous = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.startsWith(API_ORIGIN) || url.startsWith(CONTENT_ORIGIN)) return handle(url, init);
      return previous ? previous(input, init) : new Response("", { status: 404 });
    };
    return () => {
      globalThis.fetch = previous;
    };
  }

  return { accounts, accountFor, handle, install };
}
