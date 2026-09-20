import { describe, expect, it, vi } from "vitest";
import { handleRequest } from "./handler";

describe("the public Worker door", () => {
  it("refuses an unauthenticated call before waking the container", async () => {
    const fetch = vi.fn();
    const response = await handleRequest(new Request("https://worker.invalid/request", { method: "POST" }), {
      EGRESS_SERVICE_SECRET: "test-secret",
      EGRESS: { getByName: () => ({ fetch }) },
    });
    expect(response.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("strips its own credential before forwarding to the container", async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.headers.has("authorization")).toBe(false);
      return Response.json({ ok: true });
    });
    const response = await handleRequest(new Request("https://worker.invalid/request", {
      method: "POST",
      headers: { authorization: "Bearer test-secret", "content-type": "application/json" },
      body: "{}",
    }), {
      EGRESS_SERVICE_SECRET: "test-secret",
      EGRESS: { getByName: () => ({ fetch }) },
    });
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
