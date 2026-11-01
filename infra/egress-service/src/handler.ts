import { isAuthorized } from "./auth";

export interface EgressIngressEnv {
  EGRESS: { getByName(name: string, options?: { locationHint?: "enam" }): { fetch(request: Request): Promise<Response> } };
  EGRESS_SERVICE_SECRET?: string;
}

export async function handleRequest(request: Request, env: EgressIngressEnv): Promise<Response> {
  if (!await isAuthorized(request.headers.get("authorization"), env.EGRESS_SERVICE_SECRET)) {
    return new Response(null, { status: 401 });
  }
  const url = new URL(request.url);
  if (!((request.method === "GET" && url.pathname === "/health") ||
    (request.method === "POST" && url.pathname === "/request"))) {
    return new Response(null, { status: 404 });
  }
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  const internal = new Request(`http://container${url.pathname}`, {
    method: request.method,
    headers,
    body: request.method === "POST" ? await request.arrayBuffer() : undefined,
  });
  // Placed in eastern North America like every object of ours (decided by the owner, 2026-11-01).
  return env.EGRESS.getByName("public-egress", { locationHint: "enam" }).fetch(internal);
}
