/**
 * Staging only: hand /texts-simulator to the texting assistant's simulator
 * (apps/agent/src/simulator.ts), so it opens at the staging app's own address.
 *
 * The `TEXTS_SIMULATOR` service binding exists only in the staging
 * environment's wrangler config. Without it, which is production, this
 * forwards nothing and the path falls through to the app like any other.
 * The request goes on without the visitor's cookies or Authorization header:
 * the simulator has no use for a Context session, so it is never handed one.
 */
export const TEXTS_SIMULATOR_PATH = "/texts-simulator";

export function isTextsSimulatorPath(pathname: string): boolean {
  return pathname === TEXTS_SIMULATOR_PATH || pathname.startsWith(`${TEXTS_SIMULATOR_PATH}/`);
}

export function textsSimulatorResponse(
  request: Request,
  url: URL,
  env: { TEXTS_SIMULATOR?: Fetcher },
): Promise<Response> | null {
  if (env.TEXTS_SIMULATOR === undefined || !isTextsSimulatorPath(url.pathname)) return null;
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  headers.delete("authorization");
  return env.TEXTS_SIMULATOR.fetch(new Request(request, { headers }));
}
