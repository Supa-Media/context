/**
 * The browser's download step (./download.ts): press the download button,
 * take the file Browserbase kept or fetch the link in the page, never past
 * 10 MB and never from a link that is not https.
 *
 * Sabotage record (2026-10-22): letting `fetchable` take any address failed
 * "never fetches a link that is not https".
 */

import { describe, expect, it } from "vitest";
import { SNAPSHOT_SOURCE, parseBrowseRequest, runSteps, type BrowsePage } from "./browse";
import { takeDownload } from "./browserbase";
import { MAX_DOWNLOAD_BYTES, asFile, fileName, type Downloads } from "./download";

const PDF = btoa("%PDF-1.4 invoice");

/** A page whose element 3 is the invoice's download arrow, a link to `href`. */
function invoicePage({ href = "https://admin.example.com/billing/invoice.pdf", fetched = { name: "invoice.pdf", type: "application/pdf", data: PDF } as unknown } = {}) {
  const state = { clicks: [] as string[], fetches: [] as string[] };
  const page: BrowsePage = {
    async goto() {},
    async evaluate<T>(source: string) {
      if (source === SNAPSHOT_SOURCE) return { url: "https://admin.example.com/billing", title: "Billing", text: "September $25.26", elements: [] } as T;
      if (source.includes("location.hostname")) return { href: "https://admin.example.com/billing", host: "admin.example.com", origin: "https://admin.example.com" } as T;
      if (/^!!document\.querySelector/.test(source)) return true as T;
      if (source.includes('closest("a[href]")')) return href as T;
      if (source.includes('credentials: "include"')) {
        state.fetches.push(source);
        return fetched as T;
      }
      return undefined as T;
    },
    async click(selector) {
      state.clicks.push(selector);
    },
    async type() {},
    async select() {
      return [];
    },
    async goBack() {},
    keyboard: { async press() {} },
    mouse: { async click() {} },
    async screenshot() {
      return "";
    },
    async waitForNetworkIdle() {},
  };
  return { page, state };
}

describe("the download step", () => {
  it("reads by number, by words, or with neither for the page itself", () => {
    expect(parseBrowseRequest({ steps: [{ do: "download", ref: 3 }] })?.steps[0]).toEqual({ do: "download", ref: 3, text: null });
    expect(parseBrowseRequest({ steps: [{ do: "download", text: " Download " }] })?.steps[0]).toEqual({ do: "download", ref: null, text: "Download" });
    expect(parseBrowseRequest({ steps: [{ do: "download" }] })?.steps[0]).toEqual({ do: "download", ref: null, text: null });
    expect(parseBrowseRequest({ steps: [{ do: "download", text: "" }] })).toBeNull();
    expect(parseBrowseRequest({ steps: [{ do: "download", text: "x".repeat(201) }] })).toBeNull();
  });

  it("presses the element and takes the file the browser downloaded, leaving later steps for the next call", async () => {
    const { page, state } = invoicePage();
    const asked: number[] = [];
    const downloads: Downloads = {
      async take(since) {
        asked.push(since);
        return { name: "Invoice-Sept.pdf", type: "application/pdf", size: 16, data: PDF };
      },
    };
    const result = await runSteps(page, [{ do: "download", ref: 3, text: null }, { do: "scroll", direction: "down", x: null, y: null }], { downloads });
    expect(state.clicks).toEqual(['[data-tex-ref="3"]']);
    expect(result.file).toEqual({ name: "Invoice-Sept.pdf", type: "application/pdf", size: 16, data: PDF });
    expect(result.ran).toEqual([{ do: "download", ok: true }]);
    // The file is never in a step's result, only beside the reading.
    expect(JSON.stringify(result.ran)).not.toContain(PDF);
    expect(state.fetches).toEqual([]);
    expect(asked).toHaveLength(1);
  });

  it("fetches the link in the page when the browser keeps no downloads (Cloudflare's)", async () => {
    const { page, state } = invoicePage();
    const result = await runSteps(page, [{ do: "download", ref: 3, text: null }]);
    expect(state.fetches).toHaveLength(1);
    expect(state.fetches[0]).toContain("https://admin.example.com/billing/invoice.pdf");
    expect(result.file).toMatchObject({ name: "invoice.pdf", type: "application/pdf", data: PDF });
  });

  it("says so when the link opens a web page rather than a file", async () => {
    const { page } = invoicePage({ fetched: "page" });
    const result = await runSteps(page, [{ do: "download", ref: 3, text: null }]);
    expect(result.file).toBeUndefined();
    expect(result.ran[0]).toMatchObject({ do: "download", ok: false });
    expect(result.ran[0]!.reason).toMatch(/web page, not a file/);
  });

  it("never fetches a link that is not https", async () => {
    const { page, state } = invoicePage({ href: "http://10.0.0.1/secret.pdf" });
    const result = await runSteps(page, [{ do: "download", ref: 3, text: null }]);
    expect(state.fetches).toEqual([]);
    expect(result.ran[0]!.ok).toBe(false);
  });

  it("passes on a refusal from the browser's downloads instead of fetching", async () => {
    const { page, state } = invoicePage();
    const downloads: Downloads = { take: async () => ({ refused: "that file is over the 10 MB a file can be" }) };
    const result = await runSteps(page, [{ do: "download", ref: 3, text: null }], { downloads });
    expect(state.fetches).toEqual([]);
    expect(result.ran[0]).toEqual({ do: "download", ok: false, reason: "that file is over the 10 MB a file can be" });
  });
});

