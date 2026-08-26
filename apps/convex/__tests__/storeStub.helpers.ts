/**
 * In-memory buckets for the connect flow, in two flavours.
 *
 * `memoryStore()` is a plain `ContextStore` — enough to exercise scaffolding
 * without any HTTP in the way, the same shape `apps/mcp/test/` uses.
 *
 * `memoryS3()` is a *fetch stub speaking the S3 wire protocol*, so the real
 * `S3Store` — real SigV4, real URL building, real XML parsing, real `If-Match`
 * handling — runs against it. That distinction matters: a hand-written
 * `ContextStore` fake would prove the probe logic and nothing about whether
 * the adapter the control plane actually constructs works. The verification
 * tests use the S3 one for that reason.
 *
 * Both model the ways a backend can be wrong, because "it works on R2" is not
 * the interesting case:
 *  - `ignoreIfMatch` — accepts `If-Match` and writes anyway. Backblaze B2 and
 *    Wasabi. Looks conflict-safe, silently is not.
 *  - `readOnly` — lists fine, refuses every write. A credential missing
 *    `s3:PutObject`.
 *  - `unreachable` — refuses to list at all. A wrong bucket, region, or key.
 *
 * Every value here is obviously fake. This repository is public.
 */

import type { ScaffoldStore } from "../functions/lib/scaffold";

interface StoredValue {
  body: string;
  etag: string;
}

/* -------------------------------------------------------------------------- */
/*                          a plain in-memory ContextStore                    */
/* -------------------------------------------------------------------------- */

export interface MemoryStore extends ScaffoldStore {
  objects: Map<string, StoredValue>;
  seed(key: string, body: string): void;
  snapshot(): Record<string, string>;
  /**
   * `delete` and `capabilities` complete the `ContextStore` surface, so this
   * stub also satisfies `lib/fileOps.ts`'s `FileStore`. `capabilities` is
   * honest about `ignoreIfMatch`: a backend that ignores `If-Match` must not
   * *claim* conditional writes, or the code under test would take a guarantee
   * it does not have — which is the exact production bug the capability probe
   * exists to catch.
   */
  delete(key: string): Promise<void>;
  capabilities: { conditionalWrite: boolean };
}

export function memoryStore(
  options: { ignoreIfMatch?: boolean } = {},
): MemoryStore {
  const objects = new Map<string, StoredValue>();
  let counter = 0;

  return {
    objects,
    capabilities: { conditionalWrite: options.ignoreIfMatch !== true },
    seed(key, body) {
      objects.set(key, { body, etag: `m${++counter}` });
    },
    async delete(key) {
      objects.delete(key);
    },
    snapshot() {
      return Object.fromEntries(
        [...objects.entries()].map(([key, value]) => [key, value.body]),
      );
    },
    async get(key) {
      const value = objects.get(key);
      if (!value) return null;
      return { etag: value.etag, text: async () => value.body };
    },
    async put(key, body, putOptions) {
      const expected = putOptions?.onlyIf?.etagMatches;
      if (expected && !options.ignoreIfMatch && objects.get(key)?.etag !== expected) {
        return null;
      }
      const etag = `m${++counter}`;
      objects.set(key, { body, etag });
      return { etag };
    },
    async list(listOptions) {
      return listPage(objects, listOptions ?? {});
    },
  };
}

