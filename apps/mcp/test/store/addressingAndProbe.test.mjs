/**
 * S3 addressing-style selection, If-Match header shape, hostile XML/oversize
 * response handling, and the conditional-write capability probe.
 *
 * Split out of store.test.mjs; see fixtures.mjs for the shared S3/R2/Dropbox stubs.
 */

import { S3Store, R2Store, FAKE_CONFIG, s3, listXml, memoryBucket, parseListObjectsV2, probeStore, PROBE_PREFIX } from "./fixtures.mjs";

export async function runStoreAddressingAndProbeChecks(check) {
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
  {
    const objects = new Map();
    let counter = 0;
    const probe = await probeStore(
      s3((call) => {
        const key = decodeURIComponent(call.url.pathname.split("/").slice(2).join("/"));
        if (call.method === "GET" && call.url.searchParams.get("list-type") === "2") {
          return new Response(listXml());
        }
        if (call.method === "GET") {
          const object = objects.get(key);
          if (!object) return new Response("", { status: 404 });
          return new Response(object.body, { status: 200, headers: { etag: `"${object.etag}"` } });
        }
        if (call.method === "PUT") {
          const ifMatch = call.headers["if-match"]?.replace(/^"|"$/g, "");
          if (call.headers["if-none-match"] === "*" && objects.has(key)) {
            return new Response("", { status: 412 });
          }
          const copySource = call.headers["x-amz-copy-source"];
          if (copySource) {
            const sourceKey = decodeURIComponent(String(copySource).split("/").slice(2).join("/"));
            const source = objects.get(sourceKey);
            const sourceIfMatch = call.headers["x-amz-copy-source-if-match"]?.replace(/^"|"$/g, "");
            if (!source) return new Response("", { status: 404 });
            if (sourceIfMatch && source.etag !== sourceIfMatch) return new Response("", { status: 412 });
            const etag = `s3-probe-${++counter}`;
            objects.set(key, { body: source.body, etag });
            return new Response(
              `<CopyObjectResult><ETag>&quot;${etag}&quot;</ETag></CopyObjectResult>`,
              { status: 200 }
            );
          }
          if (ifMatch && objects.get(key)?.etag !== ifMatch) return new Response("", { status: 412 });
          const etag = `s3-probe-${++counter}`;
          objects.set(key, { body: call.body, etag });
          return new Response("", { status: 200, headers: { etag: `"${etag}"` } });
        }
        if (call.method === "DELETE") {
          const ifMatch = call.headers["if-match"]?.replace(/^"|"$/g, "");
          if (ifMatch && objects.get(key)?.etag !== ifMatch) return new Response("", { status: 412 });
          objects.delete(key);
          return new Response(null, { status: 204 });
        }
        return new Response("", { status: 405 });
      })
    );
    check(
      "probe confirms S3 conditional delete when If-Match delete is enforced",
      probe.ok === true &&
        probe.capabilities.conditionalWrite === true &&
        probe.capabilities.conditionalCreate === true &&
        probe.capabilities.conditionalDelete === true &&
        probe.capabilities.serverSideCopy === "same-store" &&
        probe.conditionalCreate.verified === true &&
        probe.conditionalDelete.verified === true &&
        probe.conditionalDelete.rejectsWrong === true &&
        probe.conditionalDelete.acceptsCorrect === true &&
        probe.serverSideCopy.verified === true &&
        probe.serverSideCopy.rejectsDestinationConflict === true &&
        probe.serverSideCopy.rejectsSourceMismatch === true
    );
  }

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

  for (const [label, lieMode] of [
    ["reports refusal after creating", "create-then-refuse"],
    ["refuses every create-only write", "always-refuse"],
  ]) {
    const objects = new Map();
    let counter = 0;
    const dishonestCreateStore = {
      capabilities: { conditionalWrite: false, conditionalCreate: true },
      async get(key) {
        const object = objects.get(key);
        if (!object) return null;
        return {
          etag: object.etag,
          text: async () => object.body,
          arrayBuffer: async () => new TextEncoder().encode(object.body).buffer,
        };
      },
      async put(key, value, options = {}) {
        if (options?.onlyIf?.absent === true) {
          if (objects.has(key) || lieMode === "always-refuse") return null;
          const body = typeof value === "string" ? value : new TextDecoder().decode(value);
          objects.set(key, { body, etag: `d${++counter}` });
          return null;
        }
        const body = typeof value === "string" ? value : new TextDecoder().decode(value);
        const etag = `d${++counter}`;
        objects.set(key, { body, etag });
        return { etag };
      },
      async delete(key) { objects.delete(key); },
      async list() { return { objects: [], truncated: false }; },
    };
    const dishonestProbe = await probeStore(dishonestCreateStore);
    check(
      `probe catches a backend that ${label}`,
      dishonestProbe.capabilities.conditionalCreate === false &&
        dishonestProbe.conditionalCreate.acceptsAbsent === false &&
        dishonestProbe.conditionalCreate.verified === false &&
        dishonestProbe.conditionalCreate.mismatch === true &&
        dishonestProbe.cleanedUp === true
    );
  }

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

}
