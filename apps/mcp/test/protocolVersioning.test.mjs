import { check, rpc, call, env, accessTokenFor, worker, modernFetch, MODERN } from "./harness.mjs";
import { SUPPORTED_SCOPES } from "../src/session.js";

export async function runProtocolVersioningChecks() {
  // -- protocol revisions: the legacy handshake era and the modern per-request era
  //
  // `2026-07-28` is not an increment on `2025-11-25`; it deletes `initialize`,
  // sessions, the GET stream, resumability and `ping`, and replaces the
  // counter-offer with an error. This gateway is dual-era, so the checks below
  // come in pairs: the modern shape works, and the legacy shape is untouched by
  // it. The second half of each pair is the one that matters — every client in
  // the wild today is legacy.
  // server/discover is the one RPC 2026-07-28 makes unconditionally mandatory.
  // Advertising the revision without it is self-detecting: a conformant client
  // probes with it and correctly concludes the server is legacy.
  const discover = await modernFetch({ method: "server/discover" });
  check("server/discover answers on the modern path", discover.status === 200);
  check(
    "server/discover reports the modern revisions and the tools capability",
    JSON.stringify(discover.body.result?.supportedVersions) === JSON.stringify([MODERN]) &&
      !!discover.body.result?.capabilities.tools
  );
  check(
    "server/discover never offers a handshake revision on the modern path",
    !discover.body.result?.supportedVersions.some((v) => v.startsWith("2025-") || v.startsWith("2024-"))
  );
  check(
    "server/discover carries instructions and the server identity in _meta",
    discover.body.result?.instructions.includes("PARA") &&
      discover.body.result?._meta["io.modelcontextprotocol/serverInfo"].name === "context"
  );
  check("every modern result is tagged complete", discover.body.result?.resultType === "complete");
  // `tools/list` has had this check since the modern path landed; `discover` did
  // not, and it is the one that matters more. Its `instructions` carry a sketch
  // of THIS caller's context — their front page and their filtered folder map —
  // so `public` here would hand one person's notes to whoever a shared
  // intermediary served next. (Not recency: the sketch's own header points at
  // `orient` for that, and no timestamp enters this payload.) Two comments in
  // `index.js` say exactly that and nothing enforced it: marking discover
  // `public` passed the whole suite.
  check(
    "the per-caller context sketch is never marked publicly cacheable",
    discover.body.result?.cacheScope === "private"
  );
  check(
    "and it carries the freshness hints the revision requires at all",
    typeof discover.body.result?.ttlMs === "number"
  );

  const modernList = await modernFetch({ method: "tools/list" });
  check("modern tools/list works", modernList.status === 200 && modernList.body.result?.tools.length === 41);
  check(
    "modern tools/list carries the required freshness hints",
    typeof modernList.body.result?.ttlMs === "number" &&
      modernList.body.result?.resultType === "complete"
  );
  // `public` would let a shared proxy serve one grant's tool list to another —
  // and this list is filtered by the caller's scopes.
  check(
    "a per-grant list is never marked publicly cacheable",
    modernList.body.result?.cacheScope === "private"
  );
  check(
    "modern tools/list is filtered by grant scope exactly as the legacy path is",
    (await modernFetch({ method: "tools/list", token: "readonly-token" })).body.result?.tools.every(
      (tool) => tool.annotations?.readOnlyHint === true
    )
  );

  const modernCall = await modernFetch({
    method: "tools/call",
    params: { name: "read_note", arguments: { path: "index.md" } },
  });
  // `tools/call` returns the note bodies themselves — strictly more sensitive
  // than the tool array or the connect sketch, and the one modern result that
  // carries no cacheability hints at all. That is the right answer, and it was
  // the answer nothing asserted: marking it `public` passed the whole suite.
  // Asserting their ABSENCE rather than their value is the point — a hint here
  // would be wrong however it was spelled — and it is also what makes the call's
  // own success part of the assertion: a call that failed outright satisfies an
  // absence for free, `body.result` being undefined and so being both reads. The
  // next check would catch that loudly, but a check that can only be trusted by
  // reading its neighbour is one somebody will later move.
  //
  // The guard is `result`, not the status. A 200 is not enough on its own — a
  // thrown handler is answered with a JSON-RPC *error* over HTTP 200, as the
  // connect helper in `orientation.test.mjs` says in as many words — so a
  // status-only conjunct would still leave the absence vacuously true on
  // exactly the failure it was added to exclude.
  check(
    "tools/call is not cacheable at all, because it carries the notes",
    modernCall.status === 200 &&
      Boolean(modernCall.body.result) &&
      modernCall.body.result?.cacheScope === undefined &&
      modernCall.body.result?.ttlMs === undefined
  );
  check(
    "modern tools/call reaches the same tool implementation",
    modernCall.status === 200 &&
      modernCall.body.result?.content?.[0]?.text.includes("public manifest") &&
      modernCall.body.result?.resultType === "complete"
  );
  check(
    "the write-scope gate applies on the modern path too",
    (
      await modernFetch({
        method: "tools/call",
        token: "readonly-token",
        params: { name: "write_note", arguments: { path: "1-projects/x.md", content: "no" } },
      })
    ).body.result?.content?.[0]?.text.includes("permission denied")
  );

  // The mirrored headers exist so an intermediary can route without parsing the
  // body. That is only safe if the server that parses the body proves they agree.
  const headerMismatchCases = [
    ["a missing MCP-Protocol-Version header", { method: "tools/list", omitHeaderVersion: true, headerMethod: "tools/list" }],
    ["a body with no declared protocol version", { method: "tools/list", omitBodyVersion: true }],
    ["a header version that disagrees with the body", { method: "tools/list", headerVersion: "2025-11-25" }],
    ["a missing Mcp-Method header", { method: "tools/list", omitHeaderMethod: true }],
    ["an Mcp-Method that disagrees with the body", { method: "tools/list", headerMethod: "tools/call" }],
    [
      "a missing Mcp-Name header on tools/call",
      { method: "tools/call", params: { name: "read_note", arguments: {} }, omitHeaderName: true },
    ],
    [
      "an Mcp-Name that disagrees with the body",
      { method: "tools/call", params: { name: "read_note", arguments: {} }, headerName: "archive_note" },
    ],
  ];
  for (const [label, options] of headerMismatchCases) {
    const res = await modernFetch(options);
    check(
      `${label} is refused with 400 and HeaderMismatch`,
      res.status === 400 && res.body?.error?.code === -32020
    );
  }
  // A method name inherited from Object.prototype must be an ordinary unknown
  // method, not a crash. `NAME_HEADER_SOURCE` is a plain object literal, so a
  // bare lookup resolved `__proto__`, `valueOf` and friends through the
  // prototype: each is truthy, so the mirrored-header check took it for a rule
  // and called it. That threw *outside* the try in `handleModernMcp`, escaped
  // `fetch`, and returned a bodyless 500 in place of the JSON-RPC error the
  // modern contract requires. The legacy path is a `switch` and never was
  // affected — so this is per-era divergence, the shape CLAUDE.md warns about.
  for (const prototypeMethod of [
    "__proto__",
    "valueOf",
    "hasOwnProperty",
    "__defineGetter__",
    "constructor",
    "toString",
  ]) {
    const modernRes = await modernFetch({ method: prototypeMethod });
    check(
      `a prototype-named method (${prototypeMethod}) is method-not-found on the modern path, not a crash`,
      modernRes.status !== 500 && modernRes.body?.error?.code === -32601
    );
    const legacyRes = await rpc("priv-token", prototypeMethod, {});
    check(
      `and the legacy path answers it identically (${prototypeMethod})`,
      legacyRes?.error?.code === -32601
    );
  }

  // A non-ASCII tool name travels base64-wrapped; the server must decode before
  // comparing, or a legal name looks like an attack.
  check(
    "a base64-sentinel Mcp-Name is decoded before it is compared",
    (
      await modernFetch({
        method: "tools/call",
        params: { name: "read_note", arguments: { path: "index.md" } },
        headerName: `=?base64?${btoa("read_note")}?=`,
      })
    ).status === 200
  );
  check(
    "a base64-sentinel Mcp-Name that decodes to the wrong name is still refused",
    (
      await modernFetch({
        method: "tools/call",
        params: { name: "read_note", arguments: { path: "index.md" } },
        headerName: `=?base64?${btoa("archive_note")}?=`,
      })
    ).body?.error?.code === -32020
  );

  // The modern era inverts negotiation: an error carrying `supported`, not a
  // counter-offer in a result. Implementing these two backwards is precisely the
  // bug that has broken real servers.
  const unsupported = await modernFetch({
    method: "tools/list",
    bodyVersion: "2027-01-01",
    headerVersion: "2027-01-01",
  });
  check(
    "an unsupported modern version is a 400 UnsupportedProtocolVersionError",
    unsupported.status === 400 && unsupported.body?.error?.code === -32022
  );
  check(
    "the version error names what was requested and what is supported",
    unsupported.body?.error?.data?.requested === "2027-01-01" &&
      JSON.stringify(unsupported.body?.error?.data?.supported) === JSON.stringify([MODERN])
  );
  check(
    "the modern version error never points a modern client at a handshake revision",
    !unsupported.body?.error?.data?.supported?.some((v) => v < "2026-01-01")
  );

  // Unknown method is 404 on this transport, not 200-with-an-error. The status is
  // what lets a dual-era client tell "no such method" from "not a modern server".
  for (const gone of ["ping", "initialize", "logging/setLevel", "subscriptions/listen"]) {
    const res = await modernFetch({ method: gone });
    check(
      `${gone} is 404 with method-not-found in the modern era`,
      res.status === 404 && res.body?.error?.code === -32601
    );
  }
  check(
    "a modern notification is accepted with 202 and no body",
    (await modernFetch({ method: "notifications/progress", id: null })).status === 202
  );
  check(
    "batching does not exist in the modern era",
    (
      await modernFetch({
        method: "tools/list",
        rawBody: JSON.stringify([
          {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN } },
          },
        ]),
      })
    ).status === 400
  );

  // Sessions and resumability are gone: ignore the headers, never mint or echo.
  const sessionProbe = await worker.fetch(
    new Request("https://x/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessTokenFor("priv-token")}`,
        "MCP-Protocol-Version": MODERN,
        "Mcp-Method": "tools/list",
        "Mcp-Session-Id": "attacker-chosen-session",
        "Last-Event-ID": "17",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/list",
        params: { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN } },
      }),
    }),
    env,
    { waitUntil() {} }
  );
  check(
    "a session id is ignored and never echoed back",
    sessionProbe.status === 200 && !sessionProbe.headers.has("Mcp-Session-Id")
  );
  for (const verb of ["GET", "DELETE"]) {
    check(
      `${verb} on the MCP endpoint is 405`,
      (await modernFetch({ method: "tools/list", httpMethod: verb })).status === 405
    );
  }

  // --- and now the half that must not have moved: legacy clients ---
  check(
    "a legacy client sending no version header still works",
    (await rpc("priv-token", "tools/list"))?.result?.tools.length === 41
  );
  async function legacyWithVersionHeader(version) {
    return worker.fetch(
      new Request("https://x/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessTokenFor("priv-token")}`,
          "MCP-Protocol-Version": version,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/list", params: {} }),
      }),
      env,
      { waitUntil() {} }
    );
  }
  for (const version of ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]) {
    check(
      `a legacy client echoing ${version} is served`,
      (await legacyWithVersionHeader(version)).status === 200
    );
  }
  // At least one shipping client sends its own latest revision here instead of
  // the negotiated one. Refusing that would break a session that negotiated fine.
  check(
    "a legacy request whose version header names the modern revision is not silently mis-served",
    (await legacyWithVersionHeader("2026-07-28")).status === 400
  );
  check(
    "a version header naming a revision this server has never implemented is refused",
    (await legacyWithVersionHeader("1999-01-01")).status === 400
  );

  // The era inversion again, one layer down: same status code, opposite body
  // obligation. Half of this is quoted and half is inferred, and the halves are
  // labelled separately on purpose — nobody should later go hunting for a clause
  // that does not exist.
  //
  // QUOTED. On the modern path the body is mandated: an unsupported version
  // "MUST respond with `400 Bad Request` and an `UnsupportedProtocolVersionError`
  // listing its supported versions", and a client is told that a recognized
  // modern error in the body means "retry ... rather than falling back". So a
  // bare `400` there is not a lesser failure, it is a wrong one — it routes the
  // client into the era it just declined to use.
  //
  // INFERRED, and ours. The legacy rule says only "it MUST respond with `400 Bad
  // Request`". No body is required and none is forbidden. That the legacy 400
  // must *not* look like a modern error is this gateway's own hardening, argued
  // rather than cited: both eras share one endpoint, so dressing a legacy-shaped
  // refusal in a modern error body would hand a probing dual-era client the wrong
  // era determination. Asserted rather than assumed, because an invariant with no
  // clause behind it is exactly the kind that gets tidied away.
  function isRecognizableModernError(res, code) {
    return (
      res.status === 400 &&
      res.body?.jsonrpc === "2.0" &&
      res.body?.error?.code === code &&
      typeof res.body?.error?.message === "string"
    );
  }
  check(
    "a modern version refusal is a recognizable modern error, never a bare 400",
    isRecognizableModernError(unsupported, -32022)
  );
  check(
    "a modern header refusal is a recognizable modern error, never a bare 400",
    isRecognizableModernError(
      await modernFetch({ method: "tools/list", omitHeaderMethod: true }),
      -32020
    )
  );
  check(
    "a legacy refusal is deliberately not a modern error body, so fallback still works",
    await (async () => {
      const res = await legacyWithVersionHeader("1999-01-01");
      const body = await res.json().catch(() => null);
      return res.status === 400 && body?.error?.code !== -32022 && body?.error?.code !== -32020;
    })()
  );

  check(
    "a legacy batch is still served for the revisions that defined batching",
    await (async () => {
      const res = await worker.fetch(
        new Request("https://x/mcp", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessTokenFor("priv-token")}`,
          },
          body: JSON.stringify([
            { jsonrpc: "2.0", id: 21, method: "ping", params: {} },
            { jsonrpc: "2.0", id: 22, method: "ping", params: {} },
          ]),
        }),
        env,
        { waitUntil() {} }
      );
      return (await res.json()).length === 2;
    })()
  );

  // Incremental scope consent: name the scope that was missing, not the menu.
  const scopeRefusal = await worker.fetch(
    new Request("https://x/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessTokenFor("inbox-token")}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 31, method: "ping", params: {} }),
    }),
    env,
    { waitUntil() {} }
  );
  check(
    "a scope refusal challenges for the one scope it needed",
    scopeRefusal.status === 403 &&
      /scope="context:read"/.test(scopeRefusal.headers.get("WWW-Authenticate"))
  );
  check(
    "a 401 with no grant at all still advertises the full scope menu",
    // Derived from the module rather than restated, so adding a scope and
    // forgetting the challenge header cannot pass here.
    new RegExp(`scope="${SUPPORTED_SCOPES.join(" ")}"`).test(
      (
        await worker.fetch(new Request("https://x/mcp", { method: "POST", body: "{}" }), env, {
          waitUntil() {},
        })
      ).headers.get("WWW-Authenticate")
    )
  );


}
