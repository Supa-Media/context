/**
 * Storage adapter checks: SigV4 signing, ListObjectsV2 parsing, rootPrefix
 * isolation, and the conditional-write capability probe.
 *
 * Offline and dependency-free — every backend is a fetch stub or an in-memory
 * map. Run as part of `node test/test.mjs`.
 */

import { readFileSync } from "node:fs";
import { R2Store } from "../src/store/r2.js";
import { S3Store, parseListObjectsV2, deriveSigningKey } from "../src/store/s3.js";
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

/** In-memory bucket with the same semantics as the R2 binding. */
function memoryBucket({ ignoreIfMatch = false } = {}) {
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
      // A backend that "supports" If-Match by ignoring it — B2 and Wasabi.
      if (expected && !ignoreIfMatch && objects.get(key)?.etag !== expected) return null;
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

export async function runStoreChecks(check) {
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
    "probe leaves nothing behind in the bucket",
    honestProbe.cleanedUp === true &&
      ![...honestBucket.objects.keys()].some((key) => key.startsWith(PROBE_PREFIX))
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

  /* ------------------------ no binding in tool logic ----------------------- */

  const workerSource = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  const bindingUses = workerSource.match(/env\.BRAIN/g) || [];
  check(
    "the R2 binding name appears only where the worker builds its store",
    bindingUses.length === 1 &&
      /function storeForRequest\(env\) \{\n\s+return new R2Store\(env\.BRAIN\);/.test(workerSource)
  );
}