describe("a file leaving the Worker", () => {
  it("keeps only a plain name, a real type and a size within the limit", () => {
    expect(fileName("../../etc/pass\u202ewd.pdf")).toBe("passwd.pdf");
    expect(fileName("")).toBe("download");
    expect(asFile({ name: "a.pdf", type: "application/pdf; charset=binary", data: PDF })).toMatchObject({ type: "application/pdf", size: 16 });
    expect(asFile({ name: "a.pdf", type: "<script>", data: PDF })?.type).toBe("application/octet-stream");
    expect(asFile({ name: "a.pdf", data: "not base64!" })).toBeNull();
    expect(asFile({ name: "a.pdf", data: "A".repeat(Math.ceil((MAX_DOWNLOAD_BYTES * 4) / 3) + 8) })).toBeNull();
  });
});

describe("Browserbase's downloads", () => {
  const env = { BROWSERBASE_API_KEY: "bb_test", BROWSERBASE_PROJECT_ID: "proj" };

  function vendor(listings: Array<Array<Record<string, unknown>>>) {
    const calls: Array<{ method: string; url: string }> = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url });
      if (url.includes("/downloads?")) return new Response(JSON.stringify({ downloads: listings.shift() ?? [] }));
      if (method === "DELETE") return new Response(null, { status: 204 });
      return new Response(new TextEncoder().encode("%PDF-1.4 invoice"));
    }) as unknown as typeof fetch;
    return { calls, fetcher };
  }

  it("waits for the file to arrive, takes the newest, and removes it from Browserbase", async () => {
    const since = Date.parse("2026-10-22T15:00:00Z");
    const { calls, fetcher } = vendor([
      [],
      [
        { id: "old", filename: "old.pdf", mimeType: "application/pdf", size: 9, createdAt: "2026-10-22T14:00:00Z" },
        { id: "dl-1", filename: "invoice.pdf", mimeType: "application/pdf", size: 16, createdAt: "2026-10-22T15:00:02Z" },
      ],
    ]);
    const got = await takeDownload(env, "sess-1", since, 5_000, MAX_DOWNLOAD_BYTES, fetcher, 1);
    expect(got).toEqual({ name: "invoice.pdf", type: "application/pdf", size: 16, data: PDF });
    expect(calls.filter((c) => c.url.includes("/downloads?"))).toHaveLength(2);
    expect(calls[0]!.url).toContain("sessionId=sess-1");
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/downloads/dl-1"))).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/downloads/old"))).toBe(false);
  });

  it("refuses a file over the limit without fetching it", async () => {
    const { calls, fetcher } = vendor([[{ id: "big", filename: "big.zip", size: MAX_DOWNLOAD_BYTES + 1, createdAt: new Date().toISOString() }]]);
    const got = await takeDownload(env, "sess-1", Date.now() - 1_000, 0, MAX_DOWNLOAD_BYTES, fetcher, 1);
    expect(got).toEqual({ refused: "that file is over the 10 MB a file can be" });
    expect(calls.some((c) => c.method === "GET" && c.url.endsWith("/downloads/big"))).toBe(false);
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("answers null when nothing came in time", async () => {
    const { fetcher } = vendor([[], [], []]);
    expect(await takeDownload(env, "sess-1", Date.now(), 0, MAX_DOWNLOAD_BYTES, fetcher, 1)).toBeNull();
  });
});
