/**
 * Storage adapter checks: SigV4 signing, ListObjectsV2 parsing, rootPrefix
 * isolation, and the conditional-write capability probe.
 *
 * Offline and dependency-free — every backend is a fetch stub or an in-memory
 * map. Run as part of `node test/test.mjs`.
 */

import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { R2Store } from "../src/store/r2.js";
import { S3Store, parseListObjectsV2, deriveSigningKey } from "../src/store/s3.js";
import { DropboxStore } from "../src/store/dropbox.js";
import { probeStore, normalizeEtag, PROBE_PREFIX } from "../src/store/index.js";

const FAKE_CONFIG = {
  endpoint: "https://s3.example-object-storage.test",
  region: "us-east-1",
  bucket: "example-bucket",
  // Obviously fake credentials. This repo is public; never use a real one.
  accessKeyId: "AKIAEXAMPLEEXAMPLE00",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  now: () => new Date("2026-08-25T12:00:00.000Z"),
};

/** A fetch stand-in that records what was sent and replays scripted responses. */
function fetchStub(handler) {
  const calls = [];
  const impl = async (url, options = {}) => {
    const call = {
      url: new URL(url),
      method: options.method,
      headers: options.headers || {},
      body: options.body,
    };
    calls.push(call);
    return (await handler(call, calls.length - 1)) || new Response("", { status: 200 });
  };
  impl.calls = calls;
  return impl;
}

function s3(handler, overrides = {}) {
  return new S3Store({ ...FAKE_CONFIG, ...overrides, fetchImpl: fetchStub(handler) });
}

function listXml({ contents = [], prefixes = [], truncated = false, next = null } = {}) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
    `<Name>example-bucket</Name><IsTruncated>${truncated}</IsTruncated>` +
    (next ? `<NextContinuationToken>${next}</NextContinuationToken>` : "") +
    contents
      .map(
        (item) =>
          `<Contents><Key>${item.key}</Key><LastModified>2026-08-01T10:00:00.000Z</LastModified>` +
          `<ETag>&quot;${item.etag || "abc"}&quot;</ETag><Size>${item.size ?? 10}</Size></Contents>`
      )
      .join("") +
    prefixes.map((prefix) => `<CommonPrefixes><Prefix>${prefix}</Prefix></CommonPrefixes>`).join("") +
    `</ListBucketResult>`
  );
}

/**
 * In-memory bucket with the same semantics as the R2 binding.
 *
 * The flags model the three ways a backend can look conflict-safe and not be:
 * - `ignoreIfMatch` — accepts the header and writes anyway (B2, Wasabi).
 * - `rejectAllIfMatch` — 412s every precondition, correct or not.
 * - `shapeOnlyIfMatch` — 412s an etag that does not *look* like one of its own,
 *   then ignores a well-formed but stale one. Last-writer-wins on real
 *   conflicts, while passing a probe that only tries an impossible etag.
 */
function memoryBucket({
  ignoreIfMatch = false,
  rejectAllIfMatch = false,
  shapeOnlyIfMatch = false,
} = {}) {
  const objects = new Map();
  let counter = 0;
  return {
    objects,
    async get(key) {
      if (!objects.has(key)) return null;
      const { body, etag } = objects.get(key);
      return {
        etag,
        text: async () => body,
        arrayBuffer: async () => new TextEncoder().encode(body).buffer,
      };
    },
    async put(key, value, options = {}) {
      const expected = options?.onlyIf?.etagMatches;
      if (expected && rejectAllIfMatch) return null;
      // Etags this bucket issues look like "m3"; anything else is malformed.
      if (expected && shapeOnlyIfMatch && !/^m\d+$/.test(expected)) return null;
      // A backend that "supports" If-Match by ignoring it — B2 and Wasabi.
      if (expected && !ignoreIfMatch && !shapeOnlyIfMatch && objects.get(key)?.etag !== expected) {
        return null;
      }
      const body = typeof value === "string" ? value : new TextDecoder().decode(value);
      const etag = `m${++counter}`;
      objects.set(key, { body, etag });
      return { etag };
    },
    async delete(key) {
      objects.delete(key);
    },
    async list({ prefix, delimiter } = {}) {
      const keys = [...objects.keys()].filter((key) => !prefix || key.startsWith(prefix)).sort();
      if (!delimiter) {
        return {
          objects: keys.map((key) => ({ key, size: objects.get(key).body.length, uploaded: new Date() })),
          truncated: false,
        };
      }
      const listed = [];
      const delimitedPrefixes = new Set();
      for (const key of keys) {
        const rest = key.slice((prefix || "").length);
        const slash = rest.indexOf(delimiter);
        if (slash === -1) listed.push({ key, size: objects.get(key).body.length, uploaded: new Date() });
        else delimitedPrefixes.add(`${prefix || ""}${rest.slice(0, slash + 1)}`);
      }
      return { objects: listed, delimitedPrefixes: [...delimitedPrefixes], truncated: false };
    },
  };
}

/**
 * @param {(label: string, ok: boolean) => void} check
 * @param {{ env: object, ownerToken: string }} gateway a live control-plane-backed
 *   environment from the main suite, so the worker checks below authenticate the
 *   same way every other request does — there is no other way in.
 */
