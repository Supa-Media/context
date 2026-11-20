import { describe, expect, it } from "vitest";
import worker, { type Env } from "./index";

/** An env that records every binding a request touched: a plain-HTTP request must touch none. */
function watchedEnv(): { env: Env; touched: string[] } {
  const touched: string[] = [];
  const values: Record<string, unknown> = {
    LINQ_WEBHOOK_SECRET: "whsec_c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmU=",
    SENDBLUE_WEBHOOK_SECRET: "a-sendblue-secret-of-some-length",
    WHAPI_WEBHOOK_SECRET: "a-whapi-secret-of-some-length",
    AGENT_WORKER_SECRET: "s",
    CONTROL_PLANE_ORIGIN: "https://cp.example",
    GATEWAY_ORIGIN: "https://gw.example",
  };
  const env = new Proxy(values, {
    get(target, key) {
      touched.push(String(key));
      return target[key as string];
    },
  }) as unknown as Env;
  return { env, touched };
}

/** A POST whose body records whether anything read it. */
function watchedPost(url: string, headers: Record<string, string> = {}): { request: Request; bodyRead: () => boolean } {
  let read = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      read = true;
      controller.enqueue(new TextEncoder().encode('{"event_type":"message.received"}'));
      controller.close();
    },
  }, { highWaterMark: 0 });
  const request = new Request(url, { method: "POST", headers, body, duplex: "half" } as RequestInit);
  return { request, bodyRead: () => read };
}

describe("plain HTTP never reaches a route", () => {
  for (const path of ["/linq", "/sendblue", "/whapi", "/new-line"]) {
    it(`refuses a plain-HTTP POST to ${path} before reading a header, a secret or the body`, async () => {
      const { env, touched } = watchedEnv();
      const { request, bodyRead } = watchedPost(`http://context-agent.example.workers.dev${path}`, {
        "sb-signing-secret": "a-sendblue-secret-of-some-length",
        "x-tex-webhook-secret": "a-whapi-secret-of-some-length",
      });
      const response = await worker.fetch(request, env);
      expect(response.status).toBe(403);
      expect(response.headers.get("Location")).toBeNull();
      expect(bodyRead()).toBe(false);
      expect(touched).toEqual([]);
    });
  }

  it("redirects a plain-HTTP HEAD on a webhook path to the same path on HTTPS", async () => {
    const { env, touched } = watchedEnv();
    const response = await worker.fetch(new Request("http://context-agent.example.workers.dev/linq", { method: "HEAD" }), env);
    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe("https://context-agent.example.workers.dev/linq");
    expect(touched).toEqual([]);
  });

  it("redirects a plain-HTTP GET keeping the path and query, and drops an explicit HTTP port", async () => {
    const { env } = watchedEnv();
    const response = await worker.fetch(new Request("http://agent.example:80/media/abc?x=1"), env);
    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe("https://agent.example/media/abc?x=1");
    const health = await worker.fetch(new Request("http://agent.example:8080/health"), env);
    expect(health.headers.get("Location")).toBe("https://agent.example/health");
  });

  it("leaves HTTPS alone: a HEAD on a webhook path still gets the route's own 405", async () => {
    const { env } = watchedEnv();
    for (const path of ["/linq", "/sendblue", "/whapi"]) {
      const response = await worker.fetch(new Request(`https://agent.example${path}`, { method: "HEAD" }), env);
      expect(response.status).toBe(405);
    }
  });

  it("serves loopback over plain HTTP, so wrangler dev keeps working", async () => {
    const { env } = watchedEnv();
    for (const origin of ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"]) {
      const response = await worker.fetch(new Request(`${origin}/health`), env);
      expect(response.status).toBe(200);
      expect(((await response.json()) as { ok: boolean }).ok).toBe(true);
    }
  });

  it("does not take a hostname that merely starts with localhost for loopback", async () => {
    const { env } = watchedEnv();
    for (const host of ["localhost.example", "127.0.0.1.example", "localhost.workers.dev"]) {
      const response = await worker.fetch(new Request(`http://${host}/health`), env);
      expect(response.status).toBe(308);
    }
  });
});
