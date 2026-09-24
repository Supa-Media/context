/**
 * SigV4 request signing, get, conditional writes and list.
 *
 * Split out of store.test.mjs; see fixtures.mjs for the shared S3/R2/Dropbox stubs.
 */

import { parseListObjectsV2, deriveSigningKey, normalizeEtag, FAKE_CONFIG, s3, listXml } from "./fixtures.mjs";

export async function runStoreSigningChecks(check) {
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
  const copyStore = s3(() =>
    new Response("<CopyObjectResult><ETag>&quot;copy-etag&quot;</ETag></CopyObjectResult>")
  );
  const copied = await copyStore.copy("1-projects/a note.md", "1-projects/copied.md");
  check(
    "S3 same-store copy uses CopyObject without reading note bytes",
    copied?.etag === "copy-etag" &&
      copyStore.fetchImpl.calls[0].method === "PUT" &&
      copyStore.fetchImpl.calls[0].headers["x-amz-copy-source"] ===
        "/example-bucket/1-projects/a%20note.md" &&
      copyStore.fetchImpl.calls[0].headers["x-amz-metadata-directive"] === "COPY" &&
      /SignedHeaders=[a-z0-9;-]*x-amz-copy-source/.test(
        copyStore.fetchImpl.calls[0].headers.Authorization
      )
  );
  const conditionalDeleteStore = s3((call) =>
    call.headers["if-match"] === '"old-etag"'
      ? new Response("", { status: 412 })
      : new Response("", { status: 204 })
  );
  const deleteConflict = await conditionalDeleteStore.delete("1-projects/copied.md", {
    onlyIf: { etagMatches: "old-etag" },
  });
  check(
    "S3 conditional delete signs If-Match and returns null on precondition failure",
    deleteConflict === null &&
      conditionalDeleteStore.fetchImpl.calls[0].method === "DELETE" &&
      conditionalDeleteStore.fetchImpl.calls[0].headers["if-match"] === '"old-etag"' &&
      /SignedHeaders=[a-z0-9;-]*if-match/.test(
        conditionalDeleteStore.fetchImpl.calls[0].headers.Authorization
      )
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

  // `startAfter` is how the control plane's sync manifest resumes a walk
  // without handing a caller the continuation token — which is base64 of the
  // last backend key, and that key can be a note the caller may not see. It is
  // ListObjectsV2's own `start-after`, root-prefixed like every other key, and
  // a continuation token supersedes it, so it is only sent on a first page.
  const startAfterStore = s3(() => new Response(listXml({})), { rootPrefix: "team-notes" });
  await startAfterStore.list({ prefix: "", startAfter: "1-projects/a.md" });
  await startAfterStore.list({ prefix: "", startAfter: "1-projects/a.md", cursor: "token-page-2" });
  check(
    "startAfter is sent as a root-prefixed start-after, and never beside a continuation token",
    startAfterStore.fetchImpl.calls[0].url.searchParams.get("start-after") ===
      "team-notes/1-projects/a.md" &&
      startAfterStore.fetchImpl.calls[1].url.searchParams.get("start-after") === null &&
      startAfterStore.fetchImpl.calls[1].url.searchParams.get("continuation-token") ===
        "token-page-2"
  );
  let refusedStartAfter = false;
  try {
    await startAfterStore.list({ prefix: "", startAfter: "../escape.md" });
  } catch {
    refusedStartAfter = true;
  }
  check(
    "a startAfter is a key, and a key that climbs out of the root is refused before any request",
    refusedStartAfter && startAfterStore.fetchImpl.calls.length === 2
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

  // Moved here from the rootPrefix section (store/rootPrefixAndTraversal.test.mjs):
  // it asserts on `delimitedStore` and `pagedStore`, both declared above in this
  // same "list" section, so it stays beside them rather than crossing a module
  // boundary to reach shared mutable state.
  check(
    "an unprefixed list also addresses the bucket root",
    delimitedStore.fetchImpl.calls[0].url.pathname === "/example-bucket" &&
      pagedStore.fetchImpl.calls[0].url.pathname === "/example-bucket"
  );

}
