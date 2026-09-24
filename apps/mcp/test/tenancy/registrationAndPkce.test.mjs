/**
 * Multi-tenancy: OAuth dynamic client registration and the start of the
 * authorization flow (§8) — client naming (line breaks, bidi overrides,
 * invisible spacers, the Persian/emoji carve-out), the registrant-key rate
 * limiter (address normalization across IPv4/IPv6, mapped/compatible/NAT64
 * forms, padded octets, overfull `::` groups), and PKCE enforcement at
 * `/oauth/authorize` (S256-only, a required challenge).
 *
 * Split out of tenancy.test.mjs; see fixtures.mjs for the shared harness and
 * that file's module doc for the sabotage-testing record. `registered`,
 * `clientId`, `verifier`, `challengeValue` and `authorizeUrl` are recorded
 * onto `harness` because §9-12 (redirectAndToken.test.mjs) continue this
 * same authorization flow.
 */

import { CONTROL_PLANE_ORIGIN, s256, worker } from "./fixtures.mjs";

export async function runTenancyRegistrationAndPkceChecks(check, harness) {
  const { env, controlPlane } = harness;

  /* ------------------------- 8. registration and PKCE ------------------------ */

  const registration = await worker.fetch(
    new Request("https://mcp.context.test/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Test Client",
        redirect_uris: ["https://client.test/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        application_type: "web",
      }),
    }),
    env,
    { waitUntil() {} }
  );
  const registered = await registration.json();
  check("dynamic client registration returns 201", registration.status === 201);
  check("registration returns a client_id", typeof registered.client_id === "string");
  check("a public client gets no secret", registered.client_secret === undefined);

  /*
    WHAT A CLIENT MAY CALL ITSELF, GIVEN THAT THE PERSON READS IT.

    `client_name` is client-asserted — registration is unauthenticated by
    construction — and it is the string the consent screen puts in the sentence
    somebody reads before pressing Approve, as well as the one the connections
    list and the audit trail carry. `software_id`, which nothing renders, is
    already bounded to a boring alphabet so that "nothing that lands in the
    control plane can carry markup, whitespace tricks, or a paragraph". The
    field that IS rendered had only `trim()` and a length cap, which remove
    neither.

    What currently stops a name full of newlines from pushing the redirect host
    out of the reader's way is a ScrollView that holds the whole page including
    the buttons — so scrolling to Approve scrolls past the truth. That is a real
    defence and it is why this is not worse; it is also a layout chosen to make
    an OAuth flow finishable on a phone, not to bound this. A guard nobody
    picked is a guard nobody will keep.

    Asserted on what reaches the CONTROL PLANE, not on the echo: the echo is a
    courtesy to the client, the stored row is what every reader renders.
  */
  const registerNamed = async (name) => {
    const response = await worker.fetch(
      new Request("https://mcp.context.test/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: name,
          redirect_uris: ["https://client.test/callback"],
          token_endpoint_auth_method: "none",
        }),
      }),
      env,
      { waitUntil() {} }
    );
    const json = await response.json();
    return { echoed: json.client_name, stored: controlPlane.clients.get(json.client_id).clientName };
  };

  const lineBroken = await registerNamed("Context\n\n\n\n\nAlready approved — press Approve");
  check(
    "a client name cannot carry a line break into the sentence somebody reads",
    !/[\r\n]/.test(lineBroken.stored)
  );
  check(
    "collapsing the break leaves the words, not a run of spaces",
    lineBroken.stored === "Context Already approved — press Approve"
  );

  const invisible = await registerNamed("Cont​ext‮Desktop\u0007⁦﻿");
  check(
    "a client name cannot carry a control, a bidi override or an invisible spacer",
    !/[\p{Cc}؜​‎‏‪-‮⁠⁦-⁩﻿]/u.test(
      invisible.stored
    )
  );

  /*
    THE CARVE-OUT, WHICH NEEDS ITS OWN PROOF RATHER THAN THE RULE'S.

    `U+200C`/`U+200D` are `Cf` like the bidi controls, and the first version of
    the normaliser took the whole category — which silently rewrites any name
    that is not in English. The non-joiner is orthography in Persian and several
    Indic scripts, and the joiner is what holds an emoji sequence together, so
    both are kept on purpose. An exception asserted by nothing is an exception
    the next tidy-up deletes.
  */
  const persian = await registerNamed("می‌رود");
  check(
    "a zero-width non-joiner survives, because in Persian it is a letter boundary",
    persian.stored === "می‌رود"
  );

  const emoji = await registerNamed("Context on Seyi's \u{1F468}‍\u{1F4BB}");
  check(
    "an emoji sequence is not taken apart by the normaliser",
    emoji.stored === "Context on Seyi's \u{1F468}‍\u{1F4BB}"
  );

  const ordinary = await registerNamed("  Claude Code (v2.1) — Seyi's laptop  ");
  check(
    "an ordinary name with punctuation and accents is kept as written",
    ordinary.stored === "Claude Code (v2.1) — Seyi's laptop"
  );

  const onlyNoise = await registerNamed("​​\u0000\n\t");
  check(
    "a name that is nothing but noise falls back rather than reaching the console empty",
    onlyNoise.stored === "Unnamed MCP client"
  );

  const longAfterCollapse = await registerNamed(`${"\n".repeat(200)}${"a".repeat(130)}`);
  check(
    "the length cap is applied after the collapse, so padding cannot eat the name",
    longAfterCollapse.stored === "a".repeat(120)
  );

  const cutMidPair = await registerNamed(`${"b".repeat(119)}\u{1F600}x`);
  check(
    "the cap never cuts a character in half, which only this function could do",
    !/[\uD800-\uDBFF]$/.test(cutMidPair.stored) && cutMidPair.stored === "b".repeat(119)
  );

  check(
    "the client is told what was kept, so a normalised name is not a silent edit",
    lineBroken.echoed === lineBroken.stored && invisible.echoed === invisible.stored
  );

  /*
    WHAT THE REGISTRATION RATE LIMIT IS KEYED ON, AND THAT IT IS NOT AN ADDRESS.

    Registration is the only unauthenticated write in the control plane, and
    every call mints a permanent row nothing sweeps. The limit lives there; what
    lives here is the bucket name, and two properties of it that the control
    plane cannot check for itself: that a key is sent at all, and that it is not
    the caller's IP address.

    A key that silently stopped being sent would not fail anything — the control
    plane would just put every registration on the internet into one shared
    bucket, which is a global limit wearing a per-registrant limit's clothes.
  */
  const registerFrom = async (address) => {
    const before = controlPlane.calls.length;
    const response = await worker.fetch(
      new Request("https://mcp.context.test/oauth/register", {
        method: "POST",
        headers: address
          ? { "Content-Type": "application/json", "CF-Connecting-IP": address }
          : { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Keyed",
          redirect_uris: ["https://client.test/callback"],
          token_endpoint_auth_method: "none",
        }),
      }),
      env,
      { waitUntil() {} }
    );
    const call = controlPlane.calls
      .slice(before)
      .find((entry) => entry.path === "/gateway/clients/register");
    /*
      THE STATUS, NOT ONLY THE KEY, and the reason is a defect review measured
      in the first version of this helper: it returned the key alone, so
      `undefined` was equally true when the control plane had **never been
      called**. The check below named for "still registers with no header"
      therefore PASSED under a sabotage that made a missing header refuse the
      registration outright — what went red was 28 unrelated OAuth tests that
      happen not to set the header. The property was protected by accident, by
      neighbours, which is this register's own definition of not a guard.
    */
    return { status: response.status, key: call?.body?.registrantKey };
  };

  /*
    RFC 7591's `software_id`, stored as declared and bounded on the way in.

    One reader downstream: the control plane mints the desktop shell's machine
    grant with no approve screen, and refuses to do that for a client that did
    not declare itself the shell. It is **client-asserted** — registration is
    unauthenticated by construction — so what is checked here is only that this
    server carries it faithfully and cannot be used to smuggle anything through
    on that field. What bounds the convenience is loopback and scope, on the
    control-plane side, where `machineGrant.ts` holds it.
  */
  const declaredBy = async (softwareId) => {
    const before = controlPlane.calls.length;
    const response = await worker.fetch(
      new Request("https://mcp.context.test/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Context on a-laptop",
          redirect_uris: ["http://127.0.0.1/context-hook/callback"],
          token_endpoint_auth_method: "none",
          application_type: "native",
          ...(softwareId === undefined ? {} : { software_id: softwareId }),
        }),
      }),
      env,
      { waitUntil() {} }
    );
    const call = controlPlane.calls
      .slice(before)
      .find((entry) => entry.path === "/gateway/clients/register");
    return { status: response.status, declared: call?.body?.softwareId, body: await response.json() };
  };

  const declared = await declaredBy("lc.context.desktop");
  check("a declared software_id reaches the control plane as declared", declared.declared === "lc.context.desktop");
  check("...and is echoed back, so a client can tell it was kept", declared.body.software_id === "lc.context.desktop");
  const silent = await declaredBy(undefined);
  check("a client that declares none sends none", silent.declared === undefined && silent.status === 201);
  check("...and nothing is echoed for it", silent.body.software_id === undefined);
  const shouty = await declaredBy("<script>alert(1)</script>");
  check(
    "A SOFTWARE_ID OUTSIDE THE ALPHABET IS DROPPED, NOT STORED",
    shouty.declared === undefined && shouty.status === 201
  );
  const long = await declaredBy("x".repeat(200));
  check("...and so is one past the length bound", long.declared === undefined);
  const wrongType = await declaredBy(42);
  check("...and one that is not a string at all", wrongType.declared === undefined);

  const { key: keyFromOne } = await registerFrom("203.0.113.7");
  const { key: keyFromOneAgain } = await registerFrom("203.0.113.7");
  const { key: keyFromAnother } = await registerFrom("203.0.113.8");
  check("a registration carries a registrant key", typeof keyFromOne === "string");
  check("...stable for the same address, so a flood lands in one bucket", keyFromOne === keyFromOneAgain);
  check("...and different for another, so it costs its own source", keyFromOne !== keyFromAnother);
  check(
    "...and it is not the address, which the control plane has no reason to hold",
    !keyFromOne.includes("203.0.113.7") && keyFromOne !== "203.0.113.7"
  );
  /*
    `X-Forwarded-For` is deliberately not read: a client sets it, so keying on
    it would let one source spend everybody else's budget — or its own, over and
    over, by changing it. Cloudflare overwrites `CF-Connecting-IP` on the way
    in, which is the whole reason that is the header.
  */
  const forged = await worker.fetch(
    new Request("https://mcp.context.test/oauth/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "203.0.113.9",
        "CF-Connecting-IP": "203.0.113.7",
      },
      body: JSON.stringify({
        client_name: "Forged",
        redirect_uris: ["https://client.test/callback"],
        token_endpoint_auth_method: "none",
      }),
    }),
    env,
    { waitUntil() {} }
  );
  const forgedKey = controlPlane.calls
    .filter((entry) => entry.path === "/gateway/clients/register")
    .at(-1)?.body?.registrantKey;
  check("a client-supplied forwarding header cannot move the bucket", forgedKey === keyFromOne);
  check("...and the registration still succeeds", forged.status === 201);

  /*
    No header at all — a self-hosted gateway behind something that does not set
    one. It sends no key, which the control plane reads as the shared
    unattributed bucket. The positive twin matters more than usual here: this
    must still REGISTER, because refusing would break self-hosting, which
    CLAUDE.md names as a supported path.
  */
  const withoutHeader = await registerFrom(null);
  check("a gateway with no address header sends no key", withoutHeader.key === undefined);
  check("...and the registration still succeeds, because refusing breaks self-hosting", withoutHeader.status === 201);

  /*
    ONE HOST IS ONE BUCKET, AND ONE NETWORK IS ONE BUCKET.

    A key a stranger can rotate is a write amplification on a table nothing
    sweeps — this repository argues that at the ingestion limiter, and the
    first version of this change reproduced exactly what that comment
    prevents. An IPv6 host routinely holds a whole /64, so keying on the
    address is 2^64 free buckets and 2^64 permanent limiter rows. Measured on
    that version: 100 registrations from a rotating address left 100 client
    rows AND 100 limiter rows, against 100 with no limit at all — the limit
    made the growth worse.

    So these are the shapes that must agree, and the ones that must not.
  */
  const netOf = async (address) => (await registerFrom(address)).key;
  const canonicalSix = await netOf("2001:db8::1");
  check("an expanded IPv6 address is the same bucket as its short form",
    (await netOf("2001:0db8:0000:0000:0000:0000:0000:0001")) === canonicalSix);
  check("...and so is its upper-case form", (await netOf("2001:DB8::1")) === canonicalSix);
  check("...and another address in the same /64, which one customer holds",
    (await netOf("2001:db8::dead:beef")) === canonicalSix);
  check("...and the same host with a port and brackets",
    (await netOf("[2001:db8::1]:443")) === canonicalSix);
  check("a DIFFERENT /64 is a different bucket, so this is not simply constant",
    (await netOf("2001:db8:0:1::1")) !== canonicalSix);
  check("an IPv4-mapped address is the same bucket as the IPv4 host it names",
    (await netOf("::ffff:203.0.113.7")) === keyFromOne);
  check("...and an IPv4 address with a port is that host, not a second bucket",
    (await netOf("203.0.113.7:443")) === keyFromOne);
  check("an unparseable address shares the unattributed bucket rather than minting one",
    (await netOf("not-an-address")) === undefined);

  /*
    A QUAD AT THE END OF AN IPv6 ADDRESS IS NOT ALWAYS AN IPv4 HOST.

    The first version of this took the dotted quad whenever the text ended in
    one, ignoring what came before it. `2001:db8::203.0.113.7` is a perfectly
    ordinary address inside `2001:db8::/64`, and it was spending IPv4 host
    `203.0.113.7`'s budget: one network poisoning another's bucket, which is
    the worse of the two directions this function can fail in.

    Only two prefixes really name an IPv4 host — `::ffff:0:0/96` (mapped) and
    the deprecated all-zero compatible form. `64:ff9b::/96` is NAT64 and
    `::ffff:0:0:0/96` is SIIT: in both the embedded quad is the *destination*
    being translated to, never the source, so crediting it to that host lets a
    translator spend an arbitrary stranger's budget.
  */
  check("an IPv4-mapped address is still the host it names", (await netOf("::ffff:203.0.113.7")) === keyFromOne);
  /*
    The IPv4-COMPATIBLE form used to be read as the host too, and is not any
    more — argued at the block below, where the numeric classification is. It
    is deprecated by RFC 4291 and it is the same address as `::cb00:7107`, so
    reading it as a host is a claim about spelling rather than about identity.
  */
  check("...but the deprecated compatible form is an ordinary address in ::/64",
    (await netOf("::203.0.113.7")) !== keyFromOne);
  check("a NAT64 address is its own network, not the host it translates to",
    (await netOf("64:ff9b::203.0.113.7")) !== keyFromOne);
  check("...and an ordinary address that merely ENDS in a quad is its own /64",
    (await netOf("2001:db8::203.0.113.7")) !== keyFromOne);
  check("...which is the /64 it belongs to, so it shares with its neighbours",
    (await netOf("2001:db8::203.0.113.7")) === canonicalSix);
  check("a SIIT-translated address is not the host either",
    (await netOf("::ffff:0:203.0.113.7")) !== keyFromOne);

  /*
    AND ONE IPv4 HOST HAS ONE SPELLING, OR IT HAS UNBOUNDED BUCKETS.

    `\d+` per octet accepts leading zeros without limit, so `203.000.113.007`
    and `00000000203.0.113.7` were a second and third bucket for one host —
    the exact rotation the /64 work exists to close, arriving through the
    branch that had not been normalised. Octets are parsed now: one to three
    digits, no leading zero unless the octet IS zero, and at most 255.

    REFUSED rather than normalised, which is the opposite of what the first
    draft of these two checks asserted. A padded octet is ambiguous — it has
    meant octal — and no legitimate producer emits one, so reading `007` as
    seven is a guess about what somebody meant. Refusing sends it to the
    shared bucket, which closes the rotation just as completely (every padded
    form collapses to one bucket) without deciding what it meant.
  */
  check("a padded IPv4 address is not a second bucket for the same host",
    (await netOf("203.000.113.007")) === undefined);
  check("...however much padding is on it", (await netOf("00000000203.0.113.7")) === undefined);
  check("an octet above 255 is not an address at all", (await netOf("999.1.1.1")) === undefined);
  check("...nor is one with too many parts", (await netOf("203.0.113.7.9")) === undefined);

  /*
    `::` STANDS FOR AT LEAST ONE GROUP, AND AN ADDRESS THAT IS ALREADY FULL
    HAS NO ROOM FOR IT.

    `Array(8 - left - right)` goes negative when an address carries `::` and
    eight or more explicit groups, and `Array(-1)` throws `RangeError`. The
    throw escapes `registrantKey`, is caught by `handleRegister`'s catch, is
    not a `ControlPlaneError`, and reaches the `/oauth/` catch as **503
    server_error** — a legitimate registration refused as "this server is
    broken", for an address this function's own docblock promises returns
    `null`. Structured fuzzing found it in 10,303 of 40,000 tries; 40,000
    unstructured strings had found none, which is why the first probe missed
    it.
  */
  for (const overfull of [
    "1:2:3:4:5:6:7:8::9",
    "::1:2:3:4:5:6:7:8:9",
    "1:2:3:4:5:6:7::1.2.3.4",
    "1:2:3:4:5:6:7:8::",
    "::1:2:3:4:5:6:7:8",
  ]) {
    check(`an over-full address with :: is refused rather than thrown on (${overfull})`,
      (await netOf(overfull)) === undefined);
  }

  /*
    AND THE CLASSIFICATION IS ABOUT THE ADDRESS, NOT ABOUT HOW IT IS SPELT.

    Deciding "is this an IPv4 host" from the text — does the last group contain
    a dot — split one address into two buckets: `::ffff:203.0.113.7` was the
    IPv4 host and `::ffff:cb00:7107`, the same address in hex, was
    `0:0:0:0::/64`. Both directions at once, because that /64 is also where
    EVERY hex-spelled mapped address landed, so 2^32 IPv4 hosts shared one
    bucket with `::` and `::1`.

    It expands to eight hextets first now and classifies from the numbers, so
    the two spellings agree.

    **Only the mapped prefix counts.** `::a.b.c.d` — the IPv4-COMPATIBLE form —
    is deprecated by RFC 4291, and reading it as an IPv4 host would mean `::1`
    is host `0.0.0.1`, since those are the same address. It stays an ordinary
    address in `::/64`. That is a deliberate change from the previous
    behaviour, which called it the host.
  */
  check("a mapped address in hex is the same bucket as the same address in dotted form",
    (await netOf("::ffff:cb00:7107")) === keyFromOne);
  check("...and both are the IPv4 host they name", (await netOf("::ffff:203.0.113.7")) === keyFromOne);
  check("the deprecated compatible form is NOT read as an IPv4 host",
    (await netOf("::203.0.113.7")) !== keyFromOne);
  check("...because it is the same address as its hex spelling, which never was",
    (await netOf("::203.0.113.7")) === (await netOf("::cb00:7107")));
  check("...and loopback is not IPv4 host 0.0.0.1", (await netOf("::1")) === (await netOf("::0.0.0.1")));

  /*
    And the one answer the gateway has to translate rather than relay. The
    `/oauth/` catch upstairs turns every control-plane failure into 503
    `server_error`; a client cannot tell "retry in an hour" from "retry now",
    and 503 invites the second.
  */
  controlPlane.flags.registrationRateLimited = true;
  const limited = await worker.fetch(
    new Request("https://mcp.context.test/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
      body: JSON.stringify({
        client_name: "Too many",
        redirect_uris: ["https://client.test/callback"],
        token_endpoint_auth_method: "none",
      }),
    }),
    env,
    { waitUntil() {} }
  );
  controlPlane.flags.registrationRateLimited = false;
  check("a rate-limited registration is 429, not 503", limited.status === 429);
  check("...and says when to come back", limited.headers.get("Retry-After") === "3600");

  const badRedirect = await worker.fetch(
    new Request("https://mcp.context.test/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Insecure",
        redirect_uris: ["http://evil.test/callback"],
      }),
    }),
    env,
    { waitUntil() {} }
  );
  check(
    "a non-loopback http redirect URI is rejected at registration",
    badRedirect.status === 400 && (await badRedirect.json()).error === "invalid_redirect_uri"
  );

  const clientId = registered.client_id;
  const verifier = "a".repeat(64);
  const challengeValue = await s256(verifier);

  const authorizeUrl = (overrides = {}) => {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://client.test/callback",
      code_challenge: challengeValue,
      code_challenge_method: "S256",
      state: "xyz",
      scope: "context:read context:write",
      resource: "https://mcp.context.test/mcp",
      ...overrides,
    });
    return `https://mcp.context.test/oauth/authorize?${params}`;
  };

  const authorized = await worker.fetch(new Request(authorizeUrl()), env, { waitUntil() {} });
  check("a valid authorization request redirects to consent", authorized.status === 302);
  check(
    "consent is hosted by the control plane, not the gateway",
    (authorized.headers.get("Location") || "").startsWith(CONTROL_PLANE_ORIGIN)
  );

  // The other half of the pair above: what discovery advertises, `/authorize`
  // must accept. A client may legitimately ask for the tier — it only ever
  // preselects, since the person's choice on the consent screen is what gets
  // recorded — but a request naming it must not be refused outright.
  const withTierScope = await worker.fetch(
    new Request(authorizeUrl({ scope: "context:read context:write context:private" })),
    env,
    { waitUntil() {} }
  );
  check(
    "an authorization request may name the tier scope discovery advertises",
    withTierScope.status === 302 &&
      (withTierScope.headers.get("Location") || "").startsWith(CONTROL_PLANE_ORIGIN)
  );
  const withUnknownScope = await worker.fetch(
    new Request(authorizeUrl({ scope: "context:read context:everything" })),
    env,
    { waitUntil() {} }
  );
  check(
    "and a scope outside the advertised menu is still invalid_scope",
    (withUnknownScope.headers.get("Location") || "").includes("error=invalid_scope")
  );

  const plainPkce = await worker.fetch(
    new Request(authorizeUrl({ code_challenge_method: "plain", code_challenge: verifier })),
    env,
    { waitUntil() {} }
  );
  check("PKCE plain is rejected", plainPkce.status === 302);
  check(
    "the plain rejection is an OAuth error on the client's redirect",
    (plainPkce.headers.get("Location") || "").includes("error=invalid_request")
  );

  const noPkce = await worker.fetch(
    new Request(
      `https://mcp.context.test/oauth/authorize?response_type=code&client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent("https://client.test/callback")}`
    ),
    env,
    { waitUntil() {} }
  );
  check(
    "an authorization request with no PKCE at all is rejected",
    (noPkce.headers.get("Location") || "").includes("error=invalid_request")
  );

  harness.registered = registered;
  harness.clientId = clientId;
  harness.verifier = verifier;
  harness.challengeValue = challengeValue;
  harness.authorizeUrl = authorizeUrl;
}
