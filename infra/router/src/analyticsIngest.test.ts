import { describe, expect, it } from "vitest";
import { ingestResponse, ingestTarget } from "./analyticsIngest";
import { route } from "./route";

/**
 * `/ingest/*`: the app's analytics on their way to PostHog through our own
 * address. Same origin means our session cookie rides along with every event,
 * so what is forwarded is the thing to prove, not merely that it arrives.
 */

function capture() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json", "Set-Cookie": "ph_session=abc; Domain=context.lc" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("which requests are analytics", () => {
  it("routes /ingest to PostHog's API and /ingest/static to its scripts", () => {
    expect(ingestTarget(new URL("https://context.lc/ingest/e/?ip=0&ver=1"))).toBe("https://us.i.posthog.com/e/?ip=0&ver=1");
    expect(ingestTarget(new URL("https://tex.lc/ingest/static/recorder.js?v=1"))).toBe(
      "https://us-assets.i.posthog.com/static/recorder.js?v=1",
    );
    expect(ingestTarget(new URL("https://context.lc/ingest/array/phc_x/config.js"))).toBe(
      "https://us-assets.i.posthog.com/array/phc_x/config.js",
    );
    expect(ingestTarget(new URL("https://context.lc/ingest"))).toBe("https://us.i.posthog.com/");
  });

  it("only the prefix itself, never a page that starts with the same letters", () => {
    expect(ingestTarget(new URL("https://context.lc/ingestion"))).toBeNull();
    expect(ingestTarget(new URL("https://context.lc/console/ingest"))).toBeNull();
    expect(route(new URL("https://context.lc/ingestion")).kind).toBe("proxy");
  });

  it("the request cannot pick another host", () => {
    for (const path of ["/ingest//evil.example/e/", "/ingest/@evil.example/e/", "/ingest/..%2F..%2Fevil"]) {
      expect(new URL(ingestTarget(new URL(`https://context.lc${path}`))!).host).toBe("us.i.posthog.com");
    }
  });

  it("is routed ahead of the crawler branch, so a bot's beacon is not answered with a card", () => {
    const decision = route(new URL("https://context.lc/ingest/e/"), "Googlebot/2.1");
    expect(decision).toEqual({ kind: "ingest", target: "https://us.i.posthog.com/e/" });
  });
});

describe("what is forwarded", () => {
  it("never our cookie, a credential or the visitor's address", async () => {
    const { calls, fetchImpl } = capture();
    const request = new Request("https://context.lc/ingest/e/", {
      method: "POST",
      body: '{"event":"$screen"}',
      headers: {
        "Content-Type": "text/plain",
        "User-Agent": "Mozilla/5.0",
        Cookie: "__convexAuthJWT=secret-session",
        Authorization: "Bearer secret-token",
        "CF-Connecting-IP": "203.0.113.9",
        "X-Forwarded-For": "203.0.113.9",
        "X-Real-IP": "203.0.113.9",
      },
    });
    await ingestResponse(request, "https://us.i.posthog.com/e/", fetchImpl);
    const sent = new Headers(calls[0].init.headers);
    expect(sent.get("cookie")).toBeNull();
    expect(sent.get("authorization")).toBeNull();
    expect(sent.get("cf-connecting-ip")).toBeNull();
    expect(sent.get("x-forwarded-for")).toBeNull();
    expect(sent.get("x-real-ip")).toBeNull();
    // Anti-vacuity: the headers PostHog needs do go.
    expect(sent.get("content-type")).toBe("text/plain");
    expect(sent.get("user-agent")).toBe("Mozilla/5.0");
    expect(calls[0].init.method).toBe("POST");
  });

  it("PostHog cannot set a cookie on our origin", async () => {
    const { fetchImpl } = capture();
    const response = await ingestResponse(new Request("https://context.lc/ingest/e/", { method: "POST", body: "{}" }), "https://us.i.posthog.com/e/", fetchImpl);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.status).toBe(200);
  });

  it("only the methods the SDK uses", async () => {
    const { calls, fetchImpl } = capture();
    const response = await ingestResponse(new Request("https://context.lc/ingest/e/", { method: "DELETE" }), "https://us.i.posthog.com/e/", fetchImpl);
    expect(response.status).toBe(405);
    expect(calls).toHaveLength(0);
  });

  it("a PostHog outage is a quiet 502, never a thrown error", async () => {
    const fetchImpl = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    const response = await ingestResponse(new Request("https://context.lc/ingest/e/", { method: "POST", body: "{}" }), "https://us.i.posthog.com/e/", fetchImpl);
    expect(response.status).toBe(502);
  });
});

/**
 * CASA 6.3.1 (2026-11-11): PostHog reflects any origin, so passing its CORS
 * headers through let any site read these answers, with no `Vary: Origin`.
 */
describe("who may read an analytics answer from another origin", () => {
  function permissive() {
    const fetchImpl = (async () =>
      new Response("x", {
        status: 200,
        headers: {
          "Content-Type": "application/javascript",
          "Access-Control-Allow-Origin": "https://evil.example",
          "Access-Control-Allow-Credentials": "true",
        },
      })) as unknown as typeof fetch;
    return fetchImpl;
  }
  const scriptUrl = "https://context.lc/ingest/static/array.js";
  const target = "https://us-assets.i.posthog.com/static/array.js";

  it("names no other origin, whatever PostHog says, and always varies on Origin", async () => {
    const request = new Request(scriptUrl, { headers: { Origin: "https://evil.example" } });
    const response = await ingestResponse(request, target, permissive());
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("vary")).toMatch(/\bOrigin\b/);
  });

  it("allows only the origin the request was sent to", async () => {
    const own = await ingestResponse(new Request(scriptUrl, { headers: { Origin: "https://context.lc" } }), target, permissive());
    expect(own.headers.get("access-control-allow-origin")).toBe("https://context.lc");
    const tex = await ingestResponse(
      new Request("https://tex.lc/ingest/static/array.js", { headers: { Origin: "https://context.lc" } }),
      target,
      permissive(),
    );
    expect(tex.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("varies on Origin with no Origin header too, so a cache cannot reuse it", async () => {
    const response = await ingestResponse(new Request(scriptUrl), target, permissive());
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("vary")).toMatch(/\bOrigin\b/);
  });

  it("answers a preflight itself, and only its own origin gets a yes", async () => {
    let forwarded = false;
    const fetchImpl = (async () => {
      forwarded = true;
      return new Response(null, { status: 200, headers: { "Access-Control-Allow-Origin": "*" } });
    }) as unknown as typeof fetch;
    const foreign = await ingestResponse(
      new Request("https://context.lc/ingest/e/", { method: "OPTIONS", headers: { Origin: "https://evil.example" } }),
      "https://us.i.posthog.com/e/",
      fetchImpl,
    );
    expect(foreign.status).toBe(204);
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
    const own = await ingestResponse(
      new Request("https://context.lc/ingest/e/", { method: "OPTIONS", headers: { Origin: "https://context.lc" } }),
      "https://us.i.posthog.com/e/",
      fetchImpl,
    );
    expect(own.headers.get("access-control-allow-origin")).toBe("https://context.lc");
    expect(forwarded).toBe(false);
  });
});
