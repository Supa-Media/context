/**
 * rootPrefix isolation and path/key traversal rejection across every backend.
 *
 * Split out of store.test.mjs; see fixtures.mjs for the shared S3/R2/Dropbox stubs.
 */

import { S3Store, R2Store, DropboxStore, FAKE_CONFIG, s3, listXml, memoryBucket } from "./fixtures.mjs";

export async function runStoreRootPrefixAndTraversalChecks(check) {
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
    "1-projects/a\u0000.md",
    "1-projects/a\r\nb.md",
    "",
  ];

  const traversalStore = s3(() => new Response("nope"), { rootPrefix: "team-notes" });
  const traversalBucket = memoryBucket();
  const traversalR2 = new R2Store(traversalBucket, { rootPrefix: "team-notes" });
  // Dropbox runs the same matrix. It had one traversal check — a single key
  // through `get` — under a name claiming parity with "every other backend".
  // On this backend the claim matters more than on the others: the OAuth token
  // is scoped to an ACCOUNT rather than to a bucket nobody else uses, so a key
  // that escapes the root escapes into the customer's own Dropbox.
  const traversalDropboxCalls = [];
  const traversalDropbox = new DropboxStore({
    accessToken: "sl.FAKE-not-a-real-token",
    rootPrefix: "team-notes",
    sleep: async () => {},
    fetch: async (...args) => {
      traversalDropboxCalls.push(args);
      return new Response("{}", { status: 200 });
    },
  });
  const rejections = [];
  for (const key of TRAVERSAL_KEYS) {
    for (const [name, run] of [
      ["S3Store.get", () => traversalStore.get(key)],
      ["S3Store.put", () => traversalStore.put(key, "x")],
      ["S3Store.delete", () => traversalStore.delete(key)],
      ["R2Store.get", () => traversalR2.get(key)],
      ["R2Store.put", () => traversalR2.put(key, "x")],
      ["R2Store.delete", () => traversalR2.delete(key)],
      ["DropboxStore.get", () => traversalDropbox.get(key)],
      ["DropboxStore.put", () => traversalDropbox.put(key, "x")],
      ["DropboxStore.delete", () => traversalDropbox.delete(key)],
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
    "dot, dot-dot, empty, encoded, control-character and backslash keys are rejected by every adapter",
    rejections.length === 0
  );
  check(
    "a rejected key never reaches the backend",
    traversalStore.fetchImpl.calls.length === 0 &&
      traversalBucket.objects.size === 0 &&
      traversalDropboxCalls.length === 0
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

  // The same matrix, through `copy` — which takes TWO caller keys and was in
  // neither matrix above, on either argument, for any adapter. That is the
  // third time this matrix has been found short: the key matrix was widened to
  // cover Dropbox, then the list prefix was, and `copy` was missed by both.
  //
  // Measured guard by guard before writing this, the way the two widenings
  // below were, because "the suite covers copy" is exactly the kind of claim
  // that is worth six runs rather than one. Removing each `assertSafeKey` in
  // turn, against the suite AS IT WAS:
  //
  //   Dropbox source · Dropbox destination · R2 source · R2 destination ·
  //   S3 source                                            → all green
  //   S3 destination                                       → also green
  //
  // Five of those six were held by nothing at all. The sixth is different and
  // the difference is worth stating rather than averaging away: `S3Store.copy`
  // passes its destination through `urlFor`, which runs `assertSafeKey` again,
  // so the local call is genuinely redundant and deleting it changes no
  // behaviour. The checks below still cover that position — with the local
  // assertion removed they stay green because the key is still refused, one
  // layer down.
  //
  // It matters most on Dropbox for the reason given above: the OAuth token is
  // scoped to an ACCOUNT, so a key escaping the root escapes into the rest of
  // the customer's own Dropbox rather than into a bucket nobody else uses.
  //
  // **R2 needs a source that EXISTS.** `copy` returns early when it does not,
  // so a destination-position check against an empty bucket would pass without
  // ever reaching the guard — green for a reason that has nothing to do with
  // the thing being asserted. The seeded key is the prefixed one the adapter
  // actually writes.
  const COPY_SAFE_KEY = "1-projects/ok.md";
  const copyBucket = memoryBucket();
  copyBucket.objects.set(`team-notes/${COPY_SAFE_KEY}`, { body: "x", etag: "m1" });
  const copyR2 = new R2Store(copyBucket, { rootPrefix: "team-notes" });
  const copyS3 = s3(
    () => new Response("<CopyObjectResult><ETag>&quot;copied&quot;</ETag></CopyObjectResult>"),
    { rootPrefix: "team-notes" }
  );
  const copyDropboxCalls = [];
  const copyDropbox = new DropboxStore({
    accessToken: "sl.FAKE-not-a-real-token",
    rootPrefix: "team-notes",
    sleep: async () => {},
    fetch: async (...args) => {
      copyDropboxCalls.push(args);
      return new Response("{}", { status: 200 });
    },
  });

  const copyRejections = [];
  for (const key of TRAVERSAL_KEYS) {
    for (const [name, run] of [
      ["S3Store.copy source", () => copyS3.copy(key, COPY_SAFE_KEY)],
      ["S3Store.copy destination", () => copyS3.copy(COPY_SAFE_KEY, key)],
      ["R2Store.copy source", () => copyR2.copy(key, COPY_SAFE_KEY)],
      ["R2Store.copy destination", () => copyR2.copy(COPY_SAFE_KEY, key)],
      ["DropboxStore.copy source", () => copyDropbox.copy(key, COPY_SAFE_KEY)],
      ["DropboxStore.copy destination", () => copyDropbox.copy(COPY_SAFE_KEY, key)],
    ]) {
      let threw = null;
      try {
        await run();
      } catch (error) {
        threw = error;
      }
      if (!threw) copyRejections.push(`${name} accepted ${JSON.stringify(key)}`);
      else if (!/unsafe storage key/.test(threw.message)) {
        copyRejections.push(`${name} threw the wrong error for ${JSON.stringify(key)}`);
      }
    }
  }
  check(
    "a traversal key is rejected in BOTH arguments of copy by every adapter",
    copyRejections.length === 0
  );
  // The seeded source is the only thing that should ever be in that bucket: a
  // refused destination must not have written a second object under it.
  check(
    "a rejected copy never reaches the backend",
    copyS3.fetchImpl.calls.length === 0 &&
      copyBucket.objects.size === 1 &&
      copyDropboxCalls.length === 0
  );

  // The same matrix, on the other argument. This used to be one prefix through
  // one adapter, under a name claiming a list prefix "gets the same treatment
  // as a key" — the key matrix above runs fourteen keys through three backends.
  // Measured before widening it: deleting `assertSafePrefix` from
  // `DropboxStore.list` reddened **nothing**, while deleting it from
  // `R2Store.list` reddened one and dropping `normalizeRootPrefix` from the
  // Dropbox constructor reddened one. So the single gap was the `list` prefix
  // on the backend where it matters most: Dropbox's token is scoped to an
  // ACCOUNT, not to a bucket nobody else uses, so a prefix that escapes the
  // root escapes into the customer's own Dropbox — the reason the key matrix
  // above was widened to include this adapter in the first place.
  const TRAVERSAL_PREFIXES = [
    "../",
    "a/../../b/",
    "x/../../../",
    "1-projects/./",
    "%2e%2e/",
    "a/%2E%2E/",
    "%2e/",
    "/1-projects/",
    "1-projects//",
    "1-projects/a\\..\\b/",
    "1-projects/a\u0000/",
    "1-projects/a\r\nb/",
  ];

  const traversalPrefixStore = s3(() => new Response(listXml({})), { rootPrefix: "team-notes" });
  // R2's backend is watched by RECORDING ITS LIST CALLS, not by checking the
  // bucket is empty. An earlier revision did the latter, copying the key
  // matrix's `traversalBucket.objects.size === 0` — and that expression is
  // load-bearing there only because that matrix runs `put`. Here nothing
  // writes, so an empty bucket is true however badly the guard fails: measured,
  // deleting `assertSafePrefix` from `R2Store.list` left the size check green.
  // A tautology inside a check named "on any of them" is the defect this whole
  // section is about, so it is a call log instead.
  const traversalPrefixR2Lists = [];
  const traversalPrefixBucket = memoryBucket();
  const traversalPrefixR2 = new R2Store(
    {
      ...traversalPrefixBucket,
      list: async (options) => {
        traversalPrefixR2Lists.push(options);
        return traversalPrefixBucket.list(options);
      },
    },
    { rootPrefix: "team-notes" },
  );
  const prefixRejections = [];
  for (const prefix of TRAVERSAL_PREFIXES) {
    for (const [name, run] of [
      ["S3Store.list", () => traversalPrefixStore.list({ prefix })],
      ["R2Store.list", () => traversalPrefixR2.list({ prefix })],
      ["DropboxStore.list", () => traversalDropbox.list({ prefix })],
    ]) {
      let threw = null;
      try {
        await run();
      } catch (error) {
        threw = error;
      }
      if (!threw) prefixRejections.push(`${name} accepted ${JSON.stringify(prefix)}`);
      else if (!/unsafe storage prefix/.test(threw.message)) {
        prefixRejections.push(`${name} threw the wrong error for ${JSON.stringify(prefix)}`);
      }
    }
  }
  check(
    "a list prefix gets the same treatment as a key, on every adapter",
    prefixRejections.length === 0
  );
  // All three, like the key matrix above. `traversalDropboxCalls` is asserted
  // empty at the end of that matrix and nothing touches the instance between
  // there and here, so counting it again is a claim about this loop and not a
  // restatement of that one.
  check(
    "and a refused prefix reaches no backend at all, on any of them",
    traversalPrefixStore.fetchImpl.calls.length === 0 &&
      traversalPrefixR2Lists.length === 0 &&
      traversalDropboxCalls.length === 0
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
  await legitimateStore.list({ prefix: ".context/proposals/pending/" });
  await legitimateStore.list({});
  check(
    "dot-prefixed plumbing keys and trailing-slash prefixes still work",
    legitimateStore.fetchImpl.calls[0].url.pathname ===
      "/example-bucket/.history/1-projects/a.2026-08-25.md" &&
      legitimateStore.fetchImpl.calls[1].url.searchParams.get("prefix") === ".context/proposals/pending/" &&
      legitimateStore.fetchImpl.calls[2].url.searchParams.has("prefix") === false
  );

}
