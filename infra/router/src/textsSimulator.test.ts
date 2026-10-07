import { describe, expect, it } from "vitest";
import worker from "./index";

const CTX = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function binding() {
  const seen: Request[] = [];
  const fetcher = {
    fetch: async (request: Request) => {
      seen.push(request);
      return new Response("simulator", { status: 200 });
    },
  } as unknown as Fetcher;
  return { seen, fetcher };
}

describe("texts simulator route", () => {
  it("forwards /texts-simulator to the staging assistant, without the visitor's session", async () => {
    const { seen, fetcher } = binding();
    const request = new Request("https://staging.context.lc/texts-simulator/api/send", {
      method: "POST",
      headers: { cookie: "session=secret", authorization: "Bearer secret", "x-simulator-key": "abc" },
      body: "{}",
    });
    const response = await worker.fetch(request, { TEXTS_SIMULATOR: fetcher }, CTX);
    expect(await response.text()).toBe("simulator");
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0].url).pathname).toBe("/texts-simulator/api/send");
    expect(seen[0].headers.get("cookie")).toBeNull();
    expect(seen[0].headers.get("authorization")).toBeNull();
    expect(seen[0].headers.get("x-simulator-key")).toBe("abc");
  });

  it("leaves neighbouring paths alone", async () => {
    const { seen, fetcher } = binding();
    const assets = { fetch: async () => new Response("app") } as unknown as Fetcher;
    for (const path of ["/texts-simulatorx", "/texts/abc123", "/"]) {
      await worker.fetch(new Request(`https://staging.context.lc${path}`), { TEXTS_SIMULATOR: fetcher, ASSETS: assets }, CTX);
    }
    expect(seen).toHaveLength(0);
  });

  it("forwards nothing where there is no binding, which is production", async () => {
    const assets = { fetch: async () => new Response("app") } as unknown as Fetcher;
    const response = await worker.fetch(new Request("https://context.lc/texts-simulator"), { ASSETS: assets }, CTX);
    expect(await response.text()).not.toBe("simulator");
  });
});
