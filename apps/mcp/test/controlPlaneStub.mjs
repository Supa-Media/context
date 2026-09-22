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

        const { searchIndex, encryptionKey, ...storage } = binding;
        const envelope = (workspaceId) => ({
          binding: workspaceId === null ? { ...storage } : { workspaceId, ...storage },
          ...(searchIndex ? { searchIndex } : {}),
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
  /*
    Requests, counted by method.

    Two refusals that are byte-identical to read and a different number of
    round trips apart are still two answers — the second one is just measured
    with a clock rather than read. Counting them is what turns an
    indistinguishability claim into a deterministic check instead of a flaky
    timing one. See the cost checks that use `trips()`.
  */
  const ops = { GET: 0, HEAD: 0, PUT: 0, DELETE: 0, LIST: 0 };
  const trips = () => Object.values(ops).reduce((sum, count) => sum + count, 0);

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
    if (method === "GET" && parsed.searchParams.get("list-type") === "2") ops.LIST += 1;
    else if (ops[method] !== undefined) ops[method] += 1;

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

    // A real bucket answers HEAD, so this one does. Modelled on GET and
    // deliberately body-less: HEAD is how the gateway asks whether an object
    // is there without pulling it, and a fake that only knew GET would make
    // that question look impossible.
    if (method === "HEAD") {
      const object = objects.get(key);
      if (!object) return new Response("", { status: 404 });
      return new Response(null, {
        status: 200,
        headers: {
          etag: `"${object.etag}"`,
          ...(object.contentType ? { "content-type": object.contentType } : {}),
        },
      });
    }

    if (method === "GET") {
      const object = objects.get(key);
      if (!object) return new Response("", { status: 404 });
      return new Response(object.body, {
        status: 200,
        headers: {
          etag: `"${object.etag}"`,
          ...(object.contentType ? { "content-type": object.contentType } : {}),
        },
      });
    }

    if (method === "PUT") {
      const ifMatch = init.headers?.["if-match"];
      const ifNoneMatch = init.headers?.["if-none-match"];
      if (ifNoneMatch === "*" && objects.has(key)) return new Response("", { status: 412 });
      const copySource = init.headers?.["x-amz-copy-source"];
      if (copySource) {
        const copyPath = String(copySource).replace(/^\/+/, "");
        const [sourceBucketName, ...sourceKeyParts] = copyPath.split("/");
        const sourceKey = sourceKeyParts.map(decodeURIComponent).join("/");
        const sourceObjects = bucketFor(decodeURIComponent(sourceBucketName || ""));
        const source = sourceObjects.get(sourceKey);
        const sourceIfMatch = init.headers?.["x-amz-copy-source-if-match"]?.replace(/^"|"$/g, "");
        if (!source) return new Response("", { status: 404 });
        if (sourceIfMatch && source.etag !== sourceIfMatch) return new Response("", { status: 412 });
        /*
          A COPY PRESERVES THE SOURCE'S ETAG, because a real one does.

          S3 CopyObject returns the source's ETag for a single-part object —
          the ETag is the content MD5 and the content did not change. This stub
          used to mint a fresh counter value instead, which is the one place it
          disagreed with the backend it stands in for, and it disagreed in the
          direction that hides a branch: `canVerifyMoveByEtag` lets a resuming
          move skip the byte-for-byte comparison when the destination's etag
          already equals the source's, and against a stub whose copy always
          changed the etag **that branch could never be taken by any test**.

          Making it faithful costs nothing — measured, 0 failures across both
          suites — and it is the difference between a harness that could catch
          a regression in the copy path and one that could not.

          It does NOT make the shortcut's *soundness* testable: that needs a
          store whose etag is not derived from content, which no fixture here
          models. See the header note.
        */
        const etag = source.etag;
        objects.set(key, { body: source.body, etag, contentType: source.contentType });
        return new Response(
          `<CopyObjectResult><ETag>&quot;${etag}&quot;</ETag></CopyObjectResult>`,
          { status: 200 }
        );
      }
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
      objects.set(key, {
        body,
        etag,
        contentType: init.headers?.["content-type"],
      });
      return new Response("", { status: 200, headers: { etag: `"${etag}"` } });
    }

    if (method === "DELETE") {
      const ifMatch = init.headers?.["if-match"];
      if (ifMatch) {
        const expected = ifMatch.replace(/^"|"$/g, "");
        const current = objects.get(key);
        if (!current || current.etag !== expected) return new Response("", { status: 412 });
      }
      objects.delete(key);
      return new Response(null, { status: 204 });
    }

    return new Response("", { status: 405 });
  }

  function install() {
    const previous = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.startsWith(endpointOrigin)) return api.handle(url, init);
      return previous ? previous(input, init) : new Response("", { status: 404 });
    };
    return () => {
      globalThis.fetch = previous;
    };
  }

  const api = { endpoint: endpointOrigin, buckets, bucketFor, handle, install, ops, trips };
  return api;
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
  /**
   * access token → Set(dropbox folder path)
   *
   * **This is the thing the fake used to get wrong**, and it is the difference
   * between Dropbox and every other backend here. Folders were synthesised
   * from the keys, exactly as `S3Store` has to synthesise them — so an emptied
   * directory vanished from the fake and stayed in the product. A folder move
   * on Dropbox left its source folder behind, went on listing it, and read as
   * a copy; the suite could not see it because the fake was an S3 wearing
   * Dropbox's URLs.
   *
   * Real directories, created by an upload and removed only by a delete aimed
   * at them, are what make that reproducible.
   */
  const directories = new Map();
  let revCounter = 0;

  /** Register an account and return its file map, so a test can seed it. */
  function accountFor(accessToken) {
    if (!accounts.has(accessToken)) accounts.set(accessToken, new Map());
    if (!directories.has(accessToken)) directories.set(accessToken, new Set());
    for (const key of accounts.get(accessToken).keys()) noteAncestors(accessToken, key);
    return accounts.get(accessToken);
  }

  /** Folders a path implies, the way an upload creates them on Dropbox. */
  function noteAncestors(token, path) {
    const held = directories.get(token);
    if (!held) return;
    const parts = path.replace(/^\//, "").split("/").slice(0, -1);
    for (let end = 1; end <= parts.length; end += 1) {
      held.add(`/${parts.slice(0, end).join("/")}`);
    }
  }

  /** Every folder registered for an account, so a test can assert on them. */
  function foldersFor(accessToken) {
    if (!directories.has(accessToken)) directories.set(accessToken, new Set());
    for (const key of accounts.get(accessToken)?.keys() || []) noteAncestors(accessToken, key);
    return directories.get(accessToken);
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

    // Dropbox answers "is this file there" with `get_metadata`, never with a
    // folder listing, and the adapter now asks it that way. A fake that knew
    // only `list_folder` would make the existence check look unavailable on
    // this backend — which is the shape of the real bug it was added for.
    if (path === "/2/files/get_metadata") {
      const file = files.get(body.path);
      if (!file) return notFound();
      return json({ ".tag": "file", rev: file.rev, path_display: body.path, size: file.body.length });
    }

    if (path === "/2/files/upload") {
      const current = files.get(arg.path);
      if (arg.mode?.[".tag"] === "update" && current?.rev !== arg.mode.update) return conflict();
      const rev = `r${++revCounter}`;
      files.set(arg.path, { body: decodeBody(init.body), rev });
      // An upload creates the folders above it, and they outlive the file.
      noteAncestors(token, arg.path);
      return json({ rev, path_display: arg.path, size: files.get(arg.path).body.length });
    }

    if (path === "/2/files/delete_v2") {
      const held = directories.get(token) || new Set();
      if (files.delete(body.path)) return json({ metadata: { path_display: body.path } });
      // Dropbox deletes a folder recursively, which is why the adapter has to
      // establish emptiness before it asks.
      if (held.has(body.path)) {
        held.delete(body.path);
        for (const key of [...files.keys()]) {
          if (key.startsWith(`${body.path}/`)) files.delete(key);
        }
        for (const folder of [...held]) {
          if (folder.startsWith(`${body.path}/`)) held.delete(folder);
        }
        return json({ metadata: { path_display: body.path } });
      }
      return notFound();
    }

    if (path === "/2/files/list_folder") {
      const held = directories.get(token) || new Set();
      const root = body.path === "" ? "/" : `${body.path}/`;
      const children = [...files.keys()].filter((key) => key.startsWith(root)).sort();
      if (body.path !== "" && children.length === 0 && !held.has(body.path)) return notFound();
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
      /*
        Directories that exist in their own right, including the empty ones.
        An S3 cannot produce this entry and Dropbox does, which is the whole
        reason this fake keeps a folder set rather than deriving one.
      */
      for (const folder of held) {
        if (!folder.startsWith(root) || folder === body.path) continue;
        if (!body.recursive && folder.slice(root.length).includes("/")) continue;
        folders.add(folder);
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

  return { accounts, accountFor, foldersFor, handle, install };
}