/** Shared listing semantics: prefix, delimiter, max-keys, continuation. */
function listPage(
  objects: Map<string, StoredValue>,
  {
    prefix = "",
    delimiter,
    cursor,
    limit,
  }: { prefix?: string; delimiter?: string; cursor?: string; limit?: number },
) {
  const contents: string[] = [];
  const prefixes = new Set<string>();
  for (const key of [...objects.keys()].sort()) {
    if (!key.startsWith(prefix)) continue;
    if (delimiter) {
      const rest = key.slice(prefix.length);
      const at = rest.indexOf(delimiter);
      if (at >= 0) {
        prefixes.add(`${prefix}${rest.slice(0, at + delimiter.length)}`);
        continue;
      }
    }
    contents.push(key);
  }

  // One ordered stream so pagination is meaningful across both kinds.
  const entries = [
    ...contents.map((key) => ({ name: key, kind: "object" as const })),
    ...[...prefixes].map((name) => ({ name, kind: "prefix" as const })),
  ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const start = cursor
    ? entries.findIndex((entry) => entry.name > cursor)
    : 0;
  const from = start < 0 ? entries.length : start;
  const max = limit && limit > 0 ? limit : 1000;
  const page = entries.slice(from, from + max);
  const truncated = from + max < entries.length;

  return {
    objects: page
      .filter((entry) => entry.kind === "object")
      .map((entry) => ({
        key: entry.name,
        size: objects.get(entry.name)!.body.length,
        uploaded: new Date(0),
        etag: objects.get(entry.name)!.etag,
      })),
    delimitedPrefixes: page
      .filter((entry) => entry.kind === "prefix")
      .map((entry) => entry.name),
    truncated,
    cursor: truncated ? page[page.length - 1]?.name : undefined,
  };
}

/* -------------------------------------------------------------------------- */
/*                     a fetch stub that speaks S3 over HTTP                  */
/* -------------------------------------------------------------------------- */

export interface MemoryS3Options {
  /** Accepts `If-Match` and overwrites anyway — B2, Wasabi. */
  ignoreIfMatch?: boolean;
  /** Lists, refuses every write. */
  readOnly?: boolean;
  /** Refuses even to list. */
  unreachable?: boolean;
  /**
   * Text the provider puts in its `<Message>`. Used to prove that whatever a
   * provider says about a credential does not end up stored.
   */
  errorMessage?: string;
}

export interface MemoryS3 {
  objects: Map<string, StoredValue>;
  requests: { method: string; key: string }[];
  seed(key: string, body: string): void;
  snapshot(): Record<string, string>;
  fetchImpl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function errorResponse(status: number, code: string, message: string): Response {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${xmlEscape(code)}</Code>` +
      `<Message>${xmlEscape(message)}</Message></Error>`,
    { status, headers: { "content-type": "application/xml" } },
  );
}

export function memoryS3(
  bucket: string,
  options: MemoryS3Options = {},
): MemoryS3 {
  const objects = new Map<string, StoredValue>();
  const requests: { method: string; key: string }[] = [];
  let counter = 0;
  const failureMessage =
    options.errorMessage ?? "The request signature we calculated does not match.";

  const fetchImpl = async (
    input: URL | RequestInfo,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const segments = url.pathname.replace(/^\/+/, "").split("/");
    if (decodeURIComponent(segments[0]) !== bucket) {
      return errorResponse(404, "NoSuchBucket", "The specified bucket does not exist");
    }
    const key = segments.slice(1).map(decodeURIComponent).join("/");
    requests.push({ method, key });

    if (key === "") {
      if (options.unreachable) {
        return errorResponse(403, "AccessDenied", failureMessage);
      }
      const page = listPage(objects, {
        prefix: url.searchParams.get("prefix") ?? "",
        delimiter: url.searchParams.get("delimiter") ?? undefined,
        cursor: url.searchParams.get("continuation-token") ?? undefined,
        limit: Number(url.searchParams.get("max-keys")) || undefined,
      });
      return new Response(listXml(page), {
        headers: { "content-type": "application/xml" },
      });
    }

    if (method === "GET") {
      const value = objects.get(key);
      if (!value) return new Response("", { status: 404 });
      return new Response(value.body, { headers: { etag: `"${value.etag}"` } });
    }

    if (method === "PUT") {
      if (options.readOnly) {
        return errorResponse(403, "AccessDenied", failureMessage);
      }
      const headers = new Headers(
        (init.headers as Record<string, string>) ?? {},
      );
      const expected = headers.get("if-match")?.replace(/^"(.*)"$/, "$1");
      if (
        expected &&
        !options.ignoreIfMatch &&
        objects.get(key)?.etag !== expected
      ) {
        return new Response("", { status: 412 });
      }
      const body = init.body;
      const text =
        typeof body === "string"
          ? body
          : new TextDecoder().decode(body as Uint8Array);
      const etag = `m${++counter}`;
      objects.set(key, { body: text, etag });
      return new Response("", { status: 200, headers: { etag: `"${etag}"` } });
    }

    if (method === "DELETE") {
      objects.delete(key);
      // 204 is a null-body status; a body here is a `Response` constructor
      // error in some runtimes, not an empty response.
      return new Response(null, { status: 204 });
    }

    return errorResponse(405, "MethodNotAllowed", "unsupported");
  };

  return {
    objects,
    requests,
    seed(key, body) {
      objects.set(key, { body, etag: `m${++counter}` });
    },
    snapshot() {
      return Object.fromEntries(
        [...objects.entries()].map(([key, value]) => [key, value.body]),
      );
    },
    fetchImpl,
  };
}

function listXml(page: ReturnType<typeof listPage>): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
    `<IsTruncated>${page.truncated}</IsTruncated>` +
    (page.cursor
      ? `<NextContinuationToken>${xmlEscape(page.cursor)}</NextContinuationToken>`
      : "") +
    page.objects
      .map(
        (object) =>
          `<Contents><Key>${xmlEscape(object.key)}</Key>` +
          `<LastModified>2026-08-01T10:00:00.000Z</LastModified>` +
          `<ETag>&quot;${object.etag}&quot;</ETag><Size>${object.size}</Size></Contents>`,
      )
      .join("") +
    page.delimitedPrefixes
      .map((prefix) => `<CommonPrefixes><Prefix>${xmlEscape(prefix)}</Prefix></CommonPrefixes>`)
      .join("") +
    `</ListBucketResult>`
  );
}
