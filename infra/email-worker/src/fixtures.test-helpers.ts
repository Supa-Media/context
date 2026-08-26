/**
 * Fixtures for the offline suite.
 *
 * Every value here is obviously fake — `example.com`, `example.net`,
 * `evil.test` — because this repository is public and a fixture that looked
 * like a real address would eventually be treated as one.
 *
 * Nothing in this file touches the network, and nothing in the suite that uses
 * it may either: `worker.test.ts` stubs `fetch` so a stray call fails loudly
 * rather than silently succeeding.
 */

/** The authserv-id the suite pretends our MX writes. */
export const AUTHSERV = "mx.example-mta.test";

export const APEX = "context.lc";

export interface RawMessageOptions {
  /** Extra headers, in order, *above* the standard ones. */
  leadingHeaders?: [string, string][];
  from?: string;
  to?: string;
  subject?: string;
  date?: string;
  messageId?: string | null;
  /** `Authentication-Results` values, in order. Omit for a passing DMARC. */
  authResults?: string[] | null;
  contentType?: string;
  transferEncoding?: string;
  body?: string;
  /** Extra headers below the standard ones. */
  trailingHeaders?: [string, string][];
}

/** Build an RFC 5322 message as bytes, with CRLF line endings like real mail. */
export function rawMessage(options: RawMessageOptions = {}): Uint8Array {
  const from = options.from ?? "alice@example.com";
  // The fixture's default verdict has to align with whatever `From:` says, so
  // the domain is taken from the addr-spec — display-name form included.
  const angled = /<([^<>]*)>/.exec(from);
  const spec = (angled ? angled[1]! : from).trim();
  const domain = spec.includes("@") ? spec.slice(spec.lastIndexOf("@") + 1) : "example.com";
  const auth =
    options.authResults === null
      ? []
      : (options.authResults ?? [
          `${AUTHSERV}; dkim=pass header.d=${domain}; spf=pass smtp.mailfrom=${spec}; dmarc=pass header.from=${domain}`,
        ]);

  const headers: [string, string][] = [
    ...(options.leadingHeaders ?? []),
    ...auth.map((value) => ["Authentication-Results", value] as [string, string]),
    ["From", from],
    ["To", options.to ?? `seyi@${APEX}`],
    ["Subject", options.subject ?? "Hello"],
    ["Date", options.date ?? "Tue, 26 Aug 2026 09:00:00 +0000"],
    ...(options.messageId === null
      ? []
      : ([["Message-ID", options.messageId ?? "<msg-1@example.com>"]] as [string, string][])),
    ["MIME-Version", "1.0"],
    ["Content-Type", options.contentType ?? 'text/plain; charset="utf-8"'],
    ...(options.transferEncoding
      ? ([["Content-Transfer-Encoding", options.transferEncoding]] as [string, string][])
      : []),
    ...(options.trailingHeaders ?? []),
  ];

  const head = headers.map(([name, value]) => `${name}: ${value}`).join("\r\n");
  const body = options.body ?? "Just checking in.";
  return new TextEncoder().encode(`${head}\r\n\r\n${body}`);
}

/** A `ReadableStream` over some bytes, chunked to exercise the drain loop. */
export function streamOf(bytes: Uint8Array, chunkSize = 64): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

/** An in-memory store with the two methods the Worker uses. */
export function memoryStore() {
  const objects = new Map<string, string | Uint8Array>();
  return {
    objects,
    async get(key: string) {
      if (!objects.has(key)) return null;
      const value = objects.get(key)!;
      return {
        async text() {
          return typeof value === "string" ? value : new TextDecoder().decode(value);
        },
      };
    },
    async put(key: string, value: string | Uint8Array) {
      objects.set(key, value);
      return { etag: `e${objects.size}` };
    },
  };
}
