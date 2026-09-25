import { Platform } from "react-native";

/**
 * Is this page being served at a customer's domain?
 *
 * The same rule as the router's `isPlatformHost` (`infra/router/src/site.ts`),
 * restated because the two packages cannot share a module: our own hosts are
 * `context.lc` and everything under it, a `workers.dev` or `expo.app` preview,
 * and local development. Anything else reached this bundle through a
 * customer's domain, and gets the site rather than the app.
 *
 * Web only. Native apps have no host.
 */
export function siteHostname(): string | null {
  if (Platform.OS !== "web" || typeof window === "undefined") return null;
  const host = window.location.hostname.toLowerCase();
  if (isPlatformHost(host)) return null;
  return host;
}

export function isPlatformHost(host: string): boolean {
  return (
    host === "context.lc" ||
    host.endsWith(".context.lc") ||
    host.endsWith(".workers.dev") ||
    host.endsWith(".expo.app") ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === ""
  );
}

/**
 * Where sign-in and the console live. A customer's domain never hosts either:
 * a session minted on their origin would sit in storage that origin's next
 * owner could read.
 */
export const PLATFORM_ORIGIN =
  process.env.EXPO_PUBLIC_APP_ORIGIN ?? "https://context.lc";

/** `/intake` → `intake`; `/` → `""`; anything else → `null`. */
export function siteSlugFrom(pathname: string): string | null {
  if (pathname === "/" || pathname === "") return "";
  const segment = pathname.replace(/^\//, "").replace(/\/$/, "");
  return /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(segment)
    ? segment
    : null;
}

/** Decode one canonical website route without accepting ambiguous separators. */
export function siteRoutePathFrom(pathname: string): string | null {
  if (pathname.length > 3072 || /%(?:2f|5c)/i.test(pathname)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname || "/");
  } catch {
    return null;
  }
  const hasControlOrBackslash = [...decoded].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 || character === "\\";
  });
  if (
    !decoded.startsWith("/") ||
    decoded.length > 1024 ||
    hasControlOrBackslash ||
    /[?#%]/.test(decoded)
  ) {
    return null;
  }
  const routePath = decoded === "/" ? decoded : decoded.replace(/\/+$/, "");
  if (routePath === "/") return routePath;
  const segments = routePath.slice(1).split("/");
  return segments.some(
    (segment) =>
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.startsWith("."),
  )
    ? null
    : routePath.normalize("NFC");
}
