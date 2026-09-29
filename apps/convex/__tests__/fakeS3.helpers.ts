/**
 * Path-style S3 buckets in memory, answering the adapter's requests through a
 * stubbed `fetch`: list (with LastModified), get, head, put with
 * `If-None-Match: *`, and delete. Unstub with `vi.unstubAllGlobals()`.
 */

import { vi } from "vitest";

interface FakeObject {
  body: Uint8Array;
  contentType: string;
  modified: number;
}

/** Path-style S3 buckets by name, with `If-None-Match: *` honoured. */
export function fakeS3(
  buckets: Record<string, Record<string, [string, number]>>,
  options: {
    /** Keys whose DELETE answers 204 and leaves them, as object lock can. */
    undeletable?: string[];
  } = {},
) {
  const store = new Map<string, Map<string, FakeObject>>();
  for (const [name, objects] of Object.entries(buckets)) {
    store.set(
      name,
      new Map(
        Object.entries(objects).map(([key, [body, modified]]) => [
          key,
          { body: new TextEncoder().encode(body), contentType: "text/markdown; charset=utf-8", modified },
        ]),
      ),
    );
  }
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const [bucket, ...rest] = url.pathname.slice(1).split("/");
    const key = decodeURIComponent(rest.join("/"));
    requests.push(`${method} ${bucket}/${key}`);
    const objects = store.get(bucket!);
    if (objects === undefined) return new Response("", { status: 404 });
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    if (method === "GET" && url.searchParams.get("list-type") === "2") {
      const contents = [...objects.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(
          ([listed, value]) =>
            `<Contents><Key>${listed}</Key><Size>${value.body.byteLength}</Size><LastModified>${new Date(value.modified).toISOString()}</LastModified><ETag>"e"</ETag></Contents>`,
        )
        .join("");
      return new Response(
        `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
        { status: 200 },
      );
    }
    if (method === "GET" || method === "HEAD") {
      const found = objects.get(key);
      if (found === undefined) return new Response(null, { status: 404 });
      return new Response(method === "HEAD" ? null : new Blob([found.body as BlobPart]), {
        status: 200,
        headers: {
          "content-type": found.contentType,
          "last-modified": new Date(found.modified).toUTCString(),
          etag: '"e"',
        },
      });
    }
    if (method === "PUT") {
      if (headers.get("if-none-match") === "*" && objects.has(key)) {
        return new Response("", { status: 412 });
      }
      const body = new Uint8Array(init?.body as ArrayBuffer | Uint8Array);
      objects.set(key, {
        body,
        contentType: headers.get("content-type") ?? "application/octet-stream",
        modified: Date.now(),
      });
      return new Response("", { status: 200, headers: { etag: '"e"' } });
    }
    if (method === "DELETE") {
      if (!options.undeletable?.includes(key)) objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response("", { status: 400 });
  });
  return {
    requests,
    keys(bucket: string) {
      return [...(store.get(bucket)?.keys() ?? [])].sort();
    },
    read(bucket: string, key: string) {
      const found = store.get(bucket)?.get(key);
      return found === undefined ? null : new TextDecoder().decode(found.body);
    },
  };
}

