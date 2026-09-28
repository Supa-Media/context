import type { Upstream } from "./route";

type UpstreamEnv = {
  EXPO_ORIGIN?: string;
  CONVEX_ORIGIN?: string;
};

/** Accept a variable only when it is a bare HTTPS origin. */
export function readOrigin(value: string | undefined): string | null {
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
  return parsed.origin;
}

/** Resolve only the requested upstream, so one missing origin cannot break the other. */
export function originFor(upstream: Upstream, env: UpstreamEnv): string | null {
  return upstream === "convex"
    ? readOrigin(env.CONVEX_ORIGIN)
    : readOrigin(env.EXPO_ORIGIN);
}

export const VAR_NAME: Record<Upstream, string> = {
  expo: "EXPO_ORIGIN",
  convex: "CONVEX_ORIGIN",
};
