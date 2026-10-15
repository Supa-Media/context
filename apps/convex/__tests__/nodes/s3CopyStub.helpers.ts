/**
 * `memoryS3` (the S3 wire stub) plus what a server-side move needs of a
 * provider: HEAD answering type and `x-amz-meta-*`, and multipart uploads
 * whose parts are copied by range (`UploadPartCopy`). The real `S3Store`, its
 * signing and its XML parsing run against it.
 *
 * Every value here is fake. This repository is public.
 */

import { S3Store } from "../../../mcp/src/store/s3.js";
import { memoryS3 } from "../storeStub.helpers";

interface Upload {
  key: string;
  contentType?: string;
  meta: Record<string, string>;
  parts: Map<number, { bytes: Uint8Array; etag: string }>;
}

export interface CopyStubHooks {
  /** Called before each part copy; return a status to answer instead (e.g. 500). */
  beforePart?: (partNumber: number) => number | void;
  /** Called before a completion; may change the bucket (a stranger's write). */
  beforeComplete?: () => void;
}

export function s3CopyStub(hooks: CopyStubHooks = {}) {
  const base = memoryS3("bkt", { ignoreConditionalDelete: true });
  const meta = new Map<string, Record<string, string>>();
  const uploads = new Map<string, Upload>();
  const log: { method: string; key: string; query: string }[] = [];
  let counter = 0;

  const keyOf = (url: URL) => url.pathname.replace(/^\/+/, "").split("/").slice(1).map(decodeURIComponent).join("/");
  const xml = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "application/xml" } });

  const fetchImpl = async (input: URL | RequestInfo, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers((init.headers as Record<string, string>) ?? {});
    const key = keyOf(url);
    log.push({ method, key, query: url.search });
    const uploadId = url.searchParams.get("uploadId");

    if (method === "HEAD" && key !== "") {
      const value = base.objects.get(key);
      if (!value) return new Response(null, { status: 404 });
      return new Response(null, {
        status: 200,
        headers: {
          etag: `"${value.etag}"`,
          "content-length": String(value.bytes.length),
          ...(value.contentType ? { "content-type": value.contentType } : {}),
          ...(meta.get(key) ?? {}),
        },
      });
    }
    if (method === "POST" && url.searchParams.has("uploads")) {
      const id = `up${++counter}`;
      const own: Record<string, string> = {};
      headers.forEach((value, name) => {
        if (name.startsWith("x-amz-meta-")) own[name] = value;
      });
      uploads.set(id, { key, contentType: headers.get("content-type") ?? undefined, meta: own, parts: new Map() });
      return xml(`<InitiateMultipartUploadResult><Bucket>bkt</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
    }
    if (method === "PUT" && uploadId !== null) {
      const upload = uploads.get(uploadId);
      if (!upload) return xml("<Error><Code>NoSuchUpload</Code></Error>", 404);
      const partNumber = Number(url.searchParams.get("partNumber"));
      const answer = hooks.beforePart?.(partNumber);
      if (typeof answer === "number") return xml("<Error><Code>InternalError</Code></Error>", answer);
      const sourceKey = decodeURIComponent(headers.get("x-amz-copy-source") ?? "").replace(/^\/+/, "").split("/").slice(1).join("/");
      const source = base.objects.get(sourceKey);
      if (!source) return xml("<Error><Code>NoSuchKey</Code></Error>", 404);
      const expected = headers.get("x-amz-copy-source-if-match")?.replace(/^"(.*)"$/, "$1");
      if (expected && source.etag !== expected) return new Response("", { status: 412 });
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(headers.get("x-amz-copy-source-range") ?? "") ?? [];
      const bytes = source.bytes.slice(Number(start), Number(end) + 1);
      const etag = `p${++counter}`;
      upload.parts.set(partNumber, { bytes, etag });
      return xml(`<CopyPartResult><ETag>&quot;${etag}&quot;</ETag></CopyPartResult>`);
    }
    if (method === "POST" && uploadId !== null) {
      const upload = uploads.get(uploadId);
      if (!upload) return xml("<Error><Code>NoSuchUpload</Code></Error>", 404);
      hooks.beforeComplete?.();
      if (headers.get("if-none-match") === "*" && base.objects.has(upload.key)) return new Response("", { status: 412 });
      const body = new TextDecoder().decode(init.body as Uint8Array);
      const numbers = [...body.matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((match) => Number(match[1]));
      const chunks = numbers.map((n) => upload.parts.get(n)!.bytes);
      const total = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        total.set(chunk, offset);
        offset += chunk.length;
      }
      base.seed(upload.key, total);
      const stored = base.objects.get(upload.key)!;
      const etag = `mp${++counter}-${numbers.length}`;
      (stored as { etag: string }).etag = etag;
      if (upload.contentType) (stored as { contentType?: string }).contentType = upload.contentType;
      meta.set(upload.key, upload.meta);
      uploads.delete(uploadId);
      return xml(`<CompleteMultipartUploadResult><Key>${upload.key}</Key><ETag>&quot;${etag}&quot;</ETag></CompleteMultipartUploadResult>`);
    }
    if (method === "DELETE" && uploadId !== null) {
      uploads.delete(uploadId);
      return new Response(null, { status: 204 });
    }
    if ((method === "PUT" || method === "DELETE") && key !== "" && !headers.get("x-amz-copy-source")) meta.delete(key);
    return await base.fetchImpl(input, init);
  };

  /** Put an object with a type, as an upload would. */
  const seed = (key: string, body: string | Uint8Array, contentType?: string) => {
    base.seed(key, body);
    if (contentType) (base.objects.get(key) as { contentType?: string }).contentType = contentType;
  };

  const s3 = (config: { singleCopyMaxBytes?: number; copyPartBytes?: number } = {}) => {
    const store = new S3Store({
      endpoint: "https://s3.example.test",
      region: "auto",
      bucket: "bkt",
      accessKeyId: "AKIAFAKEFAKEFAKE",
      secretAccessKey: "fake-secret-fake-secret-fake-secret",
      forcePathStyle: true,
      fetchImpl,
      ...config,
    });
    // As probed on R2: conditional writes and creates, no conditional delete, server-side copy.
    store.capabilities = { conditionalWrite: true, conditionalCreate: true, conditionalDelete: false, serverSideCopy: "same-store" };
    return store;
  };

  return { base, meta, uploads, log, seed, s3, fetchImpl };
}

/** Bytes 0..n-1 cycling, so a misplaced range shows up as a different array. */
export function pattern(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 31 + 7) % 251;
  return bytes;
}