export async function runStoreChecks(check, gateway) {
  /* ------------------------- SigV4 request signing ------------------------- */

  // Known-answer test from the AWS SigV4 documentation: this exact secret,
  // date, region, and service must derive this signing key. It pins the whole
  // HMAC chain, which is the part of SigV4 that fails silently.
  const kat = await deriveSigningKey(
    "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    "20120215",
    "us-east-1",
    "iam"
  );
  const katHex = [...kat].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  check(
    "SigV4 signing key matches the published AWS derivation vector",
    katHex === "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d"
  );

  const signingStore = s3(() => new Response("note body", { headers: { etag: '"v1"' } }));
  await signingStore.get("1-projects/foo.md");
  const signed = signingStore.fetchImpl.calls[0];
  const authorization = signed.headers.Authorization || "";
  check(
    "S3 requests carry a well-formed SigV4 Authorization header",
    /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLEEXAMPLE00\/20260825\/us-east-1\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/.test(
      authorization
    )
  );
  check(
    "signed headers cover host, payload hash, and request date",
    /SignedHeaders=host;x-amz-content-sha256;x-amz-date/.test(authorization) &&
      signed.headers["x-amz-date"] === "20260825T120000Z" &&
      // SHA-256 of the empty body
      signed.headers["x-amz-content-sha256"] ===
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  );
  check(
    "the same request signs identically twice (no nondeterminism)",
    await (async () => {
      const again = s3(() => new Response("note body", { headers: { etag: '"v1"' } }));
      await again.get("1-projects/foo.md");
      return again.fetchImpl.calls[0].headers.Authorization === authorization;
    })()
  );

  const spacedStore = s3(() => new Response("x", { headers: { etag: '"v1"' } }));
  await spacedStore.get("1-projects/a note (draft).md");
  check(
    "object keys are RFC 3986 encoded without escaping path separators",
    spacedStore.fetchImpl.calls[0].url.pathname ===
      "/example-bucket/1-projects/a%20note%20%28draft%29.md"
  );

  /* --------------------------------- get ---------------------------------- */

  const quotedEtagStore = s3(() => new Response("hello", { headers: { etag: '"abc123"' } }));
  const fetched = await quotedEtagStore.get("index.md");
  check(
    "S3 etags are normalized so they compare consistently with R2",
    fetched.etag === "abc123" && (await fetched.text()) === "hello"
  );
  check(
    "a stored object exposes both text and bytes from one fetch",
    new TextDecoder().decode(await fetched.arrayBuffer()) === "hello"
  );
  check("etag normalization strips weak validators too", normalizeEtag('W/"abc123"') === "abc123");
  const missingStore = s3(() => new Response("", { status: 404 }));
  check("a missing object reads as null, not an error", (await missingStore.get("nope.md")) === null);
  let getFailure = null;
  const brokenStore = s3(
    () => new Response("<Error><Code>InternalError</Code><Message>boom</Message></Error>", { status: 500 })
  );
  try {
    await brokenStore.get("index.md");
  } catch (error) {
    getFailure = error;
  }
  check(
    "a backend failure throws without leaking credentials or the signed URL",
    getFailure instanceof Error &&
      getFailure.message.includes("500") &&
      !getFailure.message.includes(FAKE_CONFIG.secretAccessKey) &&
      !getFailure.message.includes("Signature=")
  );

  /* --------------------------- conditional writes -------------------------- */

  const conflictStore = s3((call) =>
    call.headers["if-match"] === '"stale-etag"'
      ? new Response("", { status: 412 })
      : new Response("", { headers: { etag: '"v2"' } })
  );
  const conflicted = await conflictStore.put("index.md", "v2", {
    onlyIf: { etagMatches: "stale-etag" },
  });
  check(
    "a failed If-Match precondition returns null rather than throwing",
    conflicted === null &&
      conflictStore.fetchImpl.calls[0].headers["if-match"] === '"stale-etag"' &&
      /SignedHeaders=[a-z0-9;-]*if-match/.test(conflictStore.fetchImpl.calls[0].headers.Authorization)
  );
  const acceptedWrite = await conflictStore.put("index.md", "v2", {
    onlyIf: { etagMatches: "fresh-etag" },
  });
  check("a satisfied precondition returns the new etag", acceptedWrite?.etag === "v2");
  const vanishedStore = s3(() => new Response("", { status: 404 }));
  check(
    "a conditional write against a vanished object is a precondition failure, not a crash",
    (await vanishedStore.put("index.md", "v2", { onlyIf: { etagMatches: "any" } })) === null
  );
  const bodyStore = s3(() => new Response("", { headers: { etag: '"v3"' } }));
  await bodyStore.put("index.md", "written body");
  check(
    "an unconditional write sends no If-Match and hashes its body",
    bodyStore.fetchImpl.calls[0].headers["if-match"] === undefined &&
      bodyStore.fetchImpl.calls[0].headers["x-amz-content-sha256"] !==
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  );

  /* ---------------------------------- list --------------------------------- */

  const pagedStore = s3((call, index) =>
    index === 0
      ? new Response(
          listXml({
            contents: [{ key: "1-projects/a.md", size: 3 }],
            truncated: true,
            next: "token-page-2",
          })
        )
      : new Response(listXml({ contents: [{ key: "1-projects/b.md", size: 4 }] }))
  );
  const page1 = await pagedStore.list({ prefix: "1-projects/", limit: 1 });
  const page2 = await pagedStore.list({ prefix: "1-projects/", cursor: page1.cursor });
  check(
    "list reports truncation and a continuation cursor",
    page1.truncated === true &&
      page1.cursor === "token-page-2" &&
      page1.objects[0].key === "1-projects/a.md" &&
      page1.objects[0].size === 3
  );
  check(
    "a cursor is replayed as the ListObjectsV2 continuation token",
    pagedStore.fetchImpl.calls[1].url.searchParams.get("continuation-token") === "token-page-2" &&
      pagedStore.fetchImpl.calls[0].url.searchParams.get("list-type") === "2" &&
      pagedStore.fetchImpl.calls[0].url.searchParams.get("max-keys") === "1" &&
      page2.truncated === false &&
      page2.cursor === undefined
  );

  const delimitedStore = s3(
    () =>
      new Response(
        listXml({ contents: [{ key: "root.md" }], prefixes: ["1-projects/", "2-areas/"] })
      )
  );
  const delimited = await delimitedStore.list({ delimiter: "/" });
  check(
    "CommonPrefixes become delimitedPrefixes and the delimiter is sent",
    JSON.stringify(delimited.delimitedPrefixes) === JSON.stringify(["1-projects/", "2-areas/"]) &&
      delimitedStore.fetchImpl.calls[0].url.searchParams.get("delimiter") === "/"
  );
  // A space must travel as %20. URLSearchParams would write "+", which S3
  // reads as a literal plus — wrong prefix and a broken signature.
  const spacedPrefixStore = s3(() => new Response(listXml({})));
  await spacedPrefixStore.list({ prefix: "1-projects/my project/" });
  check(
    "query values are RFC 3986 encoded, so a folder with a space still matches",
    spacedPrefixStore.fetchImpl.calls[0].url.search.includes(
      "prefix=1-projects%2Fmy%20project%2F"
    )
  );

  const entityParsed = parseListObjectsV2(
    listXml({ contents: [{ key: "1-projects/tom &amp; jerry.md", etag: "e1" }] })
  );
  check(
    "listed keys and etags are XML-decoded and unquoted",
    entityParsed.objects[0].key === "1-projects/tom & jerry.md" &&
      entityParsed.objects[0].etag === "e1"
  );

  /* ----------------------------- rootPrefix ------------------------------- */

  const prefixedStore = s3(
    (call) =>
      call.method === "GET" && call.url.searchParams.has("list-type")
        ? new Response(
            listXml({
              contents: [{ key: "team-notes/1-projects/a.md" }],
              prefixes: ["team-notes/1-projects/sub/"],
            })
          )
        : new Response("body", { headers: { etag: '"v1"' } }),
    { rootPrefix: "team-notes" }
  );
  await prefixedStore.get("1-projects/a.md");
  const prefixedList = await prefixedStore.list({ prefix: "1-projects/", delimiter: "/" });
  check(
    "rootPrefix is applied inside the adapter, never by the caller",
    prefixedStore.fetchImpl.calls[0].url.pathname ===
      "/example-bucket/team-notes/1-projects/a.md" &&
      prefixedStore.fetchImpl.calls[1].url.searchParams.get("prefix") === "team-notes/1-projects/"
  );
  // The rootPrefix belongs in the query, never in the path. Appending it made
  // the request a GetObject on the directory-marker key "team-notes/": S3
  // answers 200 with an empty body if that marker exists (Remotely Save and
  // most S3 GUIs create them), so every listing silently reported an empty
  // context — and 404 if it does not.
  check(
    "a ListObjectsV2 addresses the bucket root even when a rootPrefix is set",
    prefixedStore.fetchImpl.calls[1].url.pathname === "/example-bucket" &&
      prefixedStore.fetchImpl.calls[1].url.searchParams.get("list-type") === "2" &&
      prefixedList.objects.length === 1
  );
  check(
    "an unprefixed list also addresses the bucket root",
    delimitedStore.fetchImpl.calls[0].url.pathname === "/example-bucket" &&
      pagedStore.fetchImpl.calls[0].url.pathname === "/example-bucket"
  );
  const hostedListStore = s3(() => new Response(listXml({})), {
    endpoint: "https://example-bucket.s3.example-object-storage.test",
    forcePathStyle: false,
    rootPrefix: "team-notes",
  });
  await hostedListStore.list({ prefix: "1-projects/" });
  check(
    "a virtual-hosted list targets the host root, not a rootPrefix path",
    hostedListStore.fetchImpl.calls[0].url.pathname === "/" &&
      hostedListStore.fetchImpl.calls[0].url.searchParams.get("prefix") === "team-notes/1-projects/"
  );
  check(
    "keys above the adapter never see the rootPrefix",
    prefixedList.objects[0].key === "1-projects/a.md" &&
      prefixedList.delimitedPrefixes[0] === "1-projects/sub/"
  );

  const prefixedBucket = memoryBucket();
  const prefixedR2 = new R2Store(prefixedBucket, { rootPrefix: "context/" });
  await prefixedR2.put("1-projects/foo.md", "note");
  const prefixedRead = await prefixedR2.get("1-projects/foo.md");
  const prefixedR2List = await prefixedR2.list({ prefix: "1-projects/" });
  await prefixedR2.delete("1-projects/foo.md");
  check(
    "R2Store applies rootPrefix on write, read, list, and delete alike",
    prefixedBucket.objects.size === 0 &&
      (await prefixedRead.text()) === "note" &&
      prefixedR2List.objects[0].key === "1-projects/foo.md"
  );

  const plainBucket = memoryBucket();
  const plainR2 = new R2Store(plainBucket);
  await plainR2.put("1-projects/foo.md", "note");
  check(
    "without a rootPrefix an R2 key is stored exactly as the caller wrote it",
    plainBucket.objects.has("1-projects/foo.md")
  );

  // The cursor is the one documented exception to "nothing above the adapter
  // sees the rootPrefix" — an S3 continuation token is base64 of the last
  // backend key. It is passed through verbatim and must stay inside the
  // adapter's pagination loop; this pins the behavior the comment describes.
  const cursorStore = s3(
    () => new Response(listXml({ truncated: true, next: "dGVhbS1ub3Rlcy8x" })),
    { rootPrefix: "team-notes" }
  );
  const cursorPage = await cursorStore.list({ prefix: "1-projects/" });
  check(
    "a continuation cursor is passed through verbatim, prefix and all",
    cursorPage.cursor === "dGVhbS1ub3Rlcy8x"
  );

  /* -------------------------- path traversal ------------------------------ */

  // ".." and "." are RFC 3986 unreserved, so they survive encodeRfc3986 — and
  // then the WHATWG URL parser removes dot segments when url.pathname is
  // assigned. The signature is computed after that rewrite, so an escaped
  // request is valid and correctly signed. Reject at the boundary instead.
  const TRAVERSAL_KEYS = [
    "../escape.md",
    "a/../../b.md",
    "x/../../../y.md",
    "1-projects/./a.md",
    ".././escape.md",
    "%2e%2e/escape.md",
    "a/%2E%2E/b.md",
    "%2e/a.md",
    "1-projects//a.md",
    "/1-projects/a.md",
    "1-projects/a\\..\\b.md",
    "1-projects/a .md",
    "1-projects/a\r\nb.md",
    "",
  ];

  const traversalStore = s3(() => new Response("nope"), { rootPrefix: "team-notes" });
  const traversalBucket = memoryBucket();
  const traversalR2 = new R2Store(traversalBucket, { rootPrefix: "team-notes" });
  const rejections = [];
  for (const key of TRAVERSAL_KEYS) {
    for (const [name, run] of [
      ["S3Store.get", () => traversalStore.get(key)],
      ["S3Store.put", () => traversalStore.put(key, "x")],
      ["S3Store.delete", () => traversalStore.delete(key)],
      ["R2Store.get", () => traversalR2.get(key)],
      ["R2Store.put", () => traversalR2.put(key, "x")],
      ["R2Store.delete", () => traversalR2.delete(key)],
    ]) {
      let threw = null;
      try {
        await run();
      } catch (error) {
        threw = error;
      }
      if (!threw) rejections.push(`${name} accepted ${JSON.stringify(key)}`);
      else if (!/unsafe storage key/.test(threw.message)) {
        rejections.push(`${name} threw the wrong error for ${JSON.stringify(key)}`);
      }
    }
  }
  check(
    "dot, dot-dot, empty, encoded, control-character and backslash keys are rejected by both adapters",
    rejections.length === 0
  );
  check(
    "a rejected key never reaches the backend",
    traversalStore.fetchImpl.calls.length === 0 && traversalBucket.objects.size === 0
  );

  let traversalError = null;
  try {
    await traversalStore.get("../escape.md");
  } catch (error) {
    traversalError = error;
  }
  check(
    "the rejection is explicit and does not echo the key into logs",
    traversalError instanceof Error &&
      traversalError.message.includes('".." path segment') &&
      !traversalError.message.includes("escape.md")
  );

  const traversalPrefixStore = s3(() => new Response(listXml({})), { rootPrefix: "team-notes" });
  let prefixError = null;
  try {
    await traversalPrefixStore.list({ prefix: "../" });
  } catch (error) {
    prefixError = error;
  }
  check(
    "a list prefix gets the same treatment as a key",
    prefixError instanceof Error &&
      /unsafe storage prefix/.test(prefixError.message) &&
      traversalPrefixStore.fetchImpl.calls.length === 0
  );

  const badRootPrefixes = ["..", "../other-tenant", "team/../../elsewhere", "team/./notes"];
  const rootPrefixAccepted = badRootPrefixes.filter((rootPrefix) => {
    const attempts = [
      () => new S3Store({ ...FAKE_CONFIG, rootPrefix }),
      () => new R2Store(memoryBucket(), { rootPrefix }),
    ];
    return attempts.some((attempt) => {
      try {
        attempt();
        return true;
      } catch (error) {
        return !/unsafe storage prefix/.test(error.message);
      }
    });
  });
  check(
    "a rootPrefix that would escape the bucket is refused at construction",
    rootPrefixAccepted.length === 0
  );

  const legitimateStore = s3(() => new Response("ok", { headers: { etag: '"v1"' } }));
  await legitimateStore.get(".history/1-projects/a.2026-08-25.md");
  await legitimateStore.list({ prefix: ".proposals/pending/" });
  await legitimateStore.list({});
  check(
    "dot-prefixed plumbing keys and trailing-slash prefixes still work",
    legitimateStore.fetchImpl.calls[0].url.pathname ===
      "/example-bucket/.history/1-projects/a.2026-08-25.md" &&
      legitimateStore.fetchImpl.calls[1].url.searchParams.get("prefix") === ".proposals/pending/" &&
      legitimateStore.fetchImpl.calls[2].url.searchParams.has("prefix") === false
  );

  /* ---------------------------- addressing style --------------------------- */

  // "the host does not start with the bucket name" is satisfiable by
  // coincidence. Every one of these is a path-style endpoint whose first host
  // label equals the bucket, and the old heuristic dropped the bucket segment —
  // so the provider read "1-projects" as the bucket name.
  const COINCIDENTAL = [
    ["https://s3.wasabisys.com", "s3"],
    ["https://data.example.com", "data"],
    ["https://acct.r2.cloudflarestorage.com", "acct"],
  ];
  const ambiguous = COINCIDENTAL.map(([endpoint, bucket]) => {
    try {
      new S3Store({ ...FAKE_CONFIG, endpoint, bucket });
      return `${bucket}@${endpoint} was accepted`;
    } catch (error) {
      return /forcePathStyle explicitly/.test(error.message) ? null : `${bucket}: ${error.message}`;
    }
  }).filter(Boolean);
  check(
    "an endpoint whose first host label is the bucket name fails loudly instead of guessing",
    ambiguous.length === 0
  );

  const wasabiStyle = s3(() => new Response("x", { headers: { etag: '"v1"' } }), {
    endpoint: "https://s3.wasabisys.com",
    bucket: "s3",
    forcePathStyle: true,
  });
  await wasabiStyle.get("1-projects/a.md");
  check(
    "an explicit path-style endpoint keeps its bucket segment",
    wasabiStyle.fetchImpl.calls[0].url.pathname === "/s3/1-projects/a.md"
  );

  const impliedPathStyle = s3(() => new Response("x", { headers: { etag: '"v1"' } }), {
    endpoint: "https://storage.example-object-storage.test",
    bucket: "1-projects",
  });
  await impliedPathStyle.get("1-projects/a.md");
  check(
    "path style is the default, so the bucket segment is never dropped by accident",
    impliedPathStyle.forcePathStyle === true &&
      impliedPathStyle.fetchImpl.calls[0].url.pathname === "/1-projects/1-projects/a.md"
  );

  const virtualHosted = s3(() => new Response("x", { headers: { etag: '"v1"' } }), {
    endpoint: "https://example-bucket.s3.example-object-storage.test",
    forcePathStyle: false,
  });
  await virtualHosted.get("1-projects/a.md");
  check(
    "virtual-hosted addressing is available, but only when asked for explicitly",
    virtualHosted.fetchImpl.calls[0].url.pathname === "/1-projects/a.md"
  );

  /* ------------------------------ If-Match shape --------------------------- */

  const injectionStore = s3(() => new Response("", { headers: { etag: '"v9"' } }));
  const badEtags = [
    'v1"\r\nx-amz-acl: public-read',
    'v1"',
    "v1\nv2",
    "v1\u00e9",
    "e".repeat(300),
    "",
    undefined,
  ];
  const etagRejections = [];
  for (const etag of badEtags) {
    try {
      await injectionStore.put("index.md", "body", { onlyIf: { etagMatches: etag } });
      etagRejections.push(etag);
    } catch (error) {
      if (!/unsafe etag/.test(error.message)) etagRejections.push(etag);
    }
  }
  check(
    "an etag with quotes, control characters, or CRLF never reaches the If-Match header",
    etagRejections.length === 0 && injectionStore.fetchImpl.calls.length === 0
  );
  const okEtagStore = s3(() => new Response("", { headers: { etag: '"v9"' } }));
  await okEtagStore.put("index.md", "body", { onlyIf: { etagMatches: 'W/"33a64df5"' } });
  check(
    "a normal etag still travels as a quoted If-Match",
    okEtagStore.fetchImpl.calls[0].headers["if-match"] === '"33a64df5"'
  );

  /* --------------------------- hostile XML and size ------------------------ */

  // String.fromCodePoint throws a RangeError above U+10FFFF, and a long enough
  // digit run parses to Infinity. One hostile <Key> must not 500 a listing.
  const hostileEntities = parseListObjectsV2(
    listXml({
      contents: [
        { key: "&#1114112;.md" },
        { key: "&#x110000;.md" },
        { key: `&#${"9".repeat(400)};.md` },
        { key: "&#65;-ok.md" },
      ],
    })
  );
  check(
    "out-of-range numeric XML entities decode to a replacement character, not a RangeError",
    hostileEntities.objects.length === 4 &&
      hostileEntities.objects[0].key === "�.md" &&
      hostileEntities.objects[1].key === "�.md" &&
      hostileEntities.objects[2].key === "�.md" &&
      hostileEntities.objects[3].key === "A-ok.md"
  );

  const declaredHugeStore = s3(
    () => new Response(listXml({}), { headers: { "content-length": "900000000" } })
  );
  let declaredHugeError = null;
  try {
    await declaredHugeStore.list({});
  } catch (error) {
    declaredHugeError = error;
  }
  check(
    "a list response that declares a huge Content-Length is refused before reading",
    declaredHugeError instanceof Error && /exceeds \d+ bytes/.test(declaredHugeError.message)
  );

  // No Content-Length: the body has to be capped while it streams.
  const megabyte = new Uint8Array(1_000_000);
  megabyte.fill(0x20);
  const streamingHugeStore = s3(
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(megabyte);
          },
        })
      )
  );
  let streamingHugeError = null;
  try {
    await streamingHugeStore.list({});
  } catch (error) {
    streamingHugeError = error;
  }
  check(
    "an endless list body is cut off at the cap instead of filling worker memory",
    streamingHugeError instanceof Error && /exceeds \d+ bytes/.test(streamingHugeError.message)
  );

  /* --------------------------- capability probe ---------------------------- */

  const honestBucket = memoryBucket();
  const honestProbe = await probeStore(new R2Store(honestBucket));
  check(
    "probe confirms a store that really enforces If-Match",
    honestProbe.ok === true &&
      honestProbe.reachable === true &&
      honestProbe.writable === true &&
      honestProbe.capabilities.conditionalWrite === true &&
      honestProbe.conditionalWrite.verified === true &&
      honestProbe.conditionalWrite.mismatch === false
  );
  check(
    "probe proves all three halves: wrong rejected, correct accepted, stale rejected",
    honestProbe.conditionalWrite.rejectsWrong === true &&
      honestProbe.conditionalWrite.acceptsCorrect === true &&
      honestProbe.conditionalWrite.rejectsStale === true
  );
  check(
    "probe leaves nothing behind in the bucket",
    honestProbe.cleanedUp === true &&
      ![...honestBucket.objects.keys()].some((key) => key.startsWith(PROBE_PREFIX))
  );

  // Rejecting the impossible probe etag is not evidence of conflict detection.
  // This backend 412s anything that does not look like one of its own etags and
  // then ignores a well-formed stale one — last-writer-wins on privacy.md, so
  // one of two concurrent set_visibility calls is lost and a note meant to be
  // private stays team-readable.
  const shapeOnlyBucket = memoryBucket({ shapeOnlyIfMatch: true });
  const shapeOnlyProbe = await probeStore(new R2Store(shapeOnlyBucket));
  check(
    "probe catches a backend that validates etag shape instead of the object",
    shapeOnlyProbe.ok === false &&
      shapeOnlyProbe.conditionalWrite.rejectsWrong === true &&
      shapeOnlyProbe.conditionalWrite.acceptsCorrect === true &&
      shapeOnlyProbe.conditionalWrite.rejectsStale === false &&
      shapeOnlyProbe.conditionalWrite.verified === false &&
      shapeOnlyProbe.conditionalWrite.mismatch === true &&
      shapeOnlyProbe.conditionalWrite.detail.includes("stale") &&
      shapeOnlyProbe.cleanedUp === true &&
      ![...shapeOnlyBucket.objects.keys()].some((key) => key.startsWith(PROBE_PREFIX))
  );

  // The opposite failure: every If-Match is refused. The old probe called this
  // healthy; in production every visibility change burns its retries and throws
  // "privacy manifest changed concurrently".
  const alwaysRefusesBucket = memoryBucket({ rejectAllIfMatch: true });
  const alwaysRefusesProbe = await probeStore(new R2Store(alwaysRefusesBucket));
  check(
    "probe catches a backend that refuses every If-Match, correct ones included",
    alwaysRefusesProbe.ok === false &&
      alwaysRefusesProbe.conditionalWrite.rejectsWrong === true &&
      alwaysRefusesProbe.conditionalWrite.acceptsCorrect === false &&
      alwaysRefusesProbe.conditionalWrite.verified === false &&
      alwaysRefusesProbe.conditionalWrite.detail.includes("rejected a correct If-Match") &&
      alwaysRefusesProbe.errors.some((error) => error.includes("rejects a correct precondition")) &&
      alwaysRefusesProbe.cleanedUp === true
  );

  const ignoringBucket = memoryBucket({ ignoreIfMatch: true });
  const ignoringStore = new R2Store(ignoringBucket);
  const ignoringProbe = await probeStore(ignoringStore);
  check(
    "probe catches a backend that accepts If-Match and ignores it",
    ignoringProbe.ok === false &&
      ignoringProbe.reachable === true &&
      ignoringProbe.writable === true &&
      ignoringProbe.capabilities.conditionalWrite === false &&
      ignoringProbe.conditionalWrite.declared === true &&
      ignoringProbe.conditionalWrite.verified === false &&
      ignoringProbe.conditionalWrite.mismatch === true
  );
  check(
    "an unsupported capability is reported, not thrown, and still cleans up",
    ignoringProbe.errors.some((error) => error.includes("not enforced")) &&
      ignoringProbe.cleanedUp === true &&
      ![...ignoringBucket.objects.keys()].some((key) => key.startsWith(PROBE_PREFIX))
  );

  const honestlyDegraded = new R2Store(memoryBucket({ ignoreIfMatch: true }));
  honestlyDegraded.capabilities = { conditionalWrite: false };
  const degradedProbe = await probeStore(honestlyDegraded);
  check(
    "a store that admits it has no conditional writes probes as honest, not broken",
    degradedProbe.ok === true &&
      degradedProbe.capabilities.conditionalWrite === false &&
      degradedProbe.conditionalWrite.mismatch === false
  );

  const unreachableProbe = await probeStore({
    capabilities: { conditionalWrite: true },
    get: async () => null,
    put: async () => ({ etag: "x" }),
    delete: async () => {},
    list: async () => {
      throw new Error("connection refused");
    },
  });
  check(
    "an unreachable store fails the probe without throwing",
    unreachableProbe.ok === false &&
      unreachableProbe.reachable === false &&
      unreachableProbe.errors.some((error) => error.includes("connection refused"))
  );

  const notAStore = await probeStore({});
  check("probing a non-store reports the problem instead of crashing", notAStore.ok === false);

  // A Wasabi/B2-shaped S3 endpoint: 200 OK on a write it was told to refuse.
  const wasabiLike = s3((call) => {
    if (call.method === "GET" && call.url.searchParams.has("list-type")) {
      return new Response(listXml({}));
    }
    if (call.method === "GET") return new Response("stale", { headers: { etag: '"w2"' } });
    if (call.method === "PUT") return new Response("", { headers: { etag: '"w2"' } });
    return new Response(null, { status: 204 });
  });
  const wasabiProbe = await probeStore(wasabiLike);
  check(
    "an S3 endpoint that ignores If-Match is caught before it can corrupt notes",
    wasabiProbe.ok === false &&
      wasabiProbe.conditionalWrite.declared === true &&
      wasabiProbe.conditionalWrite.verified === false &&
      wasabiProbe.conditionalWrite.detail.includes("ignored")
  );
  check(
    "the probe deletes its temp object even on a failing backend",
    wasabiProbe.cleanedUp === true &&
      wasabiLike.fetchImpl.calls.some((call) => call.method === "DELETE")
  );

  /* --------------------------- pagination guard ---------------------------- */

  // The listing loops in src/index.js are driven by a customer-configured
  // endpoint. A backend that always answers "truncated" — or replays one
  // continuation token — used to spin until the Workers subrequest limit killed
  // the request with an opaque error. Both shapes must stop and say why.
  // The hostile bucket is reached the only way any bucket is reached: through a
  // live grant on the harness's control plane. It is bound natively so the
  // pagination guard is tested without a second S3 backend in the way.
  const hostileEnv = (list) => ({
    ...gateway.env,
    CONTEXT_BUCKET: {
      async get() {
        return null;
      },
      async put() {
        return { etag: "x" };
      },
      async delete() {},
      list,
    },
  });
  const hostileCall = async (list, args, tool = "search_notes") => {
    const response = await worker.fetch(
      new Request("https://x/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${gateway.ownerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: tool, arguments: args },
        }),
      }),
      hostileEnv(list),
      { waitUntil() {} }
    );
    const parsed = await response.json();
    if (process.env.DEBUG_STORE) console.error("HOSTILE", response.status, JSON.stringify(parsed));
    return parsed;
  };

  const repeatedCursor = await hostileCall(
    async () => ({ objects: [], truncated: true, cursor: "same-token" }),
    { query: "anything", prefix: "1-projects" }
  );
  check(
    "a backend replaying one continuation token stops the listing instead of looping",
    /repeated a pagination cursor/.test(repeatedCursor.error?.message || "")
  );

  let advancing = 0;
  const runawayPages = await hostileCall(
    async () => ({ objects: [], truncated: true, cursor: `page-${++advancing}` }),
    { query: "anything", prefix: "1-projects" }
  );
  check(
    "an endlessly truncated listing is capped rather than exhausting subrequests",
    /exceeded \d+ pages/.test(runawayPages.error?.message || "") && advancing <= 200
  );

  let delimitedPages = 0;
  const runawayLayout = await hostileCall(
    async () => ({
      objects: [],
      delimitedPrefixes: [],
      truncated: true,
      cursor: `layout-${++delimitedPages}`,
    }),
    { query: "anything" }
  );
  check(
    "the delimited layout walk is capped too, not just the flat key walk",
    /exceeded \d+ pages/.test(runawayLayout.error?.message || "") && delimitedPages <= 200
  );

  const dotSegmentRead = await hostileCall(async () => ({ objects: [], truncated: false }), {
    query: "x",
    prefix: "1-projects/./secret",
  });
  check(
    "a tool path with a \".\" segment is refused by the tool layer, not just the adapter",
    /invalid prefix/.test(JSON.stringify(dotSegmentRead.result || dotSegmentRead))
  );


  /* ---------------- adapter parity: onlyIf validation (R2) ---------------- */

  // R2Store used to pass `onlyIf` straight through while S3Store validated it.
  // An R2Conditional with no etagMatches carries no condition, so a caller
  // asking for a conditional write would silently get last-writer-wins — the
  // failure the adapter exists to prevent. The in-memory stub shares R2's
  // blind spot (`if (expected && ...)`), so only an explicit check catches a
  // drift back.
  {
    const objects = new Map();
    const bucket = {
      async get() { return null; },
      async put() { return { etag: "e1" }; },
      async delete() {},
      async list() { return { objects: [], truncated: false }; },
    };
    const r2 = new R2Store(bucket);

    for (const [label, bad] of [
      ["an empty etag", { onlyIf: { etagMatches: "" } }],
      ["a whitespace etag", { onlyIf: { etagMatches: "   " } }],
      ["a missing etag", { onlyIf: {} }],
      ["a null onlyIf", { onlyIf: null }],
      ["a non-string etag", { onlyIf: { etagMatches: 42 } }],
    ]) {
      let rejected = false;
      try { await r2.put("1-projects/a.md", "x", bad); } catch { rejected = true; }
      check(`R2Store refuses a conditional write with ${label}`, rejected);
    }

    let injected = false;
    try {
      await r2.put("1-projects/a.md", "x", { onlyIf: { etagMatches: 'abc"\r\nx-evil: 1' } });
    } catch { injected = true; }
    check("R2Store refuses a header-injecting etag, as S3Store does", injected);

    let accepted = true;
    try { await r2.put("1-projects/a.md", "x", { onlyIf: { etagMatches: "abc123" } }); }
    catch { accepted = false; }
    check("R2Store still accepts a real conditional write", accepted);

    let unconditional = true;
    try { await r2.put("1-projects/a.md", "x"); } catch { unconditional = false; }
    check("R2Store still accepts an unconditional write", unconditional);
    void objects;
  }

  /* -------------------- folder paths keep a trailing slash ------------------- */

  // "1-projects/" is a natural way to name a folder. It used to survive
  // normalizePath, produce an empty final segment, and surface a reasonable
  // question as an internal error from the adapter.
  {
    const folderScope = await hostileCall(
      async () => ({ objects: [], truncated: false }),
      { path: "1-projects/" },
      "scope_info"
    );
    check(
      "scope_info accepts a folder path with a trailing slash",
      !/unsafe storage key|internal error/.test(JSON.stringify(folderScope))
    );

    const folderSearch = await hostileCall(async () => ({ objects: [], truncated: false }), {
      query: "anything",
      prefix: "1-projects/",
    });
    check(
      "search_notes accepts a folder prefix with a trailing slash",
      !/unsafe storage key|internal error|invalid prefix/.test(JSON.stringify(folderSearch))
    );
  }


  /* ------------------------------- Dropbox -------------------------------- */

  /**
   * Dropbox is the one-click tier: a folder in somebody's Dropbox rather than a
   * bucket they had to create. The point of these checks is that it is a real
   * ContextStore and not a degraded one — above the adapter nothing may learn
   * which backend it got.
   */
  const dbxJson = (body, status = 200, headers = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });

  function dropbox(handler, overrides = {}) {
    return new DropboxStore({
      accessToken: "sl.FAKE-not-a-real-token",
      fetch: fetchStub(handler),
      sleep: async () => {},
      ...overrides,
    });
  }

  {
    const store = dropbox(() => dbxJson({ rev: "0157f8" }));
    const written = await store.put("1-projects/foo.md", "hello");
    const call = store.fetch.calls[0];
    const arg = JSON.parse(call.headers["Dropbox-API-Arg"]);
    check(
      "dropbox writes to a path, with the leading slash Dropbox requires",
      arg.path === "/1-projects/foo.md"
    );
    check(
      "dropbox never autorenames around a conflict",
      arg.autorename === false
    );
    check("dropbox returns rev as the etag", written?.etag === "0157f8");
  }

  {
    // The whole reason this adapter does not report conditionalWrite: false.
    const store = dropbox(() => dbxJson({ rev: "b2" }));
    await store.put("a.md", "x", { onlyIf: { etagMatches: "a1" } });
    const arg = JSON.parse(store.fetch.calls[0].headers["Dropbox-API-Arg"]);
    check(
      "a conditional write becomes Dropbox's update mode carrying the rev",
      arg.mode?.[".tag"] === "update" && arg.mode?.update === "a1"
    );
  }

  {
    // Dropbox says 409 for a lost race; the contract says null.
    const store = dropbox(() =>
      dbxJson({ error_summary: "path/conflict/file/..", error: {} }, 409)
    );
    const result = await store.put("a.md", "x", { onlyIf: { etagMatches: "stale" } });
    check("a lost conditional write is null, not an exception", result === null);
  }

  {
    let threw = null;
    const store = dropbox(() => dbxJson({ rev: "z" }));
    try {
      await store.put("a.md", "x", { onlyIf: { etagMatches: "" } });
    } catch (error) {
      threw = error;
    }
    check(
      "an onlyIf with no usable etag is refused rather than silently overwriting",
      threw !== null && /refusing to downgrade/.test(threw.message)
    );
  }

  {
    // 409 is also how Dropbox says "no such file", so the tag decides, not the
    // status — otherwise an expired token would read as an empty context.
    const store = dropbox(() =>
      dbxJson({ error_summary: "path/not_found/..", error: {} }, 409)
    );
    check("a missing object reads as null", (await store.get("gone.md")) === null);
  }

  {
    let threw = null;
    const store = dropbox(() =>
      dbxJson({ error_summary: "expired_access_token/..", error: {} }, 409)
    );
    try {
      await store.get("a.md");
    } catch (error) {
      threw = error;
    }
    check(
      "a 409 that is not not_found is an error, never mistaken for absence",
      threw !== null
    );
  }

  {
    const body = new TextEncoder().encode("# note").buffer;
    const store = dropbox(
      () =>
        new Response(body, {
          status: 200,
          headers: { "Dropbox-API-Result": JSON.stringify({ rev: "77" }) },
        })
    );
    const object = await store.get("a.md");
    check("a read carries the rev and the bytes", object?.etag === "77");
    check("a read decodes to text", (await object.text()) === "# note");
  }

  {
    // The folder somebody chose is a rootPrefix, exactly as it is for S3, and
    // nothing above the adapter ever sees it.
    const store = dropbox(
      () =>
        dbxJson({
          entries: [
            { ".tag": "file", path_display: "/Context/1-projects/a.md", size: 3, server_modified: "2026-08-01T10:00:00Z" },
            { ".tag": "folder", path_display: "/Context/2-areas" },
          ],
          has_more: false,
        }),
      { rootPrefix: "Context" }
    );
    const page = await store.list({ prefix: "" });
    check(
      "a listing is returned in the caller's own keys, with the folder stripped",
      page.objects[0]?.key === "1-projects/a.md"
    );
    check(
      "dropbox folders become delimitedPrefixes without synthesising anything",
      page.delimitedPrefixes[0] === "2-areas/"
    );
    const arg = JSON.parse(store.fetch.calls[0].body);
    check("a listing is scoped to the chosen folder", arg.path === "/Context");
  }

  {
    const store = dropbox(() =>
      dbxJson({ error_summary: "path/not_found/..", error: {} }, 409)
    );
    const page = await store.list({ prefix: "" });
    check(
      "a folder that does not exist yet lists empty rather than throwing",
      page.objects.length === 0 && page.truncated === false
    );
  }

  {
    // Many small files is the normal shape of a context sync, so a 429 is an
    // expected condition rather than an outage.
    let calls = 0;
    const waited = [];
    const store = dropbox(
      () => {
        calls += 1;
        return calls === 1
          ? new Response("rate limited", { status: 429, headers: { "Retry-After": "3" } })
          : dbxJson({ rev: "ok" });
      },
      { sleep: async (ms) => waited.push(ms) }
    );
    const written = await store.put("a.md", "x");
    check("a 429 is retried rather than surfaced", written?.etag === "ok");
    check(
      "the retry honours Dropbox's own Retry-After",
      waited.length === 1 && waited[0] >= 3000
    );
  }

  {
    // A path with an accent or an emoji is a real note name. Dropbox reads its
    // argument out of an HTTP header, so anything non-ASCII has to be escaped
    // rather than refused.
    const store = dropbox(() => dbxJson({ rev: "1" }));
    await store.put("1-projects/café-🌍.md", "x");
    const header = store.fetch.calls[0].headers["Dropbox-API-Arg"];
    check(
      "a non-ASCII key is escaped into the API header rather than rejected",
      /\\u00e9/.test(header) && !/é/.test(header)
    );
  }

  {
    let threw = null;
    const store = dropbox(() => dbxJson({ rev: "1" }));
    try {
      await store.get("../escape.md");
    } catch (error) {
      threw = error;
    }
    check(
      "dropbox refuses a traversing key with the same guard as every other backend",
      threw !== null && /unsafe storage key/.test(threw.message)
    );
  }

  /* ------------------------ no binding in tool logic ----------------------- */

  const workerSource = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  const legacyBindingUses = workerSource.match(/env\.BRAIN/g) || [];
  check(
    "the legacy single-tenant BRAIN binding is gone from the worker entirely",
    legacyBindingUses.length === 0
  );
  check(
    "the worker builds no store of its own; every caller-facing store comes from a session",
    !/new R2Store\(env\.[A-Z_]*BRAIN/.test(workerSource) &&
      /storeForSession\(session, env, controlPlane\)/.test(workerSource)
  );
  check(
    "no static env token survives anywhere in the worker's logic",
    !/env\.(PRIVATE|TEAM|PUBLIC|INBOX)_TOKEN/.test(workerSource)
  );
}
