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
  /**
   * Where `/gateway/authorize/start` claims the consent screen lives.
   *
   * Separate from `origin` — which is what this stub *intercepts* — so a test
   * can hand the gateway a consent URL it must refuse without also making the
   * stub stop answering the gateway's own calls. Defaults to `origin`, so every
   * existing caller is unchanged.
   */
  const consentOrigin = options.consentOrigin || origin;

  /** workspaceId → binding descriptor (without workspaceId; added on the way out). */
  const bindings = new Map();
  /**
   * `${workspaceId}:${provider}` → the model API key that workspace connected.
   *
   * Flat and keyed by both, modelling `providerCredentials`' own
   * `by_workspace_provider` index — so a lookup that forgets the workspace half
   * reaches the wrong tenant's key here exactly as it would there.
   */
  const providerCredentials = new Map();
  /**
   * workspaceId → the rotation in progress, or `null` — mutated by
   * `startEncryptionRotation`/`completeEncryptionRotation` on `/gateway/binding`,
   * modelling `startWorkspaceKeyRotation`/`completeWorkspaceKeyRotation` on the
   * real control plane. Real, valid AES-256 base64 material is minted for a new
   * generation — never a placeholder — because this feeds straight into
   * `src/encryption.js`'s actual AES-GCM calls in the gateway under test.
   */
  const rotations = new Map();

  /** A fresh, real AES-256 key, base64. */
  function mintKeyMaterial() {
    let binary = "";
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  /** `k1` -> `k2`, `k9` -> `k10` — the same scheme the real control plane uses. */
  function nextGeneration(current) {
    const match = /^([A-Za-z_-]*?)(\d+)$/.exec(current);
    if (match === null) return `${current}-2`;
    return `${match[1]}${Number(match[2]) + 1}`;
  }
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
    /**
     * Answer 429 to a registration, as the real control plane does when the
     * registrant has spent its window. The gateway must turn that into a 429
     * of its own rather than let the `/oauth/` catch flatten it to 503, which
     * is the difference between "you went too fast" and "we are broken".
     */
    registrationRateLimited: false,
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
  /** opaque gateway job ticket → job */
  const gatewayJobs = new Map();
  /** Share rows this stub has minted, by share id. */
  const links = new Map();
  /** workspaceId → when the gateway last said that context changed */
  const activityStamps = new Map();

  /**
   * The owner clearance the three link routes share.
   *
   * Lifted out rather than repeated three times: three copies is how one of
   * them ends up missing the `context:private` line, which is exactly the
   * mistake a stub must not teach the tests to accept.
   */
  async function clearedOwner(body) {
    const grant = await grantForAccessToken(body.accessToken);
    if (!grant) return null;
    const named = coveredContexts(grant).find(
      (entry) => entry.workspaceId === body.expectedWorkspaceId,
    );
    if (!named || named.role !== "owner") return null;
    if (!grant.scopes.includes("context:write") || !grant.scopes.includes("context:private")) {
      return null;
    }
    return { workspaceId: named.workspaceId, actorUserId: grant.userId };
  }

  /** One row as the real route reports it: URLs, and never the token. */
  function describeStubLink(row) {
    const origin = "https://context.test";
    const handle = workspaces.get(row.workspaceId)?.slug ?? null;
    const path = `/s/${row.token}`;
    return {
      shareId: row.shareId,
      url: `${origin}${path}`,
      shortUrl: row.slug === null || handle === null ? null : `${origin}/@${handle}/${row.slug}`,
      path,
      audience: row.audience,
      entryPath: row.entryPath,
      slug: row.slug,
      collecting: row.mode === "collect",
      collected: row.mode === "collect" ? (row.collected ?? 0) : null,
      collectCap: row.mode === "collect" ? (row.collectCap ?? 500) : null,
      createdAt: row.createdAt,
    };
  }

  /** Every call the worker made, for assertions about what was sent. */
  const calls = [];

  let grantCounter = 0;

  function addWorkspace(workspaceId, slug, binding, options = {}) {
    workspaces.set(workspaceId, { slug, kind: options.kind === "shared" ? "shared" : "personal" });
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
    clientName = null,
    userId = "user_test",
    alsoMemberOf = [],
    grantedNamesByWorkspace = {},
    expiresAt,
  }) {
    const grantId = `grant_${++grantCounter}`;
    grants.set(grantId, {
      grantId,
      workspaceId,
      role,
      scopes,
      clientId,
      clientName,
      userId,
      alsoMemberOf,
      grantedNamesByWorkspace,
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
    const namesFor = (workspaceId) => {
      // Match Convex: only the first-party console grant receives live group
      // names. Ordinary OAuth and pinned reach carry no such authority.
      if (grant.clientId !== "context_console") return undefined;
      const names = grant.grantedNamesByWorkspace?.[workspaceId];
      return Array.isArray(names) ? [...names] : [];
    };
    const rows = [
      {
        workspaceId: grant.workspaceId,
        slug: workspaces.get(grant.workspaceId)?.slug ?? null,
        role: grant.role,
        kind: workspaces.get(grant.workspaceId)?.kind ?? "personal",
        ...(namesFor(grant.workspaceId) === undefined
          ? {}
          : { grantedNames: namesFor(grant.workspaceId) }),
      },
    ];
    for (const membership of grant.alsoMemberOf || []) {
      if (membership.workspaceId === grant.workspaceId) continue;
      rows.push({
        workspaceId: membership.workspaceId,
        slug: workspaces.get(membership.workspaceId)?.slug ?? null,
        role: membership.role ?? "member",
        kind: workspaces.get(membership.workspaceId)?.kind ?? "personal",
        ...(namesFor(membership.workspaceId) === undefined
          ? {}
          : { grantedNames: namesFor(membership.workspaceId) }),
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

  /*
    Gateway → control-plane round trips, counted.

    The same reasoning the S3 backend's counters carry: two refusals that are
    byte-identical to read and a different number of round trips apart are
    still two answers, the second measured with a clock. On the link tools the
    trips that matter are these, not the bucket's.
  */
  const gatewayCalls = { total: 0, byPath: new Map() };

  async function handle(url, init = {}) {
    gatewayCalls.total += 1;
    const calledPath = new URL(url).pathname;
    gatewayCalls.byPath.set(calledPath, (gatewayCalls.byPath.get(calledPath) || 0) + 1);
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
            clientName: grant.clientName ?? null,
            actorUserId: grant.userId,
            scopes: grant.scopes,
            expiresAt: grant.expiresAt,
            defaultWorkspaceId: grant.workspaceId,
            workspaces: coveredContexts(grant),
          },
        });
      }

      case "/gateway/sessions/by-grant": {
        if (
          typeof body.expectedWorkspaceId !== "string" ||
          !Array.isArray(body.grantIds) || body.grantIds.length > 24 ||
          new Set(body.grantIds).size !== body.grantIds.length
        ) {
          return new Response(JSON.stringify({ error: "malformed_batch" }), { status: 400 });
        }
        return ok({
          sessions: body.grantIds.map((grantId) => {
            const grant = grants.get(grantId);
            if (!grant || grant.status !== "active" || grant.expiresAt <= Date.now()) return null;
            const target = coveredContexts(grant).find(
              (entry) => entry.workspaceId === body.expectedWorkspaceId,
            );
            if (!target) return null;
            return {
              grantId,
              workspaceId: target.workspaceId,
              scopes: grant.scopes,
              role: target.role,
              kind: target.kind,
              ...(target.grantedNames === undefined
                ? {}
                : { grantedNames: target.grantedNames }),
            };
          }),
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
        // `encryptionKey` splits off the same way and for the same reason. It
        // is a third sibling on the real route, absent for every context that
        // has never encrypted a note — so a fixture that does not mention it
        // produces exactly the bytes a context without one gets today.
        //
        // `rotation` is a fourth. `startEncryptionRotation`/
        // `completeEncryptionRotation` mutate `binding.encryptionKey` and
        // `rotations` in place — on THIS workspace's row in `bindings`, so a
        // rotation started by one call is visible to the next, exactly like
        // the real control plane's persisted state.
        if (body.startEncryptionRotation === true && binding.encryptionKey) {
          const active = rotations.get(served) ?? null;
          if (active === null) {
            const fromGeneration = binding.encryptionKey.current;
            const toGeneration = nextGeneration(fromGeneration);
            binding.encryptionKey = {
              current: toGeneration,
              keys: { ...binding.encryptionKey.keys, [toGeneration]: mintKeyMaterial() },
            };
            rotations.set(served, { fromGeneration, toGeneration });
          }
        }
        if (typeof body.completeEncryptionRotation === "string") {
          const active = rotations.get(served) ?? null;
          if (active !== null && active.toGeneration === body.completeEncryptionRotation) {
            rotations.set(served, null);
          }
        }
        const rotation = rotations.get(served) ?? null;

        // `noteCap` is a fifth sibling — the free managed tier's cap — split
        // here for the reason above: a fixture may nest it, the wire never does.
        const { searchIndex, encryptionKey, noteCap, ...storage } = binding;
        const envelope = (workspaceId) => ({
          binding: workspaceId === null ? { ...storage } : { workspaceId, ...storage },
          ...(searchIndex ? { searchIndex } : {}),
          ...(noteCap ? { noteCap } : {}),
          ...(encryptionKey ? { encryptionKey } : {}),
          ...(rotation ? { rotation } : {}),
        });
        if (flags.omitBindingWorkspaceId) return ok(envelope(null));
        return ok(envelope(served));
      }

      case "/gateway/provider": {
        /*
          The same two proofs the binding route spends, in the same order, with
          the same refusal. Written out rather than sharing a helper with
          `/gateway/binding` on purpose: these are two doors on the real control
          plane, and a stub that collapses them into one would pass a gateway
          that had quietly started sending the wrong shape to one of them.
        */
        const grant = await grantForAccessToken(body.accessToken);
        if (!grant) return ok({ credential: null });
        const covered = coveredContexts(grant);
        const named =
          body.expectedWorkspaceId === null || body.expectedWorkspaceId === undefined
            ? covered.find((entry) => entry.workspaceId === grant.workspaceId)
            : covered.find((entry) => entry.workspaceId === body.expectedWorkspaceId);
        if (!named) return ok({ credential: null });

        // The closed set lives on the control plane, and an unknown provider is
        // the same `null` as an unknown token — never a different status a
        // caller could count to enumerate it.
        if (body.provider !== "anthropic" && body.provider !== "openai") {
          return ok({ credential: null });
        }
        const apiKey = providerCredentials.get(`${named.workspaceId}:${body.provider}`);
        if (apiKey === undefined) return ok({ credential: null });
        // Two flat fields and nothing beside them — no workspace id, no
        // fingerprint, no grant. See the route's own header in `http.ts`.
        return ok({ credential: { provider: body.provider, apiKey } });
      }

      case "/gateway/clients/register": {
        // `calls` above already recorded what was forwarded; a test reads the
        // registrant key off that. This flag models the one answer the real
        // control plane gives that the gateway has to translate rather than
        // relay: a registration refused for going too fast.
        if (flags.registrationRateLimited) {
          return { status: 429, json: async () => ({ error: "rate_limited" }), text: async () => "" };
        }
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
          consentUrl: `${consentOrigin}/authorize?request_id=${requestId}`,
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

      case "/gateway/jobs/create": {
        const grant = await grantForAccessToken(body.accessToken);
        if (!grant) return ok({ ticket: null });
        const covered = coveredContexts(grant);
        const named = covered.find((entry) => entry.workspaceId === body.expectedWorkspaceId);
        if (!named || named.role !== "owner") return ok({ ticket: null });
        if (!grant.scopes.includes("context:write") || !grant.scopes.includes("context:private")) {
          return ok({ ticket: null });
        }
        if (body.job?.kind !== "materialize_move" || typeof body.job?.moveId !== "string") {
          return ok({ ticket: null });
        }
        const ticket = `job-ticket-${gatewayJobs.size + 1}`;
        gatewayJobs.set(ticket, {
          workspaceId: named.workspaceId,
          actorUserId: grant.userId,
          actorClientId: grant.clientId,
          grantId: grant.grantId,
          kind: "materialize_move",
          moveId: body.job.moveId,
          status: "queued",
        });
        return ok({ ticket });
      }

      case "/gateway/jobs/open": {
        const job = gatewayJobs.get(body.ticket);
        if (!job || job.status !== "queued") return ok({ job: null });
        job.status = "running";
        const binding = bindings.get(job.workspaceId);
        if (!binding) return ok({ job: null });
        const { searchIndex, encryptionKey, ...storage } = binding;
        return ok({
          job: {
            job: {
              workspaceId: job.workspaceId,
              actorUserId: job.actorUserId,
              actorClientId: job.actorClientId,
              grantId: job.grantId,
              kind: job.kind,
              moveId: job.moveId,
            },
            binding: { workspaceId: job.workspaceId, ...storage, status: "active" },
            ...(searchIndex ? { searchIndex } : {}),
            ...(encryptionKey ? { encryptionKey } : {}),
          },
        });
      }

      case "/gateway/jobs/report": {
        const job = gatewayJobs.get(body.ticket);
        if (job && job.status === "running" && body.result) {
          job.status = body.result.status;
          job.lastError = body.result.error;
          job.progress = body.result.progress;
        }
        return ok({ ok: true });
      }

      /*
        LINKS — the reference implementation of the three link routes.

        The clearance is copied from `/gateway/jobs/create` above rather than
        loosened, because it is the same clearance in the real deployment:
        `ownerClearanceForGateway` wants owner, `context:write` and
        `context:private` off a live grant. A stub that cleared more than the
        real route would let the gateway's own tests pass on an authority it
        does not have.

        The URL is built here the way the control plane builds it, and the
        TOKEN IS NEVER RETURNED — which is the property the gateway tests
        assert against this stub.
      */
      case "/gateway/links/create": {
        const cleared = await clearedOwner(body);
        if (!cleared) return ok({ link: null, shortRefused: null });
        if (typeof body.path !== "string" || body.path === "") {
          return ok({ link: null, shortRefused: null });
        }
        const audience = body.audience === "members" ? "members" : "anyone";
        const key = `${cleared.workspaceId}:${body.path}:${audience}`;
        const existing = [...links.values()].find(
          (row) => row.key === key && row.status === "active",
        );
        const row = existing ?? {
          shareId: `share_${links.size + 1}`,
          key,
          workspaceId: cleared.workspaceId,
          token: `${"f".repeat(63)}${links.size + 1}`,
          audience,
          entryPath: body.path,
          slug: null,
          status: "active",
          createdAt: 1,
        };
        // Applied on a re-mint too, and preserved when unstated — the real
        // `mintLinkShare` does both, and a stub that only set it on creation
        // would hide the bug that branch already had once.
        if (body.mode !== undefined) row.mode = body.mode;
        // The real `mintLinkShare` normalizes and keeps `null` meaning "the
        // default stands", never "unlimited". The stub agrees so that a
        // gateway test cannot pass against a laxer rule than production's.
        if (
          typeof body.collectCap === "number" &&
          Number.isInteger(body.collectCap) &&
          body.collectCap >= 1 &&
          body.collectCap <= 10000
        ) {
          row.collectCap = body.collectCap;
        }
        links.set(row.shareId, row);

        let shortRefused = null;
        if (typeof body.short === "string") {
          const slug = body.short.trim().toLowerCase();
          const taken = [...links.values()].find(
            (other) =>
              other.workspaceId === cleared.workspaceId &&
              other.slug === slug &&
              other.status === "active" &&
              other.shareId !== row.shareId,
          );
          if (!/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(slug)) {
            shortRefused =
              "A short link's name is lowercase letters, digits and hyphens, and cannot start or end with a hyphen.";
          } else if (["settings", "index", "privacy", "todo", "1-projects"].includes(slug)) {
            shortRefused = "That name is reserved for Context itself.";
          } else if (taken) {
            shortRefused = "That name already points at another link in this context.";
          } else {
            row.slug = slug;
          }
        }
        return ok({ link: describeStubLink(row), shortRefused });
      }

      case "/gateway/links/list": {
        const cleared = await clearedOwner(body);
        if (!cleared) return ok({ links: null });
        return ok({
          links: [...links.values()]
            .filter((row) => row.workspaceId === cleared.workspaceId && row.status === "active")
            .map((row) => describeStubLink(row)),
        });
      }

      case "/gateway/links/revoke": {
        const cleared = await clearedOwner(body);
        if (!cleared) return ok({ revoked: false });
        const row = links.get(body.shareId);
        // The cleared workspace, never the row's: an id from another context
        // answers exactly as an invented one does.
        if (!row || row.status !== "active" || row.workspaceId !== cleared.workspaceId) {
          return ok({ revoked: false });
        }
        row.status = "revoked";
        return ok({ revoked: true });
      }

      case "/gateway/activity": {
        // One field in, one word out. The real route answers `{ok: true}` on
        // every path — including an id that is not a workspace — because the
        // difference between "no such context" and "not yours" is exactly the
        // oracle a gateway-authenticated route must not be, and the stub is
        // only useful as a contract if it is identical in that.
        if (typeof body.workspaceId === "string" && body.workspaceId) {
          const at = Date.now();
          const previous = activityStamps.get(body.workspaceId) ?? {};
          activityStamps.set(body.workspaceId, {
            at,
            // Only a `team` line moves the stamp a non-owner member reads, and
            // an omitted flag reads as private — the real mutation's rule.
            teamAt: body.teamVisible === true ? at : previous.teamAt,
          });
        }
        return ok({ ok: true });
      }

      case "/gateway/tree": {
        // Answered `{ok: true}` on every path, like `/gateway/activity`.
        // `calls` carries the body, which is what a test asserts on.
        return ok({ ok: true });
      }

      case "/gateway/forms/notify": {
        // The real route answers `{ok: true}` on every path, for the reason
        // `/gateway/activity` does: the difference between "no such context",
        // "nobody by that name here" and "they have no verified address" is
        // three facts about other people, and a status code is a channel back
        // to a worker that is not listening anyway. `calls` already carries
        // the body, so a test asserts what the gateway reported by reading
        // that rather than by a second recording here.
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

  /** Connect a model account to one workspace, as the console's action does. */
  function connectProvider(workspaceId, provider, apiKey) {
    providerCredentials.set(`${workspaceId}:${provider}`, apiKey);
  }

  return {
    gatewayCalls,
    origin,
    secret,
    handle,
    install,
    addWorkspace,
    addGrant,
    revoke,
    issueCode,
    connectProvider,
    providerCredentials,
    grants,
    clients,
    codes,
    bindings,
    flags,
    accessTokens,
    refreshTokens,
    gatewayJobs,
    activityStamps,
    pendingAuthorizations,
    calls,
  };
}

