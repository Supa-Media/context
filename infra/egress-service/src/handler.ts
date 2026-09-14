import { isAuthorized } from "./auth";

export interface EgressIngressEnv {
  EGRESS: { getByName(name: string): { fetch(request: Request): Promise<Response> } };
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
  return env.EGRESS.getByName("public-egress").fetch(internal);
}
