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

