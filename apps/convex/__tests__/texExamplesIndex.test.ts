/**
 * Tex's example index (`functions/texExamplesIndex.ts`): the index is never a
 * workspace's, and the sync sends only Training moments, with failures that
 * carry a code and nothing of the provider's words.
 */

import { describe, expect, test } from "vitest";
import { TEX_EXAMPLES_INDEX, indexEntries } from "@context/shared/src/texExamples.cjs";
import GENERATED from "../../../packages/shared/src/texTraining.generated.json";
import { meaningIndexNameFor } from "../functions/lib/vectorize";
import { syncTexExamples } from "../functions/texExamplesIndex";

const ACCOUNT = "test-account-not-real";
const TOKEN = "test-token-not-real";
const DIMENSIONS = 1024;

type Call = { method: string; url: string; body: string };

/** A fake Cloudflare: records every call and answers each route the sync uses. */
function fakeCloudflare(options: { createStatus?: number; upsertStatus?: number } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ method, url, body });
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    if (url.includes("/ai/run/")) {
      const texts = (JSON.parse(body) as { text: string[] }).text;
      return json(200, { success: true, result: { data: texts.map(() => new Array(DIMENSIONS).fill(0.5)) } });
    }
    if (url.endsWith("/vectorize/v2/indexes") && method === "POST") {
      if (options.createStatus) {
        return json(options.createStatus, {
          success: false,
          errors: [{ code: 4001, message: `index exists for ${ACCOUNT} ${TOKEN}` }],
        });
      }
      return json(200, { success: true, result: { name: TEX_EXAMPLES_INDEX } });
    }
    if (url.endsWith(`/indexes/${TEX_EXAMPLES_INDEX}`) && method === "GET") {
      return json(200, { success: true, result: { name: TEX_EXAMPLES_INDEX } });
    }
    if (url.endsWith(`/indexes/${TEX_EXAMPLES_INDEX}/upsert`)) {
      if (options.upsertStatus) {
        return json(options.upsertStatus, { success: false, errors: [{ code: 500, message: "upstream text" }] });
      }
      return json(200, { success: true, result: { mutationId: "m1" } });
    }
    return json(404, { success: false, errors: [{ code: 7000, message: "no route" }] });
  }) as typeof globalThis.fetch;
  return { calls, fetchImpl };
}

function upsertedIds(calls: Call[]): string[] {
  const upsert = calls.find((call) => call.url.endsWith("/upsert"));
  if (!upsert) return [];
  return upsert.body
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => (JSON.parse(line) as { id: string }).id);
}

describe("tex examples index", () => {
  test("the index is Tex's own: no workspace prefix, and no workspace name can produce it", () => {
    expect(TEX_EXAMPLES_INDEX.startsWith("context-meaning-")).toBe(false);
    for (const workspaceId of ["jd7abc0000000000000000001", "k2x9q0000000000000000000"]) {
      expect(meaningIndexNameFor(workspaceId)).not.toBe(TEX_EXAMPLES_INDEX);
    }
  });

  test("sync creates the index at 1,024 cosine dimensions and upserts exactly the Training moments", async () => {
    const { calls, fetchImpl } = fakeCloudflare();
    const result = await syncTexExamples({ accountId: ACCOUNT, apiToken: TOKEN, fetchImpl }, GENERATED);
    const entries = indexEntries(GENERATED);
    expect(result).toEqual({ status: "synced", count: entries.length });

    const create = calls.find((call) => call.method === "POST" && call.url.endsWith("/vectorize/v2/indexes"));
    expect(JSON.parse(create?.body ?? "{}")).toMatchObject({
      name: TEX_EXAMPLES_INDEX,
      config: { dimensions: DIMENSIONS, metric: "cosine" },
    });

    const ids = upsertedIds(calls);
    expect(ids.length).toBe(entries.length);
    expect(new Set(ids)).toEqual(new Set(entries.map((entry) => entry.id)));
    const moments = new Set((GENERATED.nodes.fd as { chat: string; at: number }[]).map((m) => `${m.chat}#${m.at}`));
    for (const id of ids) expect(moments.has(id)).toBe(true);
  });

  test("an index that already exists is adopted, and the sync still upserts", async () => {
    const { calls, fetchImpl } = fakeCloudflare({ createStatus: 409 });
    const result = await syncTexExamples({ accountId: ACCOUNT, apiToken: TOKEN, fetchImpl }, GENERATED);
    expect(result.status).toBe("synced");
    expect(calls.some((call) => call.method === "GET" && call.url.endsWith(`/indexes/${TEX_EXAMPLES_INDEX}`))).toBe(true);
  });

  test("without a credential nothing is sent and the sync says not configured", async () => {
    const { calls, fetchImpl } = fakeCloudflare();
    const result = await syncTexExamples({ accountId: ACCOUNT, apiToken: "", fetchImpl }, GENERATED);
    expect(result).toEqual({ status: "not configured" });
    expect(calls).toHaveLength(0);
  });

  test("a failed upsert reports its code only, never Cloudflare's words or the credential", async () => {
    const { fetchImpl } = fakeCloudflare({ upsertStatus: 500 });
    const result = await syncTexExamples({ accountId: ACCOUNT, apiToken: TOKEN, fetchImpl }, GENERATED);
    expect(result).toEqual({ status: "failed", code: "UNAVAILABLE" });
    const text = JSON.stringify(result);
    expect(text).not.toContain("upstream text");
    expect(text).not.toContain(TOKEN);
  });
});
